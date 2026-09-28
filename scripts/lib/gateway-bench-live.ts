import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { GatewayRpc } from "./gateway-bench-probes.ts";

export const LIVE_GATEWAY_MODEL_ID = "gpt-5.4-2026-03-05";
export const LIVE_GATEWAY_MODEL = `openai/${LIVE_GATEWAY_MODEL_ID}`;

export function redactLiveBenchmarkText(text: string): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? text.replaceAll(key, "[REDACTED]") : text;
}

export function configureLiveGatewayBenchmark(
  config: Record<string, unknown>,
  root: string,
  concurrency: number,
): void {
  config.models = {
    mode: "merge",
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        api: "openai-responses",
        agentRuntime: { id: "openclaw" },
        models: [
          {
            id: LIVE_GATEWAY_MODEL_ID,
            name: "Live benchmark model",
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 128,
          },
        ],
      },
    },
  };
  config.agents = {
    defaults: {
      workspace: path.join(root, "workspace"),
      maxConcurrent: concurrency,
      model: { primary: LIVE_GATEWAY_MODEL },
      utilityModel: LIVE_GATEWAY_MODEL,
      thinkingDefault: "off",
      heartbeat: { every: "0m" },
      models: {
        [LIVE_GATEWAY_MODEL]: {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false, maxTokens: 128 },
        },
      },
    },
  };
  config.tools = { deny: ["*"] };
}

function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((part: unknown) =>
      isRecord(part) && (part.type === "text" || part.type === "output_text")
        ? [typeof part.text === "string" ? part.text : ""]
        : [],
    )
    .join("");
}

type LiveTurn = {
  sessionKey: string;
  agentId: string;
  expected: string;
  accepted: boolean;
  streamedText: string;
  finalText: string;
  finalEvents: number;
  errors: number;
  sessionId?: string;
  turnId?: string;
  historyMatches: number;
};

/** Per-run evidence only. No response bodies or credentials enter the returned proof. */
export function createLiveGatewayEvidence(agentIds: string[], turnsPerSession: number) {
  const turns = new Map<string, LiveTurn>();
  const turnIds = new Set<string>();
  const indices = new Set<number>();
  const expectedTurns = agentIds.length * turnsPerSession;
  let invalidEvents = false;
  const need = (condition: unknown, message: string): void => {
    if (!condition) {
      throw new Error(message);
    }
  };
  const identity = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 256;

  return {
    snapshot() {
      return {
        requestedTurns: expectedTurns,
        invalidEvents,
        turns: [...turns].map(([runId, turn]) => ({
          runId,
          agentId: turn.agentId,
          accepted: turn.accepted,
          terminalVerified: Boolean(turn.turnId),
          streamMatches: turn.streamedText.trim() === turn.expected,
          finalMatches: turn.finalText.trim() === turn.expected,
          finalEvents: turn.finalEvents,
          errors: turn.errors,
          historyMatches: turn.historyMatches,
        })),
      };
    },
    async verifyConfiguration(rpc: GatewayRpc) {
      const roster = await rpc<{ agents: Array<{ id: string }> }>("agents.list", {});
      need(
        roster.agents.length === agentIds.length &&
          agentIds.every((id) => roster.agents.some((agent) => agent.id === id)),
        "Live agent roster mismatch",
      );
      const result = await rpc<{
        config: {
          agents?: {
            defaults?: {
              model?: { primary?: string };
              utilityModel?: string;
              maxConcurrent?: number;
              thinkingDefault?: string;
              heartbeat?: { every?: string };
              models?: Record<string, { params?: { maxTokens?: number } }>;
            };
            entries?: Record<string, { model?: unknown }>;
          };
          plugins?: { entries?: Record<string, { config?: { dreaming?: { enabled?: boolean } } }> };
          tools?: { deny?: string[] };
        };
      }>("config.get", {});
      const config = result.config;
      const defaults = config.agents?.defaults;
      const entries = config.agents?.entries;
      need(
        config.plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled === false &&
          defaults?.model?.primary === LIVE_GATEWAY_MODEL &&
          defaults.utilityModel === LIVE_GATEWAY_MODEL &&
          defaults.maxConcurrent === agentIds.length &&
          defaults.thinkingDefault === "off" &&
          defaults.heartbeat?.every === "0m" &&
          defaults.models?.[LIVE_GATEWAY_MODEL]?.params?.maxTokens === 128 &&
          config.tools?.deny?.length === 1 &&
          config.tools.deny[0] === "*" &&
          entries &&
          Object.keys(entries).length === agentIds.length &&
          agentIds.every(
            (id) =>
              Object.hasOwn(entries, id) && entries[id] && !Object.hasOwn(entries[id], "model"),
          ),
        "Live model, roster, token cap, or fixture configuration mismatch",
      );
      const heartbeat = await rpc<{ ok: boolean; enabled: boolean }>("set-heartbeats", {
        enabled: false,
      });
      need(heartbeat.ok && !heartbeat.enabled, "Live heartbeat disable failed");
    },
    register(runId: string, sessionKey: string, index: number): string {
      const agentId = sessionKey.split(":")[1] ?? "";
      need(
        agentIds.includes(agentId) &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < expectedTurns &&
          !indices.has(index) &&
          !turns.has(runId),
        "Unexpected or duplicate live turn",
      );
      indices.add(index);
      const expected = `LIVE_GATEWAY_OK_${index + 1}`;
      turns.set(runId, {
        sessionKey,
        agentId,
        expected,
        accepted: false,
        streamedText: "",
        finalText: "",
        finalEvents: 0,
        errors: 0,
        historyMatches: 0,
      });
      return `Reply with exactly ${expected} and no other text. Do not call tools.`;
    },
    accept(runId: string, started: { runId?: string; status?: string }) {
      const turn = turns.get(runId);
      need(
        turn &&
          !turn.accepted &&
          (started.runId === undefined || started.runId === runId) &&
          (started.status === "accepted" || started.status === "ok"),
        "Live turn acceptance mismatch",
      );
      if (turn) {
        turn.accepted = true;
      }
    },
    complete(runId: string, completed: unknown) {
      const turn = turns.get(runId);
      const result = isRecord(completed) ? completed : {};
      const receipt = isRecord(result.terminalReceipt) ? result.terminalReceipt : {};
      const requested = isRecord(receipt.requested) ? receipt.requested : {};
      const effective = isRecord(receipt.effective) ? receipt.effective : {};
      const reply = isRecord(result.terminalReply) ? result.terminalReply : {};
      need(
        turn &&
          turn.accepted &&
          !turn.turnId &&
          result.status === "ok" &&
          result.runId === runId &&
          !result.error &&
          !result.pendingError &&
          !result.yielded &&
          receipt.runId === runId &&
          identity(receipt.sessionId) &&
          identity(receipt.turnId) &&
          !turnIds.has(receipt.turnId) &&
          receipt.rerouted === false &&
          receipt.terminalDisposition === "visible" &&
          requested.provider === "openai" &&
          requested.model === LIVE_GATEWAY_MODEL_ID &&
          effective.provider === "openai" &&
          effective.model === LIVE_GATEWAY_MODEL_ID &&
          effective.responseModel === LIVE_GATEWAY_MODEL_ID &&
          Array.isArray(receipt.successfulToolNames) &&
          receipt.successfulToolNames.length === 0 &&
          reply.disposition === "visible" &&
          typeof reply.text === "string" &&
          reply.text.trim() === turn.expected,
        "Live terminal identity, model, or response mismatch",
      );
      if (turn && identity(receipt.sessionId) && identity(receipt.turnId)) {
        turn.sessionId = receipt.sessionId;
        turn.turnId = receipt.turnId;
        turnIds.add(receipt.turnId);
      }
    },
    onEvent(event: { event: string; payload?: unknown }) {
      const payload = event.payload;
      if (!isRecord(payload) || typeof payload.runId !== "string") {
        return;
      }
      const turn = turns.get(payload.runId);
      if (!turn) {
        return;
      }
      if (event.event === "agent" && payload.stream === "assistant") {
        const data = isRecord(payload.data) ? payload.data : {};
        const delta = data.delta ?? "";
        if (typeof delta !== "string" || turn.streamedText.length + delta.length > 4096) {
          invalidEvents = true;
        } else {
          turn.streamedText += delta;
        }
      }
      if (event.event === "chat" && payload.state === "final") {
        turn.finalEvents += 1;
        const text = messageText(payload.message);
        if (turn.finalText.length + text.length > 4096) {
          invalidEvents = true;
        } else {
          turn.finalText += text;
        }
      }
      if (event.event === "chat" && (payload.state === "error" || payload.state === "aborted")) {
        turn.errors += 1;
      }
    },
    async captureHistories(rpc: GatewayRpc) {
      need(
        turns.size === expectedTurns && [...turns.values()].every((turn) => turn.turnId),
        "Missing verified live terminal receipts",
      );
      const groups = new Map<string, LiveTurn[]>();
      for (const turn of turns.values()) {
        const group = groups.get(turn.sessionKey);
        if (group) {
          group.push(turn);
        } else {
          groups.set(turn.sessionKey, [turn]);
        }
      }
      need(
        groups.size === agentIds.length &&
          [...groups.values()].every((group) => group.length === turnsPerSession) &&
          agentIds.every(
            (id) => [...groups.values()].filter((group) => group[0]?.agentId === id).length === 1,
          ),
        "Expected one live session per configured agent",
      );
      const sessionIds = new Set<string>();
      for (const [sessionKey, group] of groups) {
        const history = await rpc<{ sessionId?: string; messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 100,
        });
        need(
          identity(history.sessionId) && !sessionIds.has(history.sessionId),
          "Live history identity mismatch",
        );
        if (history.sessionId) {
          sessionIds.add(history.sessionId);
        }
        for (const turn of group) {
          need(turn.sessionId === history.sessionId, "Live terminal and history session differ");
          turn.historyMatches = (history.messages ?? []).filter(
            (message) =>
              isRecord(message) &&
              message.role === "assistant" &&
              messageText(message).trim() === turn.expected,
          ).length;
        }
      }
    },
    // The caller proves the owned Gateway group stopped before opening these databases.
    finish(root: string) {
      const persisted: Array<{
        runId: string;
        sessionId: string;
        turnId: string;
        agentId: string;
        streamMatches: boolean;
        finalMatches: boolean;
        historyMatches: number;
        finalEvents: number;
        errors: number;
        persistedMatches: number;
        persistedSha256: string | null;
      }> = [];
      for (const agentId of agentIds) {
        const databasePath = path.join(
          root,
          "state",
          "agents",
          agentId,
          "agent",
          "openclaw-agent.sqlite",
        );
        need(existsSync(databasePath), "Owned live transcript database missing");
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const query = database.prepare(
            "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          );
          const groups = new Map<string | undefined, Array<[string, LiveTurn]>>();
          for (const [runId, turn] of turns) {
            if (turn.agentId !== agentId) {
              continue;
            }
            const group = groups.get(turn.sessionId);
            if (group) {
              group.push([runId, turn]);
            } else {
              groups.set(turn.sessionId, [[runId, turn]]);
            }
          }
          for (const [sessionId, group] of groups) {
            need(identity(sessionId), "Live persisted session identity missing");
            if (!sessionId) {
              continue;
            }
            const rows = query.all(sessionId).map((row) => {
              if (typeof row.event_json !== "string") {
                throw new Error("Invalid persisted transcript event");
              }
              const json = row.event_json;
              const event: unknown = JSON.parse(json);
              return { json, message: isRecord(event) ? event.message : undefined };
            });
            for (const [runId, turn] of group) {
              const matches = rows.filter(
                ({ message }) =>
                  isRecord(message) &&
                  message.role === "assistant" &&
                  messageText(message).trim() === turn.expected,
              );
              persisted.push({
                runId,
                sessionId,
                turnId: turn.turnId ?? "",
                agentId,
                streamMatches: turn.streamedText.trim() === turn.expected,
                finalMatches: turn.finalText.trim() === turn.expected,
                historyMatches: turn.historyMatches,
                finalEvents: turn.finalEvents,
                errors: turn.errors,
                persistedMatches: matches.length,
                persistedSha256: matches[0]
                  ? createHash("sha256").update(matches[0].json).digest("hex")
                  : null,
              });
            }
          }
        } finally {
          database.close();
        }
      }
      return {
        provider: "openai",
        model: LIVE_GATEWAY_MODEL,
        credentialSource: "OPENAI_API_KEY environment",
        dreaming: false,
        indexing: "canonical default",
        recaps: "canonical default",
        requestedTurns: expectedTurns,
        turns: persisted,
        passed:
          !invalidEvents &&
          persisted.length === expectedTurns &&
          persisted.every(
            (turn) =>
              turn.turnId &&
              turn.streamMatches &&
              turn.finalMatches &&
              turn.historyMatches === 1 &&
              turn.finalEvents === 1 &&
              turn.errors === 0 &&
              turn.persistedMatches === 1,
          ) &&
          agentIds.every(
            (id) => persisted.filter((turn) => turn.agentId === id).length === turnsPerSession,
          ),
        requestCountNote: "Foreground turns do not count background provider requests or billing.",
      };
    },
  };
}

export type LiveGatewayEvidence = ReturnType<typeof createLiveGatewayEvidence>;

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { SessionManager } from "../sessions/session-manager.js";
import { compactEmbeddedAgentSession } from "./compact.queued.js";

// Real queued compaction, native delegate, AgentSession, and SQLite transcript; only the
// provider is a local OpenAI-compatible endpoint whose summary requests stall, fail, or answer.
type SummaryMode = "stall" | "error" | "ok";
type SessionTarget = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
type Fixture = { state: OpenClawTestState; config: OpenClawConfig; target: SessionTarget };

let summaryMode: SummaryMode = "stall";
let summaryRequests: string[] = [];
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      summaryRequests.push(body);
      const mode = body.includes('"model":"fallback-model"') ? "ok" : summaryMode;
      if (mode === "stall") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (mode === "error") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "summary model rejected the request" } }));
        return;
      }
      const chunk = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: "summary",
          object: "chat.completion.chunk",
          created: 1,
          model: "model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `${chunk({ role: "assistant", content: "## Goal\nModel summary after recovery." }, null)}` +
          `${chunk({}, "stop")}data: [DONE]\n\n`,
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

beforeEach(() => {
  summaryRequests = [];
});

const FILLER = "older context ".repeat(200);

/** Appends user -> assistant tool call -> tool result turns and returns their entry ids. */
function appendToolTurns(fixture: Fixture, first: number, count: number): string[] {
  const manager = SessionManager.open(fixture.target, fixture.state.workspaceDir);
  const ids: string[] = [];
  for (let turn = first; turn < first + count; turn += 1) {
    ids.push(
      manager.appendMessage({
        role: "user",
        content: `ask ${turn}: ${FILLER}`,
        timestamp: turn * 10 + 1,
      }),
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: {} }],
        api: "openai-completions",
        provider: "fixture",
        model: "model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: turn * 10 + 2,
      }),
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${turn}: ${FILLER}` }],
        isError: false,
        timestamp: turn * 10 + 3,
      }),
    );
  }
  return ids;
}

async function withSession(
  run: (fixture: Fixture) => Promise<void>,
  options: { modelFallback?: boolean } = {},
) {
  const state = await createOpenClawTestState({ prefix: "openclaw-summary-fallback-" });
  try {
    const model = (id: string) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 1024,
    });
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: {
            primary: "fixture/model",
            ...(options.modelFallback ? { fallbacks: ["fixture/fallback-model"] } : {}),
          },
          compaction: { timeoutSeconds: 5, keepRecentTokens: 300 },
        },
      },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "synthetic-fixture",
            baseUrl,
            models: [model("model"), model("fallback-model")],
          },
        },
      },
      plugins: { slots: { memory: "none" } },
    };
    await state.writeConfig(config);
    const target = {
      agentId: "main",
      sessionId: "summary-fallback",
      sessionKey: "agent:main:summary-fallback",
      storePath: state.path("sessions.sqlite"),
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await run({ state, config, target });
  } finally {
    await closePreparedModelRuntimeSnapshots();
    await state.cleanup();
  }
}

function compactSession(
  fixture: Fixture,
  options: { trigger?: "budget" | "manual"; abortSignal?: AbortSignal } = {},
) {
  return compactEmbeddedAgentSession(
    {
      ...fixture.target,
      sessionTarget: fixture.target,
      sessionFile: fixture.target.sessionKey,
      workspaceDir: fixture.state.workspaceDir,
      agentDir: fixture.state.agentDir(),
      config: fixture.config,
      provider: "fixture",
      model: "model",
      trigger: options.trigger ?? "budget",
      force: true,
      abortSignal: options.abortSignal,
      enqueue: async (task) => await task(),
    },
    { sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined } },
  );
}

function openSession(fixture: Fixture) {
  return SessionManager.open(fixture.target, fixture.state.workspaceDir);
}

describe("automatic compaction summary failure", () => {
  it("commits a deterministic reduction after a summary timeout", async () => {
    await withSession(async (fixture) => {
      const seeded = appendToolTurns(fixture, 0, 8);
      summaryMode = "stall";
      const result = await compactSession(fixture);

      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(summaryRequests.length).toBeGreaterThan(0);
      const branch = openSession(fixture).getBranch();
      const compactions = branch.filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(1);
      expect(compactions[0]?.summary).toContain("removed without a summary");
      // Durable history is untouched; the boundary keeps a verbatim tool-call/result suffix.
      expect(branch.filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual(
        seeded,
      );
      const firstKept = seeded.indexOf(compactions[0]!.firstKeptEntryId);
      expect(firstKept).toBeGreaterThan(0);
      expect(firstKept % 3).not.toBe(2);
      const context = openSession(fixture).buildSessionContext().messages;
      expect(context[0]?.role).toBe("compactionSummary");
      expect(context.slice(1)).toHaveLength(seeded.length - firstKept);
      expect(context.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call-7" });

      // A later turn's model compaction still works and carries the fallback summary forward.
      appendToolTurns(fixture, 8, 4);
      summaryMode = "ok";
      summaryRequests = [];
      expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
      expect(summaryRequests.join("\n")).toContain("removed without a summary");
      expect(
        openSession(fixture)
          .getBranch()
          .filter((entry) => entry.type === "compaction")
          .at(-1)?.summary,
      ).toContain("Model summary after recovery.");
    });
  });

  it("lets a configured fallback model summarize a timed-out compaction first", async () => {
    await withSession(
      async (fixture) => {
        appendToolTurns(fixture, 0, 8);
        summaryMode = "stall";

        expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
        expect(summaryRequests.some((body) => body.includes('"model":"fallback-model"'))).toBe(
          true,
        );
        expect(
          openSession(fixture)
            .getBranch()
            .filter((entry) => entry.type === "compaction")
            .map((entry) => entry.summary),
        ).toEqual([expect.stringContaining("Model summary after recovery.")]);
      },
      { modelFallback: true },
    );
  });

  it.each([
    { failure: "a caller Stop", mode: "stall", trigger: "budget", stop: true },
    { failure: "a manual /compact timeout", mode: "stall", trigger: "manual", stop: false },
    { failure: "a non-timeout summary error", mode: "error", trigger: "budget", stop: false },
  ] as const)("keeps $failure as a failed compaction", async ({ mode, trigger, stop }) => {
    await withSession(async (fixture) => {
      appendToolTurns(fixture, 0, 8);
      summaryMode = mode;
      const caller = new AbortController();
      const pending = compactSession(fixture, { trigger, abortSignal: caller.signal });
      if (stop) {
        await expect.poll(() => summaryRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
        caller.abort(new Error("user stop"));
      }

      expect(await pending).toMatchObject({ ok: false, compacted: false });
      expect(summaryRequests.length).toBeGreaterThan(0);
      expect(
        openSession(fixture)
          .getBranch()
          .some((entry) => entry.type === "compaction"),
      ).toBe(false);
    });
  });
});

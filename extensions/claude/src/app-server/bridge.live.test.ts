/**
 * End-to-end proof that the openclaw-claude-bridge binary speaks the
 * codex-app-server protocol correctly: spawn, initialize handshake,
 * thread lifecycle, dynamic-tool dispatch, approval routing, transcript
 * mirror dedupe.
 *
 * Gated by `OPENCLAW_LIVE_TEST=1`. The protocol-level checks (spawn,
 * initialize, thread lifecycle) run without an Anthropic API key. The
 * full-turn round-trip (dynamic-tool call, approval) additionally
 * requires `ANTHROPIC_API_KEY` and is skipped silently otherwise.
 *
 * Tank's 2026-05-22 task-list item #2 — closes the "real-runtime
 * confidence gate" gap that unit coverage alone can't fill.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeAppServerClient } from "./client.js";
import type { ProjectorAccumulator } from "./event-projector.js";
import { mirrorClaudeAppServerTranscript } from "./transcript-mirror.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const ANTHROPIC = (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;

const describeLive = LIVE ? describe : describe.skip;
const describeLiveWithKey = LIVE && ANTHROPIC ? describe : describe.skip;

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 120_000;

describeLive("openclaw-claude-bridge — protocol-level proof (no API key required)", () => {
  let client: ClaudeAppServerClient;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    client = new ClaudeAppServerClient({});
    await client.start();
  });

  afterAll(async () => {
    client?.stop();
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("spawns the binary and completes the initialize handshake", () => {
    const info = client.getServerInfo();
    expect(info?.name).toBeTruthy();
    expect(info?.version).toBeTruthy();
  });

  it("reports the published @zeroaltitude/openclaw-claude-bridge package name", () => {
    const info = client.getServerInfo();
    expect(info?.name).toBe("@zeroaltitude/openclaw-claude-bridge");
  });

  it("supports thread/start → thread/unsubscribe lifecycle", async () => {
    const startResp = (await client.request(
      "thread/start",
      {
        cwd: process.cwd(),
        model: "claude-sonnet-4-6",
        modelProvider: "anthropic",
        approvalPolicy: "never",
        sandbox: { mode: "danger-full-access" },
        developerInstructions: "respond with exactly the word OK",
        dynamicTools: [],
      },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    )) as { thread: { id: string } };
    expect(startResp.thread.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await client.request("thread/unsubscribe", { threadId: startResp.thread.id });
  });

  it("model/list returns a non-empty anthropic model list", async () => {
    const resp = (await client.request(
      "model/list",
      {},
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    )) as {
      data: Array<{ id: string }>;
    };
    expect(Array.isArray(resp.data)).toBe(true);
    expect(resp.data.length).toBeGreaterThan(0);
    expect(resp.data.every((m) => typeof m.id === "string" && m.id.startsWith("claude-"))).toBe(
      true,
    );
  });

  it("transcript mirror is replay-safe after a real server-issued thread_id", async () => {
    // Get a real thread_id from the server so the idempotencyKey reflects
    // an actual binding (not a stub).
    const startResp = (await client.request(
      "thread/start",
      {
        cwd: process.cwd(),
        model: "claude-sonnet-4-6",
        modelProvider: "anthropic",
        approvalPolicy: "never",
        sandbox: { mode: "danger-full-access" },
        developerInstructions: "",
        dynamicTools: [],
      },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    )) as { thread: { id: string } };
    const threadId = startResp.thread.id;
    const turnId = `turn_${Date.now()}`;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-bridge-proof-"));
    tempDirs.push(dir);
    const agentId = "main";
    const sessionId = "proof-session";
    const sessionKey = `agent:${agentId}:${sessionId}`;
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    await upsertSessionEntry({
      agentId,
      sessionKey,
      storePath,
      entry: {
        sessionFile: `sqlite:${agentId}:${sessionId}:${storePath}`,
        sessionId,
        updatedAt: 1,
      },
    });
    const mirrorTarget = { agentId, sessionId, sessionKey, storePath };

    const acc: ProjectorAccumulator = {
      assistantTexts: ["proof-of-mirror"],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map(),
    };

    // First mirror: appends one assistant message.
    await mirrorClaudeAppServerTranscript({
      ...mirrorTarget,
      threadId,
      turnId,
      lifecycleOutcome: "started",
      acc,
    });
    const afterFirst = await readMirrored(mirrorTarget);
    expect(afterFirst).toHaveLength(1);

    // Replay: same params produce zero new appends.
    await mirrorClaudeAppServerTranscript({
      ...mirrorTarget,
      threadId,
      turnId,
      lifecycleOutcome: "started",
      acc,
    });
    const afterReplay = await readMirrored(mirrorTarget);
    expect(afterReplay).toHaveLength(1);

    await client.request("thread/unsubscribe", { threadId });
  });
});

describeLiveWithKey(
  "openclaw-claude-bridge — real Anthropic turn (ANTHROPIC_API_KEY required)",
  () => {
    let client: ClaudeAppServerClient;

    beforeAll(async () => {
      client = new ClaudeAppServerClient({});
      await client.start();
    });

    afterAll(() => {
      client?.stop();
    });

    it("dispatches a dynamic tool call when Claude invokes it", async () => {
      const startResp = (await client.request(
        "thread/start",
        {
          cwd: process.cwd(),
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          approvalPolicy: "never",
          sandbox: { mode: "danger-full-access" },
          developerInstructions:
            "When asked to echo, you MUST call the `openclaw_echo` tool. Do not respond inline.",
          dynamicTools: [
            {
              name: "openclaw_echo",
              description: "Echoes the input string back to the caller.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          ],
        },
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      )) as { thread: { id: string } };
      const threadId = startResp.thread.id;

      // Capture the server→bridge tool-call request so we can answer it.
      const observedToolCall: { tool: string; args: unknown } = { tool: "", args: undefined };
      let observedToolCallSeen = false;
      const off = client.onServerRequest(async (req) => {
        if (req.method === "item/tool/call") {
          const p = req.params as { name?: string; arguments?: unknown };
          observedToolCall.tool = p.name ?? "";
          observedToolCall.args = p.arguments;
          observedToolCallSeen = true;
          return {
            contentItems: [{ type: "inputText", text: "echoed:hello" }],
            success: true,
          };
        }
        return undefined;
      });

      try {
        const turnResp = (await client.request(
          "turn/start",
          { threadId, userInput: "please echo the word hello using your tool" },
          AbortSignal.timeout(TURN_TIMEOUT_MS),
        )) as { items: unknown[] };

        expect(observedToolCallSeen).toBe(true);
        expect(observedToolCall.tool).toBe("openclaw_echo");
        expect(Array.isArray(turnResp.items)).toBe(true);
      } finally {
        off();
        await client.request("thread/unsubscribe", { threadId });
      }
    });

    it("routes a command-approval request through the bridge", async () => {
      const startResp = (await client.request(
        "thread/start",
        {
          cwd: process.cwd(),
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          approvalPolicy: "on-request",
          sandbox: { mode: "read-only" },
          developerInstructions:
            "Use the Bash tool to run `echo hi`. Do not try alternative tools.",
          dynamicTools: [],
        },
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      )) as { thread: { id: string } };
      const threadId = startResp.thread.id;

      let observedApproval = false;
      const off = client.onServerRequest(async (req) => {
        if (
          req.method === "item/commandExecution/requestApproval" ||
          req.method === "item/fileChange/requestApproval"
        ) {
          observedApproval = true;
          return { decision: "decline" };
        }
        return undefined;
      });

      try {
        await client
          .request(
            "turn/start",
            { threadId, userInput: "run echo hi using Bash" },
            AbortSignal.timeout(TURN_TIMEOUT_MS),
          )
          .catch(() => {
            /* the decline may surface as a turn error; the assertion below is what matters */
          });
        expect(observedApproval).toBe(true);
      } finally {
        off();
        await client.request("thread/unsubscribe", { threadId });
      }
    });
  },
);

async function readMirrored(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  const events = await readSessionTranscriptEvents(target);
  return events.filter((event) =>
    Boolean(event && typeof event === "object" && (event as { message?: unknown }).message),
  );
}

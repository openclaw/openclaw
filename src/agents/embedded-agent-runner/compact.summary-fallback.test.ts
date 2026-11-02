import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createCompactionNoticePayload,
  resolveCompactionCompletionNotice,
} from "../../auto-reply/reply/compaction-notice.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import { writePlugin } from "../../plugins/loader.test-fixtures.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { compactEmbeddedAgentSessionDirect } from "./compact.js";
import { compactEmbeddedAgentSession } from "./compact.queued.js";

// Real queued compaction, native delegate, AgentSession, and SQLite transcript; only the
// provider is a local OpenAI-compatible endpoint whose summary requests stall, fail, or answer.
type SummaryMode =
  | "stall"
  | "provider-timeout"
  | "bare-408"
  | "server-error"
  | "auth-error"
  | "error"
  | "refusal"
  | "ok";
type SessionTarget = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
type Fixture = { state: OpenClawTestState; config: OpenClawConfig; target: SessionTarget };

let summaryMode: SummaryMode = "stall";
let summaryRequests: string[] = [];
let summaryArrived = createDeferred();
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
      summaryArrived.resolve();
      if (summaryMode === "refusal") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [
            {
              type: "message_start",
              message: { id: "refused-summary", usage: { input_tokens: 2 } },
            },
            {
              type: "message_delta",
              delta: {
                stop_reason: "refusal",
                stop_details: {
                  type: "refusal",
                  category: "reasoning_extraction",
                  explanation: "Synthetic summary refusal.",
                },
              },
              usage: { output_tokens: 0 },
            },
            { type: "message_stop" },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
        return;
      }
      const mode: SummaryMode = body.includes('"model":"fallback-model"') ? "ok" : summaryMode;
      if (mode === "stall") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      if (mode === "bare-408") {
        res.writeHead(408);
        res.end();
        return;
      }
      const errors = {
        "auth-error": [401, "summary model authentication failed"],
        "provider-timeout": [408, "upstream request timed out"],
        "server-error": [500, "Internal Server Error"],
        error: [400, "summary model rejected the request"],
      } as const;
      if (mode !== "ok") {
        const [statusCode, message] = errors[mode];
        res.writeHead(statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
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
        chunk({ role: "assistant", content: "## Goal\nModel summary after recovery." }, null) +
          `${chunk({}, "stop")}data: [DONE]\n\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  summaryRequests = [];
  summaryArrived = createDeferred();
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
        usage: createZeroUsageFixture(),
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

async function createFixture(
  options: {
    modelFallback?: boolean;
    safeguard?: boolean;
    refusal?: boolean;
  } = {},
) {
  const state = await createOpenClawTestState({ prefix: "openclaw-summary-fallback-" });
  onTestFinished(async () => {
    await closePreparedModelRuntimeSnapshots();
    await state.cleanup();
  });
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
        compaction: {
          timeoutSeconds: 60,
          keepRecentTokens: 300,
          ...(options.safeguard ? { mode: "safeguard" as const } : {}),
        },
      },
    },
    models: {
      providers: {
        fixture: {
          api: options.refusal ? "anthropic-messages" : "openai-completions",
          apiKey: "synthetic-fixture",
          baseUrl,
          models: [model("model"), model("fallback-model")],
        },
      },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
  };
  await state.writeConfig(config);
  const target = {
    agentId: "main",
    sessionId: "summary-fallback",
    sessionKey: "agent:main:summary-fallback",
    storePath: state.path("sessions.sqlite"),
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  const fixture = { state, config, target };
  return { ...fixture, seeded: appendToolTurns(fixture, 0, 8) };
}

function compactSession(
  fixture: Fixture,
  abortSignal?: AbortSignal,
  trigger: "manual" | "budget" = "budget",
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
      trigger,
      force: true,
      abortSignal,
      enqueue: async (task) => await task(),
    },
    { sourceAuthority: { assertActive: () => {}, operatorAuthority: undefined } },
  );
}

function openSession(fixture: Fixture) {
  return SessionManager.open(fixture.target, fixture.state.workspaceDir);
}

function getCompactions(fixture: Fixture) {
  return openSession(fixture)
    .getBranch()
    .filter((entry) => entry.type === "compaction");
}

function expectFallbackSummary(fixture: Fixture) {
  expect(getCompactions(fixture).map((entry) => entry.summary)).toEqual([
    expect.stringContaining("removed without a summary"),
  ]);
}

it.each([
  { safeguard: true, trigger: "manual" },
  { safeguard: true, trigger: "budget" },
  { safeguard: false, trigger: "budget" },
] as const)(
  "trims a refused summary once with a visible notice ($trigger, safeguard=$safeguard)",
  async ({ safeguard, trigger }) => {
    const fixture = await createFixture({ safeguard, refusal: true, modelFallback: true });
    const seeded = [...fixture.seeded, ...appendToolTurns(fixture, 8, 43)];
    summaryMode = "refusal";

    const result = await compactSession(fixture, undefined, trigger);

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: { details: { summaryRefused: true } },
    });
    expect(summaryRequests).toHaveLength(1);
    expect(result.result?.tokensAfter).toBeLessThan(24_000);
    expect(result.result?.tokensBefore).toBeGreaterThan(24_000);
    expectFallbackSummary(fixture);
    const session = openSession(fixture);
    expect(
      session
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    ).toEqual(seeded);
    expect(session.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-50",
    });
    expect(
      createCompactionNoticePayload(resolveCompactionCompletionNotice(result, false)).text,
    ).toContain("Context trimmed because the summarizer refused");
    expect(
      createCompactionNoticePayload(resolveCompactionCompletionNotice(result, true)).text,
    ).toContain("Continuing with bounded recent context");
  },
);

it("commits a deterministic reduction after a bodyless 408 summary timeout", async () => {
  const fixture = await createFixture();
  const { seeded } = fixture;
  summaryMode = "bare-408";
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
  expect(getCompactions(fixture).at(-1)?.summary).toContain("Model summary after recovery.");
});

it.each([
  { mode: "provider-timeout", modelFallback: true, safeguard: false },
  { mode: "bare-408", modelFallback: false, safeguard: true },
] as const)("commits $mode reduction (safeguard=$safeguard)", async (options) => {
  const fixture = await createFixture(options);
  summaryMode = options.mode;

  expect(await compactSession(fixture)).toMatchObject({ ok: true, compacted: true });
  if (options.safeguard) {
    expect(summaryRequests.length).toBeGreaterThan(0);
  } else {
    expect(summaryRequests.some((body) => body.includes('"model":"fallback-model"'))).toBe(false);
  }
  expectFallbackSummary(fixture);
});

it.each([false, true])(
  "uses the fallback model's runtime only for unlocked native sessions (locked=%s)",
  async (locked) => {
    const fixture = await createFixture();
    summaryMode = "auth-error";
    const plugin = writePlugin({
      id: "summary-native",
      dir: fixture.state.path("summary-native"),
      registration: `api.registerAgentHarness({
      id: "summary-native",
      label: "Primary summary runtime",
      authBootstrap: "harness",
      supports: (context) => context.requestedRuntime === "summary-native" && context.provider === "fixture"
        ? { supported: true }
        : { supported: false, reason: "Primary runtime cannot run the fallback provider" },
      runAttempt: async () => { throw new Error("Compaction must not run an agent turn"); },
    });`,
    });
    await fs.writeFile(
      fixture.state.path("summary-native", "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        activation: { onStartup: false, onAgentHarnesses: ["summary-native"] },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      }),
    );
    const primary = fixture.config.models!.providers!.fixture!;
    fixture.config.models!.providers!.backup = {
      ...primary,
      models: primary.models.filter(({ id }) => id === "fallback-model"),
    };
    delete primary.apiKey;
    fixture.config.agents!.defaults!.model = {
      primary: "fixture/model",
      fallbacks: ["backup/fallback-model"],
    };
    fixture.config.plugins = {
      allow: [plugin.id],
      load: { paths: [plugin.dir] },
      slots: { memory: "none" },
    };
    await fixture.state.writeConfig(fixture.config);
    await loadAndActivateRootPluginRegistry({
      config: fixture.config,
      workspaceDir: fixture.state.workspaceDir,
      onlyPluginIds: [plugin.id],
      cache: false,
    });
    const scope = new AsyncWorkScope();
    let result;
    try {
      result = await scope.run(() =>
        compactEmbeddedAgentSessionDirect({
          ...fixture.target,
          sessionTarget: fixture.target,
          sessionFile: fixture.target.sessionKey,
          workspaceDir: fixture.state.workspaceDir,
          agentDir: fixture.state.agentDir(),
          config: fixture.config,
          provider: "fixture",
          model: "model",
          agentHarnessId: "summary-native",
          modelSelectionLocked: locked,
          trigger: "budget",
          force: true,
        }),
      );
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      );
    }

    expect(JSON.parse(summaryRequests[0]!).model).toBe("model");
    if (locked) {
      expect(result).toMatchObject({ ok: false, compacted: false });
      expect(summaryRequests.map((request) => JSON.parse(request).model)).not.toContain(
        "fallback-model",
      );
      expect(getCompactions(fixture)).toHaveLength(0);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
    expect(summaryRequests.map((request) => JSON.parse(request).model)).toContain("fallback-model");
    expect(getCompactions(fixture).at(-1)?.summary).toContain("Model summary after recovery.");
    const session = openSession(fixture);
    expect(
      session
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
    ).toEqual(fixture.seeded);
    expect(session.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-7",
    });
  },
);

it.each([
  { failure: "a caller Stop", mode: "stall", stop: true },
  { failure: "a non-timeout summary error", mode: "error", stop: false },
  // Wrapped summary text reads "…failed: 500 Internal Server Error"; it is not a timeout.
  { failure: "a fast 500 summary error", mode: "server-error", stop: false },
] as const)("keeps $failure as a failed compaction", async ({ mode, stop }) => {
  const fixture = await createFixture();
  summaryMode = mode;
  const caller = new AbortController();
  const pending = compactSession(fixture, caller.signal);
  if (stop) {
    await summaryArrived.promise;
    caller.abort(new Error("user stop"));
  }

  expect(await pending).toMatchObject({ ok: false, compacted: false });
  expect(summaryRequests.length).toBeGreaterThan(0);
  expect(getCompactions(fixture)).toHaveLength(0);
});

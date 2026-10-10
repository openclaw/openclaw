import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { notifyProviderStreamOpened } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { registerDiagnosticTracePropagationBridge } from "../../../infra/diagnostic-trace-propagation.js";
import { flushDiagnosticsTimeline } from "../../../infra/diagnostics-timeline.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const modelFixture = { provider: "openai", model: "gpt-5.4", api: "openai-responses" };
function wrap(
  streamFn: StreamFn,
  context: Partial<Parameters<typeof wrapStreamFnWithDiagnosticModelCallEvents>[1]> = {},
) {
  return wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: "run-1",
    ...modelFixture,
    trace: createDiagnosticTraceContext(),
    nextCallId: () => "call-1",
    ...context,
  });
}
async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    /* drain */
  }
}
async function collect(run: () => Promise<void>) {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("model.call.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await waitForDiagnosticEventsDrained();
    return events;
  } finally {
    stop();
  }
}
async function timeline(run: () => Promise<void>, flag: string | null = "1") {
  const timelinePath = join(tempDirs.make("openclaw-provider-timeline-"), "timeline.jsonl");
  await withEnvAsync(
    { OPENCLAW_DIAGNOSTICS: flag ?? undefined, OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath },
    run,
  );
  flushDiagnosticsTimeline();
  return readFileSync(timelinePath, "utf8")
    .trim()
    .split("\n")
    .map((line: string): Record<string, unknown> => JSON.parse(line));
}
function hooks() {
  const started = vi.fn();
  const ended = vi.fn();
  initializeGlobalHookRunner(
    createHookRunnerWithRegistry([
      { hookName: "model_call_started", handler: started },
      { hookName: "model_call_ended", handler: ended },
    ]).registry,
  );
  return { started, ended };
}

describe("model diagnostic lifecycle", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetGlobalHookRunner();
  });
  afterEach(() => {
    flushDiagnosticsTimeline();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it.each(["stop", "error"] as const)(
    "notifies terminal %s once after deferred EOF settlement",
    async (stopReason) => {
      const onTerminal = vi.fn();
      const onSucceeded = vi.fn();
      const source = createAssistantMessageEventStream();
      source.end(
        makeAssistantMessageFixture({
          content: [{ type: "text", text: "Done." }],
          stopReason,
          errorMessage: undefined,
        }),
      );
      const wrapped = wrap(() => source, { agentId: "agent-1", onTerminal, onSucceeded });
      const events = await collect(async () => {
        const response = await wrapped({} as never, { messages: [] });
        await drain(response);
        expect(onTerminal).not.toHaveBeenCalled();
        expect(onSucceeded).not.toHaveBeenCalled();
        await response.result();
        await response.result();
        await drain(response);
      });
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(onSucceeded).toHaveBeenCalledTimes(stopReason === "stop" ? 1 : 0);
      expect(events.map((event) => event.type)).toEqual([
        "model.call.started",
        stopReason === "stop" ? "model.call.completed" : "model.call.error",
      ]);
      expect(events).toMatchObject([{ agentId: "agent-1" }, { agentId: "agent-1" }]);
    },
  );

  it("separates provider activity from delayed terminal settlement without content", async () => {
    let now = Date.parse("2026-07-09T18:30:00.000Z");
    const startedAt = now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const assistant = { role: "assistant", stopReason: "stop", content: "private-answer" };
    async function* stream() {
      now += 10;
      yield { type: "start", partial: { private: "private-payload" } };
      now += 20;
      yield { type: "done", message: assistant };
    }
    const source = Object.assign(stream(), {
      result: async () => {
        now += 100;
        return assistant;
      },
    });
    const wrapped = wrap((() => source) as unknown as StreamFn, {
      config: { diagnostics: { flags: ["timeline"] } },
    });
    const events = await timeline(async () => {
      const response = await wrapped(
        {} as never,
        { messages: [{ role: "user", content: "private-prompt" }] } as never,
      );
      await drain(response);
      await response.result();
      await response.result();
    }, null);
    expect(events).toMatchObject([
      { name: "provider.request.started", timestamp: new Date(startedAt).toISOString() },
      { name: "provider.request.activity", timestamp: new Date(startedAt + 10).toISOString() },
      {
        type: "provider.request",
        durationMs: 130,
        ok: true,
        attributes: {
          terminalAtMs: startedAt + 130,
          lastProviderActivityAtMs: startedAt + 30,
          terminalReason: "stop",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private-(?:answer|payload|prompt)/);
  });

  it("bounds activity marks and flag lookups independently of chunk volume", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const readFlags = vi.fn(() => []);
    async function* stream() {
      for (const offset of [0, 1, 29_999, 30_000, 30_001]) {
        now = offset;
        for (let i = 0; i < 1000; i++) {
          yield { type: "thinking_delta", delta: "", partial: {} };
        }
      }
    }
    const wrapped = wrap((() => stream()) as unknown as StreamFn, {
      config: {
        diagnostics: {
          get flags() {
            return readFlags();
          },
        },
      },
    });
    const events = await timeline(async () => {
      await drain(await wrapped({} as never, { messages: [] }));
    });
    expect(events.map((event) => event.name)).toEqual([
      "provider.request.started",
      "provider.request.activity",
      "provider.request.activity",
      "provider.request",
    ]);
    expect(
      events
        .filter((event) => event.name === "provider.request.activity")
        .map((event) => event.timestamp),
    ).toEqual([new Date(0).toISOString(), new Date(30_000).toISOString()]);
    expect(events.at(-1)).toMatchObject({ attributes: { lastProviderActivityAtMs: 30_001 } });
    expect(events.every((event) => event.runId === "run-1" && event.spanId === "call-1")).toBe(
      true,
    );
    expect(readFlags.mock.calls.length).toBeLessThan(100);
  });

  it("lets disabled collection override configured timelines", async () => {
    const timelinePath = join(tempDirs.make("openclaw-disabled-model-timeline-"), "timeline.jsonl");
    await withEnvAsync(
      { OPENCLAW_DIAGNOSTICS: "0", OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath },
      async () => {
        await wrap((() => undefined) as unknown as StreamFn, {
          config: { diagnostics: { flags: ["timeline"] } },
        })({} as never, { messages: [] });
        flushDiagnosticsTimeline();
        expect(existsSync(timelinePath)).toBe(false);
      },
    );
  });

  it("records legacy HTTP metadata without inferring provider acceptance", async () => {
    const onResponse = vi.fn(async () => undefined);
    const response = { status: 200, headers: { "x-request-id": "req-1" } };
    const wrapped = wrap(((
      model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => options?.onResponse?.(response, model)) as unknown as StreamFn);
    const events = await timeline(async () => {
      await wrapped({} as never, {} as never, { onResponse });
    });
    expect(onResponse).toHaveBeenCalledWith(response, {});
    expect(events.filter((event) => event.type === "provider.request")).toMatchObject([
      { ok: true, status: 200, attributes: { providerAccepted: false } },
    ]);
  });

  it("records SDK acceptance without HTTP metadata", async () => {
    const wrapped = wrap(((
      _model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => notifyProviderStreamOpened({ options, cancelStream: vi.fn() })) as unknown as StreamFn);
    const events = await timeline(async () => {
      await wrapped({} as never, {} as never, {});
    });
    expect(events.filter((event) => event.type === "provider.request")).toMatchObject([
      {
        ok: true,
        attributes: { providerAccepted: true, providerAcceptanceKind: "provider_stream_opened" },
      },
    ]);
    expect(events.at(-1)?.status).toBeUndefined();
  });

  it("bounds provider attributes without splitting UTF-16 characters", async () => {
    const prefix = "m".repeat(255);
    const boundary = "b".repeat(256);
    const events = await timeline(async () => {
      for (const model of [`${prefix}😀tail`, boundary]) {
        await wrap((() => undefined) as unknown as StreamFn, { model })({} as never, {} as never);
      }
    });
    expect(events.filter((event) => event.type === "provider.request")).toMatchObject([
      { attributes: { model: prefix } },
      { attributes: { model: boundary } },
    ]);
  });

  it.each([undefined, 503])(
    "prefers observed HTTP status %s over a terminal error",
    async (status) => {
      const wrapped = wrap(((
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        if (status) {
          void options?.onResponse?.({ status, headers: {} }, model);
        }
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }) as unknown as StreamFn);
      const events = await timeline(async () => {
        expect(() => wrapped({} as never, {} as never)).toThrow("rate limited");
      });
      expect(events.filter((event) => event.type === "provider.request")).toMatchObject([
        { ok: false, status: status ?? 429 },
      ]);
    },
  );

  it.each([true, false])(
    "replaces caller traceparent with the trusted exporter span (resolved=%s)",
    async (resolved) => {
      const trace = createDiagnosticTraceContext({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: "bbbbbbbbbbbbbbbb",
        traceFlags: "01",
      });
      registerDiagnosticTracePropagationBridge({
        resolveTraceContext: () => (resolved ? trace : undefined),
      });
      const source = vi.fn<StreamFn>();
      const caller = {
        headers: { "X-Custom": "kept", TraceParent: "untrusted" },
        sessionId: "provider-session",
      };
      await wrap(source)({} as never, {} as never, caller);
      expect(source.mock.calls[0]?.[2]).toMatchObject({
        sessionId: "provider-session",
        requestId: "call-1",
        headers: resolved
          ? { "X-Custom": "kept", traceparent: `00-${trace.traceId}-${trace.spanId}-01` }
          : { "X-Custom": "kept" },
      });
      expect(source.mock.calls[0]?.[2]?.headers).not.toHaveProperty("TraceParent");
      expect(caller.headers).toEqual({ "X-Custom": "kept", TraceParent: "untrusted" });
    },
  );

  it.each(["stop", "error"])("fires frozen sanitized hooks for %s", async (stopReason) => {
    const { started, ended } = hooks();
    const secret = "secret response with Bearer sk-test-secret-value";
    async function* stream() {
      yield { type: "text", text: secret };
      if (stopReason === "error") {
        yield { type: "error", error: { role: "assistant", stopReason, errorMessage: secret } };
      }
    }
    const budget = {
      contextTokenBudget: 150_000,
      contextWindowSource: "modelsConfig" as const,
      contextWindowReferenceTokens: 200_000,
    };
    const events = await collect(async () => {
      await drain(
        await wrap((() => stream()) as unknown as StreamFn, {
          sessionKey: "session-key",
          sessionId: "session-id",
          transport: "http",
          ...budget,
        })({} as never, {} as never),
      );
    });
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      stopReason === "error" ? "model.call.error" : "model.call.completed",
    ]);
    expect(started).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(budget),
      expect.objectContaining({ ...budget, sessionKey: "session-key", modelProviderId: "openai" }),
    );
    expect(ended).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...budget,
        outcome: stopReason === "error" ? "error" : "completed",
        durationMs: expect.any(Number),
        responseStreamBytes: expect.any(Number),
        timeToFirstByteMs: expect.any(Number),
      }),
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(Object.isFrozen(started.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(started.mock.calls[0]?.[1])).toBe(true);
    expect(Object.isFrozen(started.mock.calls[0]?.[1].trace)).toBe(true);
    expect(JSON.stringify([started.mock.calls, ended.mock.calls])).not.toContain(secret);
  });

  it("keeps core diagnostics when finalization suppresses plugin hooks", async () => {
    const { started, ended } = hooks();
    const events = await collect(async () => {
      await wrap((() => undefined) as unknown as StreamFn, { suppressPluginHooks: true })(
        {} as never,
        {} as never,
      );
    });
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(started).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });
});

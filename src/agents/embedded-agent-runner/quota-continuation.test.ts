import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { attachRuntimePromptMediaFacts } from "../../media/media-facts.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { isSettledQuotaTranscript } from "./quota-continuation-transcript.js";
import {
  assertQuotaContinuationProviderPayload,
  bindQuotaContinuationSuccessor,
  claimQuotaContinuation as claimForApi,
  offerQuotaContinuation,
  readQuotaContinuation,
  settleQuotaContinuation,
} from "./quota-continuation.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";
import { prepareEmbeddedAttemptTimeout } from "./run/attempt-timeout-prepare.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import { createQuotaContinuationBudget } from "./run/quota-continuation-budget.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const claimQuotaContinuation = (...params: Parameters<typeof claimForApi>) =>
  claimForApi(params[0], params[1], params[2], params[3] ?? "openai-completions");

const disk = vi.hoisted(() => ({ messages: [] as unknown[] }));
vi.mock("../../config/sessions/session-accessor.sqlite-model-context.js", () => ({
  readSessionTranscriptContextMessages: (
    _target: unknown,
    read: (messages: unknown[]) => unknown,
  ) => read(disk.messages),
}));

function messages(): AgentMessage[] {
  return [
    { role: "user", content: "Write once, then explain the result.", timestamp: 1 },
    buildEmbeddedRunnerAssistant({
      content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "counter" } }],
      stopReason: "toolUse",
    }),
    {
      role: "toolResult",
      toolCallId: "write-1",
      toolName: "write",
      isError: false,
      content: [{ type: "text", text: "one committed write" }],
      timestamp: 2,
    },
  ];
}

async function fixture() {
  const admission = prepareSystemAgentRunAdmission({}, "quota-test", "main", "quota-test");
  const admittedRunContext = await admission.admit("plugin-harness");
  const abort = new AbortController();
  const params: RunEmbeddedAgentInternalParams = {
    admittedRunContext,
    runId: "quota-test",
    sessionId: "quota-session",
    sessionKey: "agent:main:quota-test",
    provider: "native-provider",
    model: "native-model",
    workspaceDir: "/synthetic",
    prompt: "Write once, then explain the result.",
    timeoutMs: 1_000,
    sessionTarget: {
      agentId: "main",
      sessionId: "quota-session",
      sessionKey: "agent:main:quota-test",
      storePath: "/synthetic/agent.sqlite",
    },
    abortSignal: abort.signal,
  };
  params.quotaBudget = createQuotaContinuationBudget(params);
  params.quotaBudget.initialize(params.timeoutMs);
  onTestFinished(() => params.quotaBudget?.dispose());
  const recorded = messages();
  disk.messages = recorded;
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: {
      kind: "failed",
      source: "prompt",
      error: Object.assign(new Error("Quota exhausted"), { status: 429 }),
    },
    messagesSnapshot: recorded,
    assistantTexts: [],
    currentAttemptAssistant: undefined,
    lastAssistant: undefined,
    toolMetas: [{ toolName: "write", toolCallId: "write-1", isError: false, replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledQuotaContinuation: { reason: "quota_exhausted", messages: recorded },
  });
  const result: EmbeddedAgentRunResult = {
    payloads: [{ text: "Actions may already have run; do not retry blindly.", isError: true }],
    meta: {
      durationMs: 1,
      replayInvalid: true,
      error: { kind: "incomplete_turn", message: "Quota exhausted", fallbackSafe: false },
    },
  };
  return {
    admission,
    abort,
    params,
    attempt,
    result,
    offer: () => offerQuotaContinuation({ params, attempt, result, tainted: false }),
  };
}

describe("settled quota continuation custody", () => {
  beforeEach(() => {
    disk.messages = [];
  });

  it("separates one-shot continuation from unsafe whole-turn replay", async () => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    f.offer();
    expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
    await settleQuotaContinuation(f.result, Promise.resolve());
    const token = readQuotaContinuation(f.result, f.params, () => true);
    expect(token).toBeDefined();
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "native-provider",
        model: "native-model",
        result: f.result,
      }),
    ).toBeNull();
    const next = { ...f.params, provider: "fallback-provider", model: "fallback-model" };
    claimQuotaContinuation(token!, next, "openclaw");
    expect(() => claimQuotaContinuation(token!, next, "openclaw")).toThrow();
    expect(f.result.meta.replayInvalid).toBe(true);
    expect(f.result.meta.error?.fallbackSafe).toBe(false);
  });

  it("preserves older text history while validating the exact current settled turn", async () => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    disk.messages = [
      { role: "user", content: "Earlier text request", timestamp: 0 },
      buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "Earlier reply" }] }),
      ...disk.messages,
    ];
    f.offer();
    await settleQuotaContinuation(f.result, Promise.resolve());
    expect(readQuotaContinuation(f.result, f.params, () => true)).toBeDefined();
    expect(disk.messages).toHaveLength(5);
  });

  it.each(["image", "document", "unknown-role"] as const)(
    "does not transfer older %s context merely because the current turn is text-only",
    async (kind) => {
      const f = await fixture();
      onTestFinished(() => f.admission.close());
      disk.messages = [
        {
          role: kind === "unknown-role" ? "custom-media" : "user",
          content: [{ type: kind, data: "synthetic", mimeType: "image/png" }],
          timestamp: 0,
        },
        ...disk.messages,
      ];
      f.offer();
      await settleQuotaContinuation(f.result, Promise.resolve());
      expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
      expect(f.result.meta.error?.message).toBe("Quota exhausted");
    },
  );

  it.each(["persisted", "runtime", "legacy", "layout"] as const)(
    "rejects a text caption with %s attachment facts",
    async (kind) => {
      const f = await fixture();
      onTestFinished(() => f.admission.close());
      const caption = { role: "user", content: "Earlier caption", timestamp: 0 };
      const media = [{ path: "/synthetic/private.png", contentType: "image/png" }];
      if (kind === "persisted") {
        Object.assign(caption, { __openclaw: { media } });
      }
      if (kind === "runtime") {
        attachRuntimePromptMediaFacts(caption, media);
      }
      if (kind === "layout") {
        Object.assign(caption, {
          __openclaw: { mediaImageLayout: { slots: [{ kind: "inline" }] } },
        });
      }
      if (kind === "legacy") {
        Object.assign(caption, { MediaPath: media[0]!.path, MediaType: "image/png" });
      }
      disk.messages.unshift(caption);
      f.offer();
      await settleQuotaContinuation(f.result, Promise.resolve());
      expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
    },
  );

  it.each(["azure-openai-responses", "openai-chatgpt-responses"])(
    "withholds continuation from the unproved %s transport",
    async (api) => {
      const f = await fixture();
      onTestFinished(() => f.admission.close());
      f.offer();
      await settleQuotaContinuation(f.result, Promise.resolve());
      const token = readQuotaContinuation(f.result, f.params, () => true)!;
      expect(() =>
        claimQuotaContinuation(token, { ...f.params, provider: "fallback" }, "openclaw", api),
      ).toThrow("exact admitted turn or fallback target");
    },
  );

  it("revalidates historical media and explicit destination image inputs at claim", async () => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    f.offer();
    await settleQuotaContinuation(f.result, Promise.resolve());
    const token = readQuotaContinuation(f.result, f.params, () => true)!;
    const next = { ...f.params, provider: "fallback-provider" };
    expect(() =>
      claimQuotaContinuation(
        token,
        { ...next, images: [{ type: "image", data: "synthetic", mimeType: "image/png" }] },
        "openclaw",
      ),
    ).toThrow();
    disk.messages.unshift({
      role: "user",
      content: [{ type: "image", data: "synthetic", mimeType: "image/png" }],
      timestamp: 0,
    });
    expect(() => claimQuotaContinuation(token, next, "openclaw")).toThrow();
  });

  it.each(["missing-result", "duplicate-result", "new-user", "changed-result"] as const)(
    "rejects %s durable transcript evidence",
    async (kind) => {
      const f = await fixture();
      onTestFinished(() => f.admission.close());
      if (kind === "missing-result") {
        disk.messages.pop();
      }
      if (kind === "duplicate-result") {
        disk.messages.push(disk.messages.at(-1));
      }
      if (kind === "new-user") {
        disk.messages.push({ role: "user", content: "Another request", timestamp: 3 });
      }
      if (kind === "changed-result") {
        disk.messages = [
          ...messages().slice(0, 2),
          { ...messages()[2], content: [{ type: "text", text: "different" }] },
        ];
      }
      f.offer();
      await settleQuotaContinuation(f.result, Promise.resolve());
      expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
    },
  );

  it.each([
    "async",
    "active",
    "approval",
    "yield",
    "client",
    "delivered",
    "model-pin",
    "profile-pin",
    "missing-evidence",
    "images",
    "media-facts",
  ] as const)("retains the quota veto for %s", async (kind) => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    if (kind === "async") {
      f.attempt.toolMetas[0]!.asyncStarted = true;
    }
    if (kind === "active") {
      f.attempt.itemLifecycle.activeCount = 1;
    }
    if (kind === "approval") {
      f.attempt.didSendDeterministicApprovalPrompt = true;
    }
    if (kind === "yield") {
      f.attempt.yieldDetected = true;
    }
    if (kind === "client") {
      f.attempt.clientToolCalls = [];
    }
    if (kind === "delivered") {
      f.attempt.didSendViaMessagingTool = true;
    }
    if (kind === "model-pin") {
      f.params.modelSelectionLocked = true;
    }
    if (kind === "profile-pin") {
      f.params.authProfileIdSource = "user";
    }
    if (kind === "missing-evidence") {
      delete f.attempt.settledQuotaContinuation;
    }
    if (kind === "images") {
      f.params.images = [{ type: "image", data: "synthetic", mimeType: "image/png" }];
    }
    if (kind === "media-facts") {
      f.params.media = [{ path: "/synthetic/private.png", contentType: "image/png" }];
    }
    f.offer();
    await settleQuotaContinuation(f.result, Promise.resolve());
    expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
    expect(f.result.meta.error?.message).toBe("Quota exhausted");
  });

  it.each(["abort", "close", "cleanup", "transcript"] as const)(
    "revalidates %s after awaited cleanup",
    async (kind) => {
      const f = await fixture();
      onTestFinished(() => f.admission.close());
      f.offer();
      if (kind === "abort") {
        f.abort.abort();
      }
      if (kind === "close") {
        f.admission.close();
      }
      if (kind === "transcript") {
        disk.messages = [];
      }
      await settleQuotaContinuation(
        f.result,
        kind === "cleanup" ? Promise.reject(new Error("cleanup failed")) : Promise.resolve(),
      );
      expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
    },
  );

  it("arms only the source logical-turn remainder in the successor's existing timeout owner", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    now = 990;
    f.offer();
    await settleQuotaContinuation(f.result, Promise.resolve());
    const token = readQuotaContinuation(f.result, f.params, () => true)!;
    claimQuotaContinuation(token, { ...f.params, provider: "fallback-provider" }, "openclaw");
    const abort = vi.fn();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: {
        runId: f.params.runId,
        sessionId: f.params.sessionId,
        timeoutMs: 1000,
        activeQuotaContinuation: token,
      },
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 1000,
      runAbortSignal: f.abort.signal,
      isProbeSession: true,
      abortRun: abort,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });
    onTestFinished(timeout.clearTimers);
    now = 1001;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(abort).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("rejects forged custody and foreign admissions", async () => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    f.offer();
    await settleQuotaContinuation(f.result, Promise.resolve());
    const token = readQuotaContinuation(f.result, f.params, () => true)!;
    const next = { ...f.params, provider: "fallback-provider" };
    expect(() =>
      claimQuotaContinuation({ kind: "settled-quota-continuation" }, next, "openclaw"),
    ).toThrow();
    expect(() =>
      claimQuotaContinuation(
        token,
        { ...next, admittedRunContext: { ...f.params.admittedRunContext! } },
        "openclaw",
      ),
    ).toThrow();
    expect(() => claimQuotaContinuation(token, next, "other-harness")).toThrow();
  });

  it("accepts the durable native text-result block and rejects a mismatched nested receipt", () => {
    const recorded = messages();
    const result = recorded[2];
    if (!result || result.role !== "toolResult" || !result.content[0]) {
      throw new Error("missing fixture result");
    }
    Object.assign(result.content[0], {
      type: "toolResult",
      id: "write-1",
      name: "write",
      toolName: "write",
      toolCallId: "write-1",
      toolUseId: "write-1",
      tool_use_id: "write-1",
      content: "one committed write",
    });
    expect(isSettledQuotaTranscript(recorded)).toBe(true);
    Reflect.set(result.content[0], "toolCallId", "foreign");
    expect(isSettledQuotaTranscript(recorded)).toBe(false);
  });

  it("does not convert malformed offer evidence into a thrown whole-turn retry", async () => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    Object.defineProperty(f.attempt.settledQuotaContinuation!, "messages", {
      get() {
        throw new Error("malformed evidence");
      },
    });
    expect(f.offer).not.toThrow();
    await settleQuotaContinuation(f.result, Promise.resolve());
    expect(readQuotaContinuation(f.result, f.params, () => true)).toBeUndefined();
    expect(f.result.meta.error?.message).toBe("Quota exhausted");
    expect(f.result.meta.error?.fallbackSafe).toBe(false);
    expect(f.result.meta.replayInvalid).toBe(true);
  });

  it.each(["content", "isError"] as const)(
    "rejects missing persisted result %s without throwing",
    (field) => {
      const recorded = messages();
      const result = recorded[2];
      if (!result) {
        throw new Error("missing fixture result");
      }
      Reflect.deleteProperty(result, field);
      expect(isSettledQuotaTranscript(recorded)).toBe(false);
    },
  );

  it("requires unique ordered call/result pairs across every batch", () => {
    const recorded = messages();
    expect(isSettledQuotaTranscript(recorded)).toBe(true);
    expect(isSettledQuotaTranscript([recorded[0]!, recorded[2]!, recorded[1]!])).toBe(false);
    expect(isSettledQuotaTranscript([...recorded, recorded[1]!, recorded[2]!])).toBe(false);
  });
});

describe("private admitted context and successor lineage", () => {
  it.each([
    "normal",
    "unowned",
    "rewritten",
    "duplicate-user",
    "duplicate-pair",
    "older-identical",
    "denied",
    "missing-call",
  ])("validates %s at the token owner, not the payload hook", async (kind) => {
    const f = await fixture();
    onTestFinished(() => f.admission.close());
    const older =
      kind === "older-identical" ? [{ role: "user", content: f.params.prompt, timestamp: 0 }] : [];
    disk.messages = [...older, ...disk.messages];
    f.offer();
    await settleQuotaContinuation(f.result, Promise.resolve());
    const token = readQuotaContinuation(f.result, f.params, () => true)!;
    claimQuotaContinuation(token, { ...f.params, provider: "fallback" }, "openclaw");
    const observe = bindQuotaContinuationSuccessor(token);
    const result = { content: [{ type: "text", text: "distinct successor result" }] };
    if (kind !== "unowned") {
      observe({
        toolCall: { id: "new", name: "read" },
        args: { path: "new" },
        result,
        isError: kind === "denied",
        executionStarted: kind !== "denied",
      });
    }
    result.content[0]!.text = "retained callback mutation";
    const suffix = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "new", name: "read", arguments: { path: "new" } }],
      },
      {
        role: "toolResult",
        toolCallId: "new",
        toolName: "read",
        isError: kind === "denied",
        content: [
          { type: "text", text: kind === "rewritten" ? "made up" : "distinct successor result" },
        ],
      },
    ];
    disk.messages.push(...(["denied", "missing-call"].includes(kind) ? suffix.slice(1) : suffix));
    const wire = {
      messages: [
        ...older,
        { role: "user", content: f.params.prompt },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "renamed-source",
              type: "function",
              function: { name: "write", arguments: '{"path":"counter"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "renamed-source", content: "one committed write" },
        { role: "user", content: "host instruction" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "renamed-new",
              type: "function",
              function: { name: "read", arguments: '{"path":"new"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "renamed-new",
          content: kind === "rewritten" ? "made up" : "distinct successor result",
        },
      ],
    };
    if (kind === "duplicate-user") {
      wire.messages.push({ role: "user", content: f.params.prompt });
    }
    if (kind === "duplicate-pair") {
      wire.messages.push(
        {
          role: "assistant",
          tool_calls: [
            {
              id: "renamed-duplicate",
              type: "function",
              function: { name: "write", arguments: '{"path":"counter"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "renamed-duplicate", content: "one committed write" },
      );
    }
    const check = () =>
      assertQuotaContinuationProviderPayload(token, wire, "openai-completions", "host instruction");
    if (kind === "normal" || kind === "older-identical" || kind === "denied") {
      expect(check).not.toThrow();
    } else {
      expect(check).toThrow(/continuation/i);
    }
  });
});

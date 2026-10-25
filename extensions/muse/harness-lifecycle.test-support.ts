import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "@muse-code/sdk";
import {
  onAgentEvent,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { waitForDiagnosticEventsDrained } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  runInHarnessToolAuthorityForTest,
  onTrustedInternalDiagnosticEvent,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi, type Mock } from "vitest";
import type { createMuseAgentHarness, MuseHarnessOptions, MuseSessionBinding } from "./harness.js";
import * as nativeEvents from "./src/events.js";

export function registerMuseLifecycleTests({
  setup,
  getWorkspace,
  fixture,
  writes,
  terminal,
  createHarness,
  createNativeHarness,
  readRequests,
}: {
  setup: (logRequests?: boolean) => {
    harness: ReturnType<typeof createMuseAgentHarness> & { dispose: () => Promise<void> };
    params: AgentHarnessAttemptParamsV2;
    events: Array<{ stream: string; data: Record<string, unknown> }>;
    sessionStore: MuseHarnessOptions["sessionStore"];
    bindings: Map<string, MuseSessionBinding>;
    log: string;
    run: (overrides?: Partial<AgentHarnessAttemptParamsV2>) => Promise<AgentHarnessAttemptResult>;
  };
  getWorkspace: () => string;
  fixture: string;
  writes: { append: Mock; publish: Mock };
  terminal: (result: AgentHarnessAttemptResult) => { kind: string };
  createHarness: typeof createMuseAgentHarness;
  createNativeHarness: typeof createMuseAgentHarness;
  readRequests: (
    log: string,
  ) => Promise<Array<{ method?: string; params?: Record<string, unknown> }>>;
}) {
  it("does not publish a deferred transcript group after internal joined timeout", async () => {
    const state = setup(true);
    await state.run();
    await state.harness.dispose();
    const binding = state.bindings.get(state.params.sessionId)!;
    state.bindings.set(state.params.sessionId, { ...binding, sessionId: "resumed-native-work" });
    const next = createHarness({ binaryPath: fixture, sessionStore: state.sessionStore });
    let started!: () => void, release!: () => void, finished!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const appendRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const journalFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    writes.append.mockImplementationOnce(async (params) => {
      started();
      await appendRelease;
      return params.messages;
    });
    writes.publish.mockClear();
    const record = nativeEvents.recordMuseTranscriptGroup;
    let rejected = false;
    const observed = vi
      .spyOn(nativeEvents, "recordMuseTranscriptGroup")
      .mockImplementation(async (...args) => {
        try {
          return await record(...args);
        } catch (error) {
          rejected = true;
          throw error;
        } finally {
          finished();
        }
      });
    try {
      const running = next.runAttempt({
        ...state.params,
        prompt: "hold-after-answer",
        timeoutMs: 150,
      });
      await appendStarted;
      const result = await running;
      expect(terminal(result).kind).toBe("timeout");
      release();
      await journalFinished;
      expect(rejected).toBe(true);
      expect(writes.publish).not.toHaveBeenCalled();
      expect(result.messagesSnapshot).toEqual([]);
    } finally {
      release();
      observed.mockRestore();
    }
  });

  it("keeps a prior completed answer out of a second observation of the same native turn", async () => {
    const state = setup(true);
    await state.run();
    await state.harness.dispose();
    const binding = state.bindings.get(state.params.sessionId)!;
    state.bindings.set(state.params.sessionId, { ...binding, sessionId: "resumed-native-work" });
    const next = createHarness({ binaryPath: fixture, sessionStore: state.sessionStore });
    const first = await next.runAttempt({
      ...state.params,
      prompt: "hold-after-answer",
      timeoutMs: 150,
    });
    expect(terminal(first).kind).toBe("timeout");
    expect(state.events).toContainEqual(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({ delta: "Earlier answer" }),
      }),
    );
    state.events.length = 0;
    writes.append.mockClear();
    const second = await next.runAttempt({
      ...state.params,
      runId: crypto.randomUUID(),
      prompt: "fresh-after-answer",
    });
    expect(terminal(second).kind).toBe("ok");
    expect(second.assistantTexts).toEqual(["Current answer"]);
    expect(
      state.events.filter((event) => event.stream === "assistant").map((event) => event.data.delta),
    ).toEqual(["Current answer"]);
    expect(second.messagesSnapshot).not.toContainEqual(
      expect.objectContaining({ content: [{ type: "text", text: "Earlier answer" }] }),
    );
    expect(writes.append.mock.calls.flatMap(([call]) => call.messages)).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ content: [{ type: "text", text: "Earlier answer" }] }),
      }),
    );
    const requests = await readRequests(state.log);
    expect(requests.filter((request) => request.method === "session/resume")).toHaveLength(1);
    expect(
      requests
        .filter((request) => request.method === "turn/start")
        .slice(-2)
        .every((request) => request.params?.ifBusy === "steer"),
    ).toBe(true);
  });

  it.each(["active", "detached", "revoked"] as const)(
    "native approval effects require the current observation (%s)",
    async (owner) => {
      const state = setup(true);
      await state.run();
      await state.harness.dispose();
      const binding = state.bindings.get(state.params.sessionId)!;
      state.bindings.set(state.params.sessionId, { ...binding, sessionId: "resumed-native-work" });
      const effect = join(getWorkspace(), `approval-effect-${crypto.randomUUID()}`);
      vi.stubEnv("MUSE_FIXTURE_EFFECT_PATH", effect);
      const next = createNativeHarness({
        binaryPath: fixture,
        sessionStore: state.sessionStore,
      });
      const controller = new AbortController();
      let handled!: () => void;
      const approvalHandled = new Promise<void>((resolve) => {
        handled = resolve;
      });
      let rejected!: () => void;
      const approvalRejected = new Promise<void>((resolve) => {
        rejected = resolve;
      });
      const approval = vi.fn(async () => {
        handled();
        if (owner === "revoked") {
          host.close();
        }
        return { decision: "allow-once" as const };
      });
      // Call the preserved SDK operation with its actual Session receiver below.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const registerApprovalError = Session.prototype.onApprovalError;
      const observedApprovalError = vi
        .spyOn(Session.prototype, "onApprovalError")
        .mockImplementation(function (this: Session, handler) {
          return registerApprovalError.call(this, (error) => {
            try {
              handler?.(error);
            } finally {
              handled();
              rejected();
            }
          });
        });
      const attempt = { ...state.params, runId: crypto.randomUUID() };
      const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "muse" });
      try {
        const result = await runInHarnessToolAuthorityForTest(
          { ...attempt, hostCapabilities: host.capabilities },
          "muse",
          (admitted) =>
            next.runAttempt({
              ...admitted,
              prompt: owner === "detached" ? "hold-then-approval" : "approval-native-work",
              abortSignal: controller.signal,
              hostCapabilities: { ...host.capabilities, requestApproval: approval },
              onExecutionStarted: () => {
                if (owner === "detached") {
                  controller.abort();
                }
              },
            }),
        );
        if (owner === "active") {
          expect(terminal(result).kind).toBe("ok");
          expect(await readFile(effect, "utf8")).toBe("approved native effect");
          expect(approval).toHaveBeenCalledTimes(1);
        } else if (owner === "revoked") {
          await approvalRejected;
          expect(() => host.capabilities.assertActive()).toThrow();
          expect(approval).toHaveBeenCalledTimes(1);
          expect(
            (await readRequests(state.log)).some((request) => request.method === "approval/decide"),
          ).toBe(false);
          await expect(readFile(effect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(terminal(result).kind).toBe("aborted");
          await vi.waitFor(async () => {
            expect(await readRequests(state.log)).toContainEqual({
              event: "late-approval-requested",
            });
          });
          // Observe the real SDK's handler/error callback, not an elapsed-time guess.
          await approvalHandled;
          // The production host is still live; releasing this model observation
          // must not let its cached handler borrow that wider host lifetime.
          expect(() => host.capabilities.assertActive()).not.toThrow();
          expect(approval).not.toHaveBeenCalled();
          await expect(readFile(effect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            (await readRequests(state.log)).some((request) => request.method === "approval/decide"),
          ).toBe(false);
          // A new owner must recover the same pending native approval stage.
          state.events.length = 0;
          const recovered = await runInHarnessToolAuthorityForTest(
            { ...state.params, runId: crypto.randomUUID() },
            "muse",
            (admitted) =>
              next.runAttempt({
                ...admitted,
                hostCapabilities: { ...state.params.hostCapabilities, requestApproval: approval },
              }),
          );
          expect(terminal(recovered)).toMatchObject({ kind: "ok" });
          expect(recovered.assistantTexts).toEqual(["resumed: hello"]);
          expect(
            state.events
              .filter((event) => event.stream === "assistant")
              .map((event) => event.data.delta)
              .join(""),
          ).toBe("resumed: hello");
          expect(await readFile(effect, "utf8")).toBe("approved native effect");
          expect(approval).toHaveBeenCalledTimes(1);
          const requests = await readRequests(state.log);
          expect(
            requests
              .filter((request) => request.method === "session/resume")
              .map((request) => request.params?.sessionId),
          ).toEqual(["resumed-native-work", "resumed-native-work"]);
          expect(
            requests
              .filter((request) => request.method === "approval/decide")
              .map((request) => request.params?.approvalId),
          ).toEqual(["native-approval"]);
        }
      } finally {
        host.close();
        observedApprovalError.mockRestore();
      }
    },
  );

  it("streams reasoning and text, journals native tool pairs, and resumes after restart", async () => {
    const workspace = getWorkspace();
    const first = setup();
    const prepareContinuationRetryCount = vi.fn();
    first.params.hostCapabilities = {
      ...first.params.hostCapabilities,
      prepareContinuationRetryCount,
    };
    const globalEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const toolActivity: Array<{ type: string; toolName: string }> = [];
    const progress = vi.fn();
    first.params.onRunProgress = progress;
    const stopDiagnostics = onTrustedInternalDiagnosticEvent((event) => {
      if (
        (event.type === "tool.execution.started" ||
          event.type === "tool.execution.completed" ||
          event.type === "tool.execution.error") &&
        event.runId === first.params.runId
      ) {
        toolActivity.push({ type: event.type, toolName: event.toolName });
      }
    });
    const unsubscribe = onAgentEvent((event) => void globalEvents.push(event));
    try {
      const result = await first.harness.runAttempt({ ...first.params, prompt: "tool" });
      expect(prepareContinuationRetryCount).toHaveBeenCalledExactlyOnceWith({
        cwd: await realpath(workspace),
      });
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["started: hello"]);
      for (const events of [first.events, globalEvents]) {
        expect(
          events
            .filter((event) => event.stream === "assistant")
            .map((event) => event.data.delta)
            .join(""),
        ).toBe("started: hello");
      }
      expect(globalEvents.at(0)?.data.phase).toBe("start");
      expect(globalEvents.at(-1)?.data.phase).toBe("end");
      expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
        "assistant",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(result.toolMetas).toEqual([{ toolName: "read_file" }]);
      await waitForDiagnosticEventsDrained();
      expect(toolActivity).toEqual([
        { type: "tool.execution.started", toolName: "read_file" },
        { type: "tool.execution.completed", toolName: "read_file" },
      ]);
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "muse:tool:started" }),
      );
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "muse:tool:completed" }),
      );
      expect(writes.append).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({ role: "toolResult", toolCallId: "call-1" }),
            }),
          ]),
        }),
      );
    } finally {
      unsubscribe();
      stopDiagnostics();
      await first.harness.dispose?.();
    }
    const resumed = createHarness({
      binaryPath: fixture,
      sessionStore: first.sessionStore,
    });
    try {
      const result = await resumed.runAttempt(first.params);
      expect(terminal(result).kind).toBe("ok");
      expect(result.assistantTexts).toEqual(["resumed: hello"]);
      const changed = await resumed.runAttempt({ ...first.params, modelId: "muse-other" });
      expect(changed.assistantTexts).toEqual(["started: hello"]);
    } finally {
      await resumed.dispose?.();
    }
  });
  it("does not report completed-first native history as current tool progress", async () => {
    const state = setup();
    const progress = vi.fn();
    const activity: string[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (
        (event.type === "tool.execution.started" ||
          event.type === "tool.execution.completed" ||
          event.type === "tool.execution.error") &&
        event.runId === state.params.runId
      ) {
        activity.push(event.type);
      }
    });
    try {
      const result = await state.harness.runAttempt({
        ...state.params,
        prompt: "tool-replay",
        onRunProgress: progress,
      });
      await waitForDiagnosticEventsDrained();
      expect(terminal(result).kind).toBe("ok");
      expect(result.toolMetas).toEqual([{ toolName: "read_file" }]);
      expect(activity).toEqual([]);
      expect(progress.mock.calls.map(([event]) => event.reason)).not.toContain("muse:tool:started");
      expect(progress.mock.calls.map(([event]) => event.reason)).not.toContain(
        "muse:tool:completed",
      );
    } finally {
      unsubscribe();
    }
  });
}

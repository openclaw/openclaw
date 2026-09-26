import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import {
  createStartedThreadHarness,
  createTestParams,
  extractRelayIdFromThreadRequest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
  it("bounds restored plan state after compaction", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: false,
    });
    const turnAccepted = createDeferred<void>();
    const params = createTestParams();
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        turnAccepted.resolve();
      }
    };
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await Promise.race([
      turnAccepted.promise,
      run.then(() => {
        throw new Error("Codex attempt ended before turn acceptance");
      }),
    ]);
    await harness.notify({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "e".repeat(10_000),
        plan: Array.from({ length: 100 }, (_, index) => ({
          step: `${index}: ${"x".repeat(2_000)}`,
          status: index === 0 ? "inProgress" : "pending",
        })),
      },
    });
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
    );

    const request = harness.requests.find((entry) => entry.method === "thread/inject_items");
    const text = (
      request?.params as { items?: Array<{ content?: Array<{ text?: string }> }> } | undefined
    )?.items?.[0]?.content?.[0]?.text;
    expect(text).toBeDefined();
    const payloadText = text?.slice((text?.indexOf("\n") ?? -1) + 1) ?? "";
    const payload = JSON.parse(payloadText) as {
      markdown?: string;
      plan: Array<{ step: string; status: string }>;
    };
    expect(Buffer.byteLength(payloadText, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(payload.markdown ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(payload.plan.length).toBeLessThanOrEqual(50);
    expect(payload.plan.every((step) => Buffer.byteLength(step.step, "utf8") <= 512)).toBe(true);
    expect(payload.plan[0]?.status).toBe("in_progress");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("continues the turn when restoring plan state after compaction fails", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: false,
    });
    const turnAccepted = createDeferred<void>();
    const params = createTestParams();
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        turnAccepted.resolve();
      }
    };
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/inject_items") {
        throw new Error("injected test failure");
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    await Promise.race([
      turnAccepted.promise,
      run.then(() => {
        throw new Error("Codex attempt ended before turn acceptance");
      }),
    ]);
    await harness.notify({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "Keep working",
        plan: [{ step: "Finish safely", status: "inProgress" }],
      },
    });
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
    );
    expect(harness.requests.map((request) => request.method)).toContain("thread/inject_items");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(readAttemptTerminal(result).promptError).toBeNull();
  });
});

describe("runCodexAppServerAttempt native lifecycle", () => {
  it("releases completion and native hook relay state after marker plus interrupted completion", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: false,
    });
    const turnAccepted = createDeferred<void>();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        turnAccepted.resolve();
      }
    };
    const run = runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true },
    });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await Promise.race([
      turnAccepted.promise,
      run.then(() => {
        throw new Error("Codex attempt ended before turn acceptance");
      }),
    ]);
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    await harness.notify(
      rawItemCompleted({
        id: "abort-marker-1",
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
          },
        ],
      }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeDefined();

    await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));

    const result = await run;
    expect(resolved).toBe(true);
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(readAttemptTerminal(result).timedOut).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(harness.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      }),
    ).rejects.toThrow("native hook relay not found");
    await nativeHookRelayUnregisterQueue.flush();
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });
});

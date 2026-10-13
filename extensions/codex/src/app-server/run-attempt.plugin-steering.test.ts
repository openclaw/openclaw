import assert from "node:assert/strict";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { startClockControlledAttempt } from "./run-attempt-lifecycle.test-support.js";
import {
  createStartedThreadHarness,
  createTestParams,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

const registrations = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof agentHarnessRuntime>();
  return {
    ...actual,
    setActiveEmbeddedRun: (...args: Parameters<typeof actual.setActiveEmbeddedRun>) => {
      registrations(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

setupRunAttemptTestHooks();

describe("plugin steering native admission", () => {
  it.each(["allowed", "disposed", "disabled"] as const)(
    "checks the plugin lifetime at native dispatch: %s",
    async (scenario) => {
      registrations.mockClear();
      const params = createTestParams();
      const builder = createPluginRegistry({
        runtime: createPluginRuntimeMock({ config: { current: () => params.config ?? {} } }),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
      const record = createPluginRecord({ id: "native-steering", origin: "bundled" });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, {
        config: params.config ?? {},
        hookPolicy: { allowPromptInjection: true },
      });
      setActivePluginRegistry(builder.registry);
      const steers: unknown[] = [];
      const harness = createStartedThreadHarness(
        async (method, input) => {
          if (method === "turn/steer") {
            steers.push(input);
          }
        },
        { persistedThreads: [] },
      );
      const { run, started } = startClockControlledAttempt(params);
      await started;
      const handle = registrations.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as Parameters<typeof agentHarnessRuntime.setActiveEmbeddedRun>[1] | undefined;
      assert(handle?.messageInjectionV2);
      const queued = vi.spyOn(handle.messageInjectionV2, "queueMessage");
      const admission = createDeferred<void>();
      const resume = createDeferred<void>();
      const requestSpy = vi.spyOn(harness.client, "request");
      const request = requestSpy.getMockImplementation();
      assert(request);
      requestSpy.mockImplementation(async (method, input, options) => {
        if (method === "turn/steer") {
          admission.resolve();
          await resume.promise;
        }
        const result = await request.call(harness.client, method, input, options);
        if (method === "turn/steer") {
          const steer = input as { clientUserMessageId: string };
          await harness.notify({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "plugin-guidance",
                type: "userMessage",
                clientId: steer.clientUserMessageId,
              },
            },
          });
        }
        return result;
      });
      let delivery: Promise<unknown> | undefined;
      try {
        if (scenario === "disabled") {
          record.enabled = false;
          await expect(
            api.session.workflow.steerActiveRun({
              sessionKey: params.sessionKey!,
              text: "Check the current result.",
            }),
          ).rejects.toThrow(/disabled|no longer loaded/);
          expect(queued).not.toHaveBeenCalled();
        } else {
          delivery = api.session.workflow.steerActiveRun({
            sessionKey: params.sessionKey!,
            text: "Check the current result.",
            idempotencyKey: "native-steering-guidance",
          });
          await admission.promise;
          const recorder = queued.mock.calls[0]?.[1]?.userTurnTranscriptRecorder;
          assert(recorder);
          expect(recorder.hasPersisted()).toBe(true);
          expect(recorder.getPersistedMessage?.()).toMatchObject({
            display: false,
            provenance: { kind: "internal_system", sourceTool: "plugin:native-steering" },
          });
          if (scenario === "disposed") {
            await disposePluginRegistryInstances(builder.registry);
          }
          resume.resolve();
          await expect(delivery).resolves.toEqual(
            scenario === "allowed"
              ? { steered: true, runId: params.runId }
              : { steered: false, reason: "runtime_rejected" },
          );
        }
        if (scenario === "allowed") {
          expect(steers).toHaveLength(1);
          expect(steers[0]).toMatchObject({
            expectedTurnId: "turn-1",
            input: [{ type: "text", text: "Check the current result." }],
          });
        } else {
          expect(steers).toHaveLength(0);
        }
        expect(handle.isAborted?.()).toBe(false);
      } finally {
        resume.resolve();
        await delivery;
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
        await disposePluginRegistryInstances(builder.registry);
      }
    },
  );
});

import assert from "node:assert/strict";
import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import { startClockControlledAttempt } from "./run-attempt-lifecycle.test-support.js";
import {
  createStartedThreadHarness,
  createTestParams,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof agentHarnessRuntime>();
  return { ...actual, setActiveEmbeddedRun: vi.fn(actual.setActiveEmbeddedRun) };
});

setupRunAttemptTestHooks();

it.each(["allowed", "disposed", "disabled", "accepted-disposed"] as const)(
  "checks the plugin lifetime at native dispatch: %s",
  async (scenario) => {
    const registrations = vi.mocked(agentHarnessRuntime.setActiveEmbeddedRun);
    registrations.mockClear();
    const params = createTestParams();
    const storePath = path.join(tempDir, "plugin-steering", "sessions.json");
    await attachSqliteSessionTarget(params, storePath, params.sessionId);
    (params.config ??= {}).session = { ...params.config?.session, store: storePath };
    const loadPlugin = () => {
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
      return { api, record, registry: builder.registry };
    };
    let plugin = loadPlugin();
    const text = "Check the current result.";
    const idempotencyKey = "native-steering-guidance";
    const steer = (deduplicate = true) =>
      plugin.api.session.workflow.steerActiveRun({
        sessionKey: params.sessionKey!,
        text,
        ...(deduplicate ? { idempotencyKey } : {}),
      });
    const dispatchedSteers: unknown[] = [];
    const harness = createStartedThreadHarness(
      async (method, input) => {
        if (method === "turn/steer") {
          dispatchedSteers.push(input);
        }
      },
      { persistedThreads: [] },
    );
    const steers = () => dispatchedSteers;
    const { run, started } = startClockControlledAttempt(params);
    await started;
    const handle = registrations.mock.calls.findLast((call) => call[0] === params.sessionId)?.[1];
    assert(handle?.messageInjectionV2);
    const queued = vi.spyOn(handle.messageInjectionV2, "queueMessageAsync");
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
        if (scenario === "accepted-disposed") {
          await disposePluginRegistryInstances(plugin.registry);
        }
        const receipt = input as { clientUserMessageId: string };
        await harness.notify(
          itemNotification("item/completed", {
            id: "plugin-guidance",
            type: "userMessage",
            clientId: receipt.clientUserMessageId,
          }),
        );
      }
      return result;
    });
    let delivery: Promise<unknown> | undefined;
    try {
      if (scenario === "disabled") {
        plugin.record.enabled = false;
        await expect(steer(false)).rejects.toThrow(/disabled|no longer loaded/);
        expect(queued).not.toHaveBeenCalled();
      } else {
        delivery = steer();
        await admission.promise;
        const recorder = queued.mock.calls[0]?.[1]?.userTurnTranscriptRecorder;
        assert(recorder);
        expect.soft(recorder.hasPersisted()).toBe(false);
        if (scenario === "disposed") {
          await disposePluginRegistryInstances(plugin.registry);
        }
        resume.resolve();
        await expect(delivery).resolves.toEqual(
          scenario === "disposed"
            ? { steered: false, reason: "runtime_rejected" }
            : { steered: true, runId: params.runId },
        );
        if (scenario === "disposed") {
          expect(steers()).toHaveLength(0);
          expect
            .soft(await readTranscriptMessagesByIdentity(params))
            .not.toContainEqual(expect.objectContaining({ idempotencyKey }));
          assert(params.sessionTarget?.agentId && params.sessionKey);
          const context = await SessionManager.openModelContextAsync({
            agentId: params.sessionTarget.agentId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            storePath,
          });
          expect
            .soft(context.buildSessionContext().messages)
            .not.toContainEqual(expect.objectContaining({ content: text }));
          plugin = loadPlugin();
          await expect(steer()).resolves.toEqual({ steered: true, runId: params.runId });
        }
      }
      if (scenario !== "disabled") {
        expect(steers()).toMatchObject([
          { expectedTurnId: "turn-1", input: [{ type: "text", text }] },
        ]);
        expect(
          (await readTranscriptMessagesByIdentity(params)).filter(
            (message) => message.idempotencyKey === idempotencyKey,
          ),
        ).toEqual([expect.objectContaining({ content: text, display: false })]);
      } else {
        expect(steers()).toHaveLength(0);
      }
      expect(handle.isAborted?.()).toBe(false);
    } finally {
      resume.resolve();
      await delivery;
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      await disposePluginRegistryInstances(plugin.registry);
    }
  },
);

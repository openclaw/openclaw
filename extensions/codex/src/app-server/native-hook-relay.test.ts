// Codex tests cover native hook relay plugin behavior.
import type { NativeHookRelayRegistrationHandle } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCodexNativeHookRelayAllowed,
  buildCodexNativeHookRelayConfig,
  buildCodexNativeHookRelayDisabledConfig,
  emitCodexNativePreToolUseFailureDiagnostic,
} from "./native-hook-relay.js";
import type { NativeModelSource } from "./native-subagent-monitor-types.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  directSpawnItem,
  notifyChildStarted,
  successfulSendInputOutput,
  turnStartedNotification,
  threadRead,
  CodexNativeSubagentMonitor,
  createNativeModelSourceFixture as modelSource,
  requireNativeModelSourceCapture as requireCapture,
} from "./native-subagent-monitor.test-support.js";

afterEach(() => resetDiagnosticEventsForTest());

function flushDiagnosticEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("Codex native hook relay managed policy", () => {
  it.each([
    ["idle", false, true, false],
    ["notLoaded", false, false, false],
    ["notLoaded", true, true, false],
    ["notLoaded", false, true, true],
  ] as const)(
    "qualifies the actual warm/cold provider before native input (%s, projected=%s, accepted=%s, System=%s)",
    async (status, projected, accepted, system) => {
      const client = createClient();
      const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
        recoveryPollDelaysMs: [],
      });
      const oldConfiguration = {
        assertCurrent: () => {},
        hasProvider: (provider: string) => provider === "provider-q",
      };
      const newConfiguration = {
        assertCurrent: () => {},
        hasProvider: (provider: string) =>
          provider === "provider-p" || (projected && provider === "provider-q"),
      };
      const original = monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource: modelSource(["model-a"]),
        configurationQualification: oldConfiguration,
      });
      original.bindTurn("parent-a");
      await notifyChildStarted(client);
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-a",
          item: directSpawnItem("v2", "parent-thread", "child-thread"),
        },
      });
      await client.notify(turnStartedNotification("child-a"));
      await client.notify(
        childTurnCompletedNotification({
          turnId: "child-a",
          status: "completed",
          items: [{ type: "agentMessage", id: "a-final", text: "A finished" }],
        }),
      );
      const target = threadRead({ threadStatus: status });
      target.thread.modelProvider = "provider-q";
      client.setThreadRead("child-thread", target);
      const next = monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource: system ? undefined : modelSource(["model-b"]),
        configurationQualification: newConfiguration,
      });
      next.bindTurn("parent-b");
      const nativeWrite = vi.fn();
      const admission = monitor
        .prepareModelInput({
          threadId: "parent-thread",
          turnId: "parent-b",
          itemId: "cold-followup",
          target: "child-thread",
          readQualification: () => newConfiguration,
          assertCurrent: () => {},
        })
        .then(nativeWrite);
      try {
        if (accepted) {
          await admission;
          expect(nativeWrite).toHaveBeenCalledOnce();
        } else {
          await expect(admission).rejects.toThrow("does not admit this model");
          expect(nativeWrite).not.toHaveBeenCalled();
        }
        expect(monitor.resolveModelThreadId("child-a")).toBeUndefined();
      } finally {
        await original.unregister();
        await next.unregister();
        monitor.dispose();
      }
    },
  );

  it.each(["native load", "routing replacement", "unknown active"] as const)(
    "refuses an unqualified receiver read after %s",
    async (change) => {
      const client = createClient();
      const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
        recoveryPollDelaysMs: [],
      });
      const qualification = { assertCurrent: () => {}, hasProvider: () => true };
      let targetQualification: typeof qualification | undefined;
      const source = modelSource(["model-b"]);
      const parent = monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource:
          change === "unknown active"
            ? {
                ...source,
                modelPolicyRequired: false,
                bindModelExecution: () => ({
                  signal: new AbortController().signal,
                  assertCurrent: source.assertCurrent,
                  release: () => {},
                }),
              }
            : source,
        configurationQualification: qualification,
      });
      parent.bindTurn("parent-b");
      const threadId = "00000000-0000-4000-8000-000000000042";
      const entered = createDeferred<void>();
      const returned = createDeferred<ReturnType<typeof threadRead>>();
      client.setThreadReadFactory(threadId, () => {
        entered.resolve();
        return returned.promise;
      });
      const nativeWrite = vi.fn();
      const pending = monitor
        .prepareModelInput({
          threadId: "parent-thread",
          turnId: "parent-b",
          itemId: "restore",
          target: threadId,
          readQualification: () => targetQualification,
          assertCurrent: () => {},
        })
        .then(nativeWrite);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Input admission finished before target read");
          }),
        ]);
        if (change === "native load") {
          await notifyChildStarted(client, "parent-thread", threadId);
        } else if (change === "routing replacement") {
          targetQualification = { assertCurrent: () => {}, hasProvider: () => false };
        }
        const stale = threadRead({
          childThreadId: threadId,
          threadStatus: change === "unknown active" ? "active" : "notLoaded",
        });
        stale.thread.modelProvider = "unqualified-provider";
        returned.resolve(stale);
        await expect(pending).rejects.toThrow(
          change === "unknown active"
            ? "receiver's exact admitted execution"
            : "receiver changed during input preparation",
        );
        expect(nativeWrite).not.toHaveBeenCalled();
      } finally {
        monitor.dispose();
        await parent.unregister();
      }
    },
  );

  it("waits for the exact issued root binding and distinguishes unknown from explicit System", async () => {
    const client = createClient();
    const foreign = createClient();
    const source = modelSource(["model-a"]);
    const parent = codexNativeSubagentMonitorRuntime.register({
      client: client.client,
      parentThreadId: "parent-thread",
      modelSource: source,
    });
    const request = { client: client.client, threadId: "parent-thread", turnId: "turn-a" };
    const pending = codexNativeSubagentMonitorRuntime.captureModelSource(request);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const mapping = {
      nativeModel: { provider: "test-provider", model: "wire-a" },
      authorizedModel: { provider: "test-provider", model: "model-a" },
    };
    parent.bindTurn("turn-a", mapping);
    parent.bindTurn("turn-a");
    expect(
      codexNativeSubagentMonitorRuntime.resolveModelThreadId({
        client: client.client,
        turnId: "turn-a",
      }),
    ).toBe("parent-thread");
    expect(
      codexNativeSubagentMonitorRuntime.resolveModelThreadId({
        client: foreign.client,
        turnId: "turn-a",
      }),
    ).toBeUndefined();
    const ambiguous = codexNativeSubagentMonitorRuntime.register({
      client: client.client,
      parentThreadId: "other-root-with-unknown-source",
    });
    ambiguous.bindTurn("turn-a");
    expect(
      codexNativeSubagentMonitorRuntime.resolveModelThreadId({
        client: client.client,
        turnId: "turn-a",
      }),
    ).toBeUndefined();
    await ambiguous.unregister();
    const captured = requireCapture(await pending);
    expect(captured.modelMapping).toEqual(mapping);
    expect(
      captured.source?.bindModelExecution?.({ provider: "test-provider", model: "model-a" }),
    ).toBeDefined();
    captured.recordNativeReviewRequirement(true);
    const pendingReview = requireCapture(
      await codexNativeSubagentMonitorRuntime.captureModelSource(request),
    );
    await client.notify({
      method: "turn/completed",
      params: {
        threadId: "parent-thread",
        turn: { id: "turn-a", status: "completed", items: [] },
      },
    });
    expect(await codexNativeSubagentMonitorRuntime.captureModelSource(request)).toBeUndefined();
    expect(
      codexNativeSubagentMonitorRuntime.resolveModelThreadId({
        client: client.client,
        turnId: "turn-a",
      }),
    ).toBeUndefined();
    expect(pendingReview.nativeReviewRequired).toBe(true);
    expect(() => pendingReview.assertCurrent()).not.toThrow();
    pendingReview.release();
    await parent.unregister();
    expect(() => captured.assertCurrent()).not.toThrow();
    expect(source.release).not.toHaveBeenCalled();
    expect(
      await codexNativeSubagentMonitorRuntime.captureModelSource({
        ...request,
        client: foreign.client,
      }),
    ).toBeUndefined();
    captured.release();
    expect(source.release).toHaveBeenCalledOnce();
    expect(() => captured.assertCurrent()).toThrow("released");

    const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime(), {
      recoveryPollDelaysMs: [],
    });
    const unknown = monitor.registerParent({ parentThreadId: "unknown" });
    unknown.bindTurn("unknown-turn");
    expect(
      await monitor.captureModelSource({ threadId: "unknown", turnId: "unknown-turn" }),
    ).toBeUndefined();
    const system = monitor.registerParent({ parentThreadId: "system", modelSource: undefined });
    system.bindTurn("system-turn");
    const systemCapture = requireCapture(
      await monitor.captureModelSource({ threadId: "system", turnId: "system-turn" }),
    );
    expect(systemCapture.source).toBeUndefined();
    systemCapture.release();
    await system.unregister();
    const aborted = new AbortController();
    const waiting = monitor.registerParent({ parentThreadId: "waiting", modelSource: undefined });
    const abortedCapture = monitor.captureModelSource({
      threadId: "waiting",
      turnId: "never-bound",
      signal: aborted.signal,
    });
    aborted.abort(new Error("capture stopped"));
    await expect(abortedCapture).rejects.toThrow("capture stopped");
    await client.notify({
      method: "turn/completed",
      params: {
        threadId: "waiting",
        turn: { id: "completed-before-binding", status: "completed" },
      },
    });
    waiting.bindTurn("completed-before-binding");
    expect(
      await monitor.captureModelSource({
        threadId: "waiting",
        turnId: "completed-before-binding",
      }),
    ).toBeUndefined();
    waiting.bindTurn("next-turn");
    const nextTurn = requireCapture(
      await monitor.captureModelSource({
        threadId: "waiting",
        turnId: "next-turn",
      }),
    );
    nextTurn.release();
    await waiting.unregister();
    await unknown.unregister();
    monitor.dispose();
  });

  it.each(["receipt first", "notification first", "active predecessor"] as const)(
    "retains only the exact V1 Started model grant after foreground closure (%s)",
    async (order) => {
      const client = createClient();
      const qualification = {
        assertCurrent: () => {},
        hasProvider: (provider: string) => provider === "test-provider",
      };
      const target = threadRead({
        turnId: "child-a",
        threadStatus: order === "active predecessor" ? "active" : "idle",
        status: order === "active predecessor" ? "inProgress" : "completed",
      });
      target.thread.modelProvider = "test-provider";
      client.setThreadRead("child-thread", target);
      const bindModelExecution: NonNullable<NativeModelSource["bindModelExecution"]> = (model) => {
        if (
          model?.provider !== "test-provider" ||
          !["catalog-a", "catalog-b"].includes(model.model)
        ) {
          throw new Error("Test source cannot use this model");
        }
        return { signal: new AbortController().signal, assertCurrent: () => {}, release: () => {} };
      };
      const a = {
        sourceIdentity: {},
        modelPolicyRequired: true,
        bindModelExecution,
        assertCurrent: vi.fn(),
        release: vi.fn(),
      };
      const b = {
        ...a,
        sourceIdentity: order === "active predecessor" ? a.sourceIdentity : {},
        release: vi.fn(),
      };
      const mappingA = {
        nativeModel: { provider: "test-provider", model: "wire-a" },
        authorizedModel: { provider: "test-provider", model: "catalog-a" },
      };
      const mappingB = {
        nativeModel: { provider: "test-provider", model: "wire-b" },
        authorizedModel: { provider: "test-provider", model: "catalog-b" },
      };
      const monitor = new codexNativeSubagentMonitorRuntime.Monitor(
        client.client,
        createRuntime(),
        {
          recoveryPollDelaysMs: [],
        },
      );
      const first = monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource: a,
        configurationQualification: qualification,
      });
      first.bindTurn("parent-a", mappingA);
      await notifyChildStarted(client);
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-a",
          item: directSpawnItem("v1", "parent-thread", "child-thread"),
        },
      });
      await client.notify(turnStartedNotification("child-a"));
      const original = await monitor.captureModelSource({
        threadId: "child-thread",
        turnId: "child-a",
        parentThreadId: "parent-thread",
        parentTurnId: "parent-a",
        rootTurnId: "parent-a",
      });
      if (!original) {
        throw new Error("Missing original child model source");
      }
      const completeOriginal = () =>
        client.notify(
          childTurnCompletedNotification({
            turnId: "child-a",
            status: "completed",
            items: [{ type: "agentMessage", id: "a-final", text: "A finished" }],
          }),
        );
      if (order !== "active predecessor") {
        await completeOriginal();
      }
      const second = monitor.registerParent({
        parentThreadId: "parent-thread",
        modelSource: b,
        configurationQualification: qualification,
      });
      second.bindTurn("parent-b", mappingB);
      await monitor.prepareModelInput({
        threadId: "parent-thread",
        turnId: "parent-b",
        itemId: "start-b",
        target: "child-thread",
        readQualification: () => qualification,
        assertCurrent: () => {},
      });
      const controller = new AbortController();
      const request = {
        threadId: "child-thread",
        turnId: "child-b",
        parentThreadId: "parent-thread",
        parentTurnId: "parent-b",
        rootTurnId: "parent-b",
        signal: controller.signal,
      };
      let capture: Awaited<ReturnType<typeof monitor.captureModelSource>>;
      try {
        if (order === "notification first") {
          await client.notify(turnStartedNotification("child-b"));
        }
        const pending = monitor.captureModelSource(request);
        void pending.catch(() => {});
        await client.notify(
          successfulSendInputOutput({
            turnId: "parent-b",
            callId: "start-b",
            submissionId: "child-b",
          }),
        );
        await first.unregister();
        await second.unregister();
        capture = await pending;
        if (!capture) {
          throw new Error("The exact accepted V1 model source was dropped");
        }
        expect(capture.source).toBe(b);
        expect(capture.modelMapping).toEqual(mappingB);
        expect(monitor.resolveModelThreadId("child-b")).toBe("child-thread");
        const imageCapture = await monitor.captureModelSource({
          threadId: "child-thread",
          turnId: "child-b",
        });
        expect(imageCapture?.source).toBe(b);
        imageCapture?.release();
        expect(original.modelMapping).toEqual(mappingA);
        expect(original.assertCurrent).not.toThrow();
        expect(b.release).not.toHaveBeenCalled();
        if (order === "receipt first") {
          const pendingTarget = threadRead({
            turnId: "child-b",
            threadStatus: "active",
            status: "inProgress",
          });
          pendingTarget.thread.modelProvider = "test-provider";
          client.setThreadRead("child-thread", pendingTarget);
          const foreign = monitor.registerParent({
            parentThreadId: "parent-thread",
            modelSource: { ...b, sourceIdentity: {}, release: vi.fn() },
            configurationQualification: qualification,
          });
          foreign.bindTurn("foreign-turn");
          await expect(
            monitor.prepareModelInput({
              threadId: "parent-thread",
              turnId: "foreign-turn",
              itemId: "steer-pending-model",
              target: "child-thread",
              readQualification: () => qualification,
              assertCurrent: () => {},
            }),
          ).rejects.toThrow("same admitted model source");
          await foreign.unregister();
        }
        if (order === "active predecessor") {
          await completeOriginal();
        }
        if (order !== "notification first") {
          await client.notify(turnStartedNotification("child-b"));
        }
        expect(
          await monitor.captureModelSource({ ...request, turnId: "unrelated-turn" }),
        ).toBeUndefined();
        expect(capture.assertCurrent).not.toThrow();
      } finally {
        controller.abort();
        capture?.release();
        original.release();
        await first.unregister();
        await second.unregister();
        monitor.dispose();
      }
      expect(b.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: "absent requirements", response: { requirements: null } },
    { name: "ordinary hooks", response: { requirements: { allowManagedHooksOnly: false } } },
  ])("rechecks managed policy after accepting $name", async ({ response }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ requirements: { allowManagedHooksOnly: true } });
    const client = { request };

    await assertCodexNativeHookRelayAllowed(client as never);
    await expect(assertCodexNativeHookRelayAllowed(client as never)).rejects.toThrow(
      /managed-only hooks.*OpenClaw native hook relay/i,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("configRequirements/read", undefined, {
      signal: undefined,
    });
  });

  it.each([
    { name: "missing response", response: {} },
    { name: "invalid requirements", response: { requirements: [] } },
    { name: "invalid managed hook flag", response: { requirements: { allowManagedHooksOnly: 1 } } },
  ])("fails closed on $name and allows a corrected retry", async ({ response }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ requirements: null });
    const client = { request };

    await expect(assertCodexNativeHookRelayAllowed(client as never)).rejects.toThrow(/invalid/i);
    await expect(assertCodexNativeHookRelayAllowed(client as never)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("Codex native hook relay config", () => {
  it("builds deterministic Codex config overrides with command hooks", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      hookTimeoutSec: 7,
    });

    expect(config).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event post_tool_use --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event before_agent_finalize --timeout 6000",
              timeout: 7,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:post_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:stop:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("timeoutSec");
    expect(JSON.stringify(config)).not.toContain('"matcher":null');
    expect(config).not.toHaveProperty("hooks.SessionStart");
    expect(config).not.toHaveProperty("hooks.UserPromptSubmit");
  });

  it("includes only requested hook events", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 9000",
              timeout: 10,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.state": {
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears requested hook events when the relay reports no local work", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ inactiveEvents: ["post_tool_use", "before_agent_finalize"] }),
        events: ["pre_tool_use", "post_tool_use", "before_agent_finalize"],
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event pre_tool_use --timeout 9000",
              timeout: 10,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.PostToolUse": [],
      "hooks.Stop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:pre_tool_use:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("clears selected PreToolUse when the relay has no local work", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay({ inactiveEvents: ["pre_tool_use"] }),
      events: ["pre_tool_use"],
    });

    expect(config).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [],
      "hooks.state": {},
    });
  });

  it("clears omitted hook events when requested", () => {
    expect(
      buildCodexNativeHookRelayConfig({
        relay: createRelay(),
        events: ["permission_request"],
        clearOmittedEvents: true,
      }),
    ).toEqual({
      "features.hooks": true,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [
        {
          hooks: [
            {
              type: "command",
              command:
                "openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event permission_request --timeout 9000",
              timeout: 10,
              async: false,
              statusMessage: "OpenClaw native hook relay",
            },
          ],
        },
      ],
      "hooks.Stop": [],
      "hooks.state": {
        "/<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:pre_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "<session-flags>/config.toml:post_tool_use:0:0": { enabled: false },
        "/<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "<session-flags>/config.toml:permission_request:0:0": {
          enabled: true,
          trusted_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        "/<session-flags>/config.toml:stop:0:0": { enabled: false },
        "<session-flags>/config.toml:stop:0:0": { enabled: false },
      },
    });
  });

  it("omits matchers so Codex MCP tool names reach the relay with a stable trust hash", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay(),
      events: ["pre_tool_use", "post_tool_use"],
    });

    expect((config["hooks.PreToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
    expect((config["hooks.PostToolUse"] as Array<{ matcher?: unknown }>)[0]).not.toHaveProperty(
      "matcher",
    );
    const hookState = config["hooks.state"] as Record<
      string,
      { enabled: boolean; trusted_hash: string }
    >;
    expect(hookState["/<session-flags>/config.toml:pre_tool_use:0:0"]?.trusted_hash).toBe(
      "sha256:00eef2fb113075f6aa238484c41e5eac82830c98c6379611019592ad93d2e56b",
    );
    expect(hookState["/<session-flags>/config.toml:post_tool_use:0:0"]?.trusted_hash).toBe(
      "sha256:64b626a7cee798d42404b892982925feda7b335a9cd0ed62be905ab2e2766c1f",
    );
  });

  it("projects canonical OpenClaw ids to Codex canonical and alias matcher names", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay({
        matchers: {
          pre_tool_use: ["exec"],
          post_tool_use: ["apply_patch", "spawn_agent"],
        },
      }),
      events: ["pre_tool_use", "post_tool_use"],
    });

    expect(config["hooks.PreToolUse"]).toEqual([
      expect.objectContaining({ matcher: "Bash|exec|exec_command" }),
    ]);
    expect(config["hooks.PostToolUse"]).toEqual([
      expect.objectContaining({ matcher: "Agent|Edit|Write|apply_patch|spawn_agent" }),
    ]);
    expect(JSON.stringify(config)).not.toContain("web_search");
  });

  it("matches custom Codex tool names case-insensitively without widening the scope", () => {
    const config = buildCodexNativeHookRelayConfig({
      relay: createRelay({ matchers: { pre_tool_use: ["deploy"] } }),
      events: ["pre_tool_use"],
    });

    expect(config["hooks.PreToolUse"]).toEqual([
      expect.objectContaining({ matcher: "(?i)^(?:deploy)$" }),
    ]);
  });

  it("rejects an empty canonical matcher scope instead of widening to match-all", () => {
    expect(() =>
      buildCodexNativeHookRelayConfig({
        relay: createRelay({ matchers: { pre_tool_use: [] } }),
        events: ["pre_tool_use"],
      }),
    ).toThrow("Codex native hook matcher requires at least one tool name");
  });

  it("builds deterministic clearing config when the relay is disabled", () => {
    expect(buildCodexNativeHookRelayDisabledConfig()).toEqual({
      "features.hooks": false,
      "hooks.PreToolUse": [],
      "hooks.PostToolUse": [],
      "hooks.PermissionRequest": [],
      "hooks.Stop": [],
    });
  });

  it.each([
    { reason: "turn_progress_idle_timeout", terminalReason: "timed_out" },
    { reason: "turn_completion_idle_timeout", terminalReason: "timed_out" },
    { reason: "turn_terminal_idle_timeout", terminalReason: "timed_out" },
    { reason: "client_closed", terminalReason: "failed" },
  ] as const)(
    "projects native pre-tool failure reason $reason without a Codex item",
    async ({ reason, terminalReason }) => {
      const controller = new AbortController();
      controller.abort(reason);
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));
      try {
        emitCodexNativePreToolUseFailureDiagnostic({
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          signal: controller.signal,
          failure: {
            toolName: "exec",
            toolCallId: "native-no-item",
            disposition: "cancelled",
            durationMs: 5,
          },
        });
        await flushDiagnosticEvents();
      } finally {
        unsubscribe();
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.error",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          toolName: "exec",
          toolCallId: "native-no-item",
          durationMs: 5,
          errorCategory: "before_tool_call",
          terminalReason,
        }),
      );
    },
  );
});

function createRelay(options?: {
  inactiveEvents?: readonly NativeHookRelayRegistrationHandle["allowedEvents"][number][];
  matchers?: Partial<
    Record<
      NativeHookRelayRegistrationHandle["allowedEvents"][number],
      readonly string[] | undefined
    >
  >;
}): NativeHookRelayRegistrationHandle {
  const inactiveEvents = new Set(options?.inactiveEvents ?? []);
  return {
    relayId: "relay-1",
    provider: "codex",
    generation: "generation-1",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    allowedEvents: ["pre_tool_use", "post_tool_use", "permission_request", "before_agent_finalize"],
    expiresAtMs: Date.now() + 1000,
    shouldRelayEvent: (event) => !inactiveEvents.has(event),
    toolMatcherForEvent: (event) => options?.matchers?.[event],
    commandForEvent: (event, commandOptions) =>
      `openclaw hooks relay --provider codex --relay-id relay-1 --generation generation-1 --event ${event}${
        event === "pre_tool_use" && inactiveEvents.has(event)
          ? " --pre-tool-use-unavailable noop"
          : ""
      }${commandOptions?.timeoutMs ? ` --timeout ${commandOptions.timeoutMs}` : ""}`,
    renew: () => undefined,
    unregister: () => undefined,
  };
}

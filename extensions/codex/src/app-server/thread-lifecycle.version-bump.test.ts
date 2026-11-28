import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentPendingAssignment } from "./native-subagent-pending-assignments.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import {
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";
import {
  prepareCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import {
  buildCodexPluginThreadConfigInputFingerprint,
  buildPluginAppPolicyContext,
} from "./plugin-thread-config.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import {
  createCodexTestBindingStateStore,
  createCodexTestBindingStore,
} from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetThreadLifecycleTestFixtures);

const DEFAULT_WEB_SEARCH_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "cached",
});

describe("local thread custody across Gateway restarts with Codex version bumps", () => {
  it.each(["version-invariant", "legacy-persisted"] as const)(
    "resumes the existing local thread after a 0.172.0 -> 0.172.1 restart (%s binding)",
    async (bindingFormat) => {
      const cwd = tempDirs.make("codex-version-bump-resume-");
      const codexHome = path.join(cwd, "codex-home");
      const params = createParams(path.join(cwd, "session.jsonl"), cwd);
      params.disableTools = false;
      params.agentId = "main";
      const appServer = {
        ...createAppServerOptions(),
        connectionClass: "local-loopback" as const,
      };
      const v172_0 = buildCodexAppServerRuntimeFingerprint({
        appServer,
        appServerVersion: "0.172.0",
        runtimeIdentity: {
          serverVersion: "0.172.0",
          userAgent: "openclaw/0.172.0 (linux)",
          codexHome,
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      const v172_1 = buildCodexAppServerRuntimeFingerprint({
        appServer,
        appServerVersion: "0.172.1",
        runtimeIdentity: {
          serverVersion: "0.172.1",
          userAgent: "openclaw/0.172.1 (linux)",
          codexHome,
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      const storedFingerprint =
        bindingFormat === "legacy-persisted"
          ? JSON.stringify({
              ...JSON.parse(v172_0),
              appServerVersion: "0.172.0",
              runtimeIdentity: {
                serverVersion: "0.172.0",
                userAgent: "openclaw/0.172.0 (linux)",
                codexHome,
                platformFamily: "unix",
                platformOs: "linux",
              },
            })
          : v172_0;

      const pluginStartupPolicy = resolveCodexPluginThreadConfigStartupPolicy({
        pluginConfig: {},
        nativeToolSurfaceEnabled: false,
      });
      const appCacheKeyV0 = buildCodexPluginAppCacheKey({
        appServer,
        appServerVersion: "0.172.0",
        runtimeIdentity: {
          serverVersion: "0.172.0",
          userAgent: "openclaw/0.172.0 (linux)",
          codexHome,
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      const appCacheKeyV1 = buildCodexPluginAppCacheKey({
        appServer,
        appServerVersion: "0.172.1",
        runtimeIdentity: {
          serverVersion: "0.172.1",
          userAgent: "openclaw/0.172.1 (linux)",
          codexHome,
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      const pluginProviderV0 = prepareCodexPluginThreadConfigStartupProvider({
        startupPolicy: pluginStartupPolicy,
        appCacheKey: appCacheKeyV0,
        connectionClass: "local-loopback",
      })!;
      const pluginProviderV1 = prepareCodexPluginThreadConfigStartupProvider({
        startupPolicy: pluginStartupPolicy,
        appCacheKey: appCacheKeyV1,
        connectionClass: "local-loopback",
      })!;
      const storedPluginAppsInputFingerprint =
        bindingFormat === "legacy-persisted"
          ? buildCodexPluginThreadConfigInputFingerprint({
              policy: pluginStartupPolicy.resolvedPluginPolicy!,
              appCacheKey: appCacheKeyV0,
            })
          : pluginProviderV0({
              requestTimeoutMs: 5_000,
              signal: new AbortController().signal,
              client: { request: async () => ({}) },
            }).inputFingerprint;

      const store = createCodexTestBindingStore();
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      };
      const existingThreadId = "thread-existing-local";
      await store.mutate(identity, {
        kind: "set",
        binding: {
          threadId: existingThreadId,
          cwd,
          model: params.modelId,
          modelProvider: "openai",
          webSearchThreadConfigFingerprint: DEFAULT_WEB_SEARCH_FINGERPRINT,
          appServerRuntimeFingerprint: storedFingerprint,
          pluginAppsFingerprint: "plugin-apps-v0",
          pluginAppsInputFingerprint: storedPluginAppsInputFingerprint,
          pluginAppPolicyContext: buildPluginAppPolicyContext({}, {}),
        },
      });

      const wire = await createLeasedCodexLifecycleHarness({
        agentDir: cwd,
        persistedThreads: [existingThreadId],
        respond: async (method) => {
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "thread/read") {
            return {
              thread: {
                ...threadStartResult(existingThreadId, cwd).thread,
                status: { type: "notLoaded" },
              },
            };
          }
          if (method === "thread/resume") {
            return threadStartResult(existingThreadId, cwd);
          }
          if (method === "thread/inject_items") {
            return {};
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      });

      const activePluginProvider = pluginProviderV1({
        requestTimeoutMs: 5_000,
        signal: new AbortController().signal,
        client: wire.client,
      });
      const result = await startOrResumeThread({
        client: wire.client,
        bindingStore: store,
        params,
        cwd,
        dynamicTools: [],
        appServer,
        userMcpServersEnabled: false,
        appServerRuntimeFingerprint: v172_1,
        pluginThreadConfig: activePluginProvider,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        threadId: existingThreadId,
        lifecycle: { action: "resumed" },
      });
      const methods = wire.request.mock.calls.map(([method]) => method);
      expect(methods).toContain("thread/resume");
      expect(methods).not.toContain("thread/start");
      expect(store.read(identity)?.appServerRuntimeFingerprint).toBe(v172_1);
      expect(store.read(identity)?.pluginAppsInputFingerprint).toBe(
        activePluginProvider.inputFingerprint,
      );
    },
  );

  it("rotates the local thread when codexHome changes across restart", async () => {
    const cwd = tempDirs.make("codex-home-change-rotate-");
    const params = createParams(path.join(cwd, "session.jsonl"), cwd);
    params.disableTools = false;
    params.agentId = "main";
    const appServer = {
      ...createAppServerOptions(),
      connectionClass: "local-loopback" as const,
    };
    const oldHomeFp = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: path.join(cwd, "home-a") },
    });
    const newHomeFp = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: { serverVersion: "0.172.1", codexHome: path.join(cwd, "home-b") },
    });

    const store = createCodexTestBindingStore();
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-old-home",
        cwd,
        model: params.modelId,
        modelProvider: "openai",
        webSearchThreadConfigFingerprint: DEFAULT_WEB_SEARCH_FINGERPRINT,
        appServerRuntimeFingerprint: oldHomeFp,
      },
    });

    const wire = await createLeasedCodexLifecycleHarness({
      agentDir: cwd,
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-new-home", cwd);
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    });

    const result = await startOrResumeThread({
      client: wire.client,
      bindingStore: store,
      params,
      cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      appServerRuntimeFingerprint: newHomeFp,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      threadId: "thread-new-home",
      lifecycle: { action: "started" },
    });
    const methods = wire.request.mock.calls.map(([method]) => method);
    expect(methods).toContain("thread/start");
    expect(methods).not.toContain("thread/resume");
  });

  function openColdBindingStore(persisted?: Map<string, StoredCodexAppServerBinding>) {
    const entries: Array<[string, StoredCodexAppServerBinding]> = persisted
      ? structuredClone([...persisted.entries()])
      : [];
    const values = new Map<string, StoredCodexAppServerBinding>(entries);
    const state = createCodexTestBindingStateStore(values);
    return { values, state, store: createCodexAppServerBindingStore(state) };
  }

  function makeLegacyLocalFingerprint(
    appServer: ReturnType<typeof createAppServerOptions>,
    codexHome: string,
    version = "0.172.0",
  ) {
    const base = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: version,
      runtimeIdentity: {
        serverVersion: version,
        userAgent: `openclaw/${version} (linux)`,
        codexHome,
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return JSON.stringify({
      ...JSON.parse(base),
      appServerVersion: version,
      runtimeIdentity: {
        serverVersion: version,
        userAgent: `openclaw/${version} (linux)`,
        codexHome,
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
  }

  const pendingReceipt: CodexNativeSubagentSubmission = {
    parentTurnId: "parent-turn-1",
    callId: "call-followup-1",
    childThreadId: "child-thread-1",
    submissionId: "child-turn-2",
    predecessorRunId: "codex-thread:child-thread-1:turn:child-turn-1",
    predecessorNativeTurnId: "child-turn-1",
  };

  function makePendingAssignment(
    owner: NonNullable<ReturnType<typeof createCodexNativeSubagentHistoryOwner>>,
    parentThreadId: string,
  ): CodexNativeSubagentPendingAssignment {
    return {
      runId: "codex-thread:child-thread-1:turn:child-turn-2",
      childThreadId: pendingReceipt.childThreadId,
      nativeTurnId: pendingReceipt.submissionId,
      nativeParentThreadId: parentThreadId,
      owner,
      submission: pendingReceipt,
    };
  }

  async function seedRecoveryState(
    store: ReturnType<typeof openColdBindingStore>["store"],
    identity: { kind: "session"; agentId: string; sessionId: string; sessionKey?: string },
    binding: {
      threadId: string;
      cwd: string;
      model: string;
      modelProvider: string;
      authProfileId?: string;
      webSearchThreadConfigFingerprint: string;
      appServerRuntimeFingerprint: string;
    },
    owner: NonNullable<ReturnType<typeof createCodexNativeSubagentHistoryOwner>>,
  ) {
    const currentAuthority = () => undefined;
    await store.mutate(identity, { kind: "set", binding });
    expect(
      await store.mutate(
        identity,
        {
          kind: "record-native-subagent-assignment",
          owner,
          assignment: makePendingAssignment(owner, binding.threadId),
        },
        currentAuthority,
      ),
    ).toBe(true);
    expect(
      await store.mutate(
        identity,
        {
          kind: "record-native-subagent-submission",
          owner,
          receipt: pendingReceipt,
        },
        currentAuthority,
      ),
    ).toBe(true);
  }

  it("migrates pending subagent assignments and unmatched submissions across a legacy 0.172.0 -> 0.172.1 cold restart", async () => {
    const cwd = tempDirs.make("codex-version-bump-recovery-");
    const codexHome = path.join(cwd, "codex-home");
    const params = createParams(path.join(cwd, "session.jsonl"), cwd);
    params.disableTools = false;
    params.agentId = "main";
    const appServer = { ...createAppServerOptions(), connectionClass: "local-loopback" as const };
    const legacyFp = makeLegacyLocalFingerprint(appServer, codexHome, "0.172.0");
    const upgradedFp = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (linux)",
        codexHome,
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
    const existingThreadId = "thread-legacy-recovery";
    const legacyBinding = {
      threadId: existingThreadId,
      cwd,
      model: params.modelId,
      modelProvider: "openai",
      webSearchThreadConfigFingerprint: DEFAULT_WEB_SEARCH_FINGERPRINT,
      appServerRuntimeFingerprint: legacyFp,
    };
    const legacyOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: existingThreadId,
      sessionId: params.sessionId,
      lifecycleRevision: "rev-upgrade-1",
      binding: legacyBinding,
    })!;
    const currentAuthority = () => undefined;

    const initial = openColdBindingStore();
    await seedRecoveryState(initial.store, identity, legacyBinding, legacyOwner);

    const restarted = openColdBindingStore(initial.values);
    const wire = await createLeasedCodexLifecycleHarness({
      agentDir: cwd,
      persistedThreads: [existingThreadId],
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/read") {
          return {
            thread: {
              ...threadStartResult(existingThreadId, cwd).thread,
              status: { type: "notLoaded" },
            },
          };
        }
        if (method === "thread/resume") {
          return threadStartResult(existingThreadId, cwd);
        }
        if (method === "thread/inject_items") {
          return {};
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    });

    const resumed = await startOrResumeThread({
      client: wire.client,
      bindingStore: restarted.store,
      params,
      cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      appServerRuntimeFingerprint: upgradedFp,
      signal: new AbortController().signal,
    });
    expect(resumed).toMatchObject({ threadId: existingThreadId, lifecycle: { action: "resumed" } });

    const coldReadback = openColdBindingStore(restarted.values);
    const persisted = await coldReadback.store.readAsync(identity);
    expect(persisted?.appServerRuntimeFingerprint).toBe(upgradedFp);
    const upgradedOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: existingThreadId,
      sessionId: params.sessionId,
      lifecycleRevision: "rev-upgrade-1",
      binding: persisted!,
    })!;
    expect(upgradedOwner.connectionFingerprint).not.toBe(legacyOwner.connectionFingerprint);

    const recoveredAssignments = await coldReadback.store.readNativeSubagentAssignments!(
      identity,
      upgradedOwner,
    );
    expect(recoveredAssignments).toEqual([makePendingAssignment(upgradedOwner, existingThreadId)]);
    expect(await coldReadback.store.readNativeSubagentSubmissions(identity, upgradedOwner)).toEqual(
      [pendingReceipt],
    );
    expect(
      await coldReadback.store.mutate(
        identity,
        {
          kind: "consume-native-subagent-assignment",
          owner: upgradedOwner,
          assignment: recoveredAssignments[0]!,
        },
        currentAuthority,
      ),
    ).toBe(true);
    expect(
      await coldReadback.store.mutate(
        identity,
        {
          kind: "consume-native-subagent-submission",
          owner: upgradedOwner,
          receipt: pendingReceipt,
        },
        currentAuthority,
      ),
    ).toBe(true);
  });

  it("drops pending recovery metadata across cold readback when codexHome, authProfileId, or remote version changes", async () => {
    const cwd = tempDirs.make("codex-recovery-boundary-");
    const homeA = path.join(cwd, "home-a");
    const homeB = path.join(cwd, "home-b");
    const params = createParams(path.join(cwd, "session.jsonl"), cwd);
    params.disableTools = false;
    params.agentId = "main";
    const appServer = { ...createAppServerOptions(), connectionClass: "local-loopback" as const };
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
    const key = bindingStoreKey(identity);
    const existingThreadId = "thread-home-a";
    const legacyHomeAFp = makeLegacyLocalFingerprint(appServer, homeA, "0.172.0");
    const homeBFp = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (linux)",
        codexHome: homeB,
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const homeABinding = {
      threadId: existingThreadId,
      cwd,
      model: params.modelId,
      modelProvider: "openai",
      authProfileId: "profile-a",
      webSearchThreadConfigFingerprint: DEFAULT_WEB_SEARCH_FINGERPRINT,
      appServerRuntimeFingerprint: legacyHomeAFp,
    };
    const homeAOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: existingThreadId,
      sessionId: params.sessionId,
      lifecycleRevision: "rev-boundary-1",
      binding: homeABinding,
    })!;

    const initial = openColdBindingStore();
    await seedRecoveryState(initial.store, identity, homeABinding, homeAOwner);

    const restarted = openColdBindingStore(initial.values);
    const wire = await createLeasedCodexLifecycleHarness({
      agentDir: cwd,
      respond: async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-home-b", cwd);
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    });

    const rotated = await startOrResumeThread({
      client: wire.client,
      bindingStore: restarted.store,
      params,
      cwd,
      dynamicTools: [],
      appServer,
      userMcpServersEnabled: false,
      appServerRuntimeFingerprint: homeBFp,
      signal: new AbortController().signal,
    });
    expect(rotated).toMatchObject({ threadId: "thread-home-b", lifecycle: { action: "started" } });

    const coldAfterHomeChange = openColdBindingStore(restarted.values);
    const rowAfterHomeChange = await coldAfterHomeChange.state.asyncReads.lookup(key);
    expect(rowAfterHomeChange).not.toHaveProperty("nativeSubagentAssignments");
    expect(rowAfterHomeChange).not.toHaveProperty("nativeSubagentSubmissions");

    // Verify authProfileId change on same local codexHome also clears recovery metadata.
    const sameHomeUpgradedFp = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (linux)",
        codexHome: homeA,
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    await seedRecoveryState(coldAfterHomeChange.store, identity, homeABinding, homeAOwner);
    await coldAfterHomeChange.store.mutate(identity, {
      kind: "patch",
      threadId: existingThreadId,
      patch: { authProfileId: "profile-b", appServerRuntimeFingerprint: sameHomeUpgradedFp },
    });
    const coldAfterAuthChange = openColdBindingStore(coldAfterHomeChange.values);
    const rowAfterAuthChange = await coldAfterAuthChange.state.asyncReads.lookup(key);
    expect(rowAfterAuthChange).not.toHaveProperty("nativeSubagentAssignments");
    expect(rowAfterAuthChange).not.toHaveProperty("nativeSubagentSubmissions");

    // Verify remote version bumps never migrate recovery metadata.
    const remoteAppServer = {
      start: {
        transport: "websocket" as const,
        command: "codex",
        args: [],
        url: "wss://codex.example.internal/ws",
        headers: {},
      },
      connectionClass: "remote" as const,
    };
    const remoteV0 = buildCodexAppServerRuntimeFingerprint({
      appServer: remoteAppServer,
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: "/remote/.codex" },
    });
    const remoteV1 = buildCodexAppServerRuntimeFingerprint({
      appServer: remoteAppServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: { serverVersion: "0.172.1", codexHome: "/remote/.codex" },
    });
    const remoteBinding = { ...homeABinding, appServerRuntimeFingerprint: remoteV0 };
    const remoteOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId: existingThreadId,
      sessionId: params.sessionId,
      lifecycleRevision: "rev-remote-1",
      binding: remoteBinding,
    })!;
    await seedRecoveryState(coldAfterAuthChange.store, identity, remoteBinding, remoteOwner);
    await coldAfterAuthChange.store.mutate(identity, {
      kind: "patch",
      threadId: existingThreadId,
      patch: { appServerRuntimeFingerprint: remoteV1 },
    });
    const coldAfterRemoteBump = openColdBindingStore(coldAfterAuthChange.values);
    const rowAfterRemoteBump = await coldAfterRemoteBump.state.asyncReads.lookup(key);
    expect(rowAfterRemoteBump).not.toHaveProperty("nativeSubagentAssignments");
    expect(rowAfterRemoteBump).not.toHaveProperty("nativeSubagentSubmissions");
  });
});

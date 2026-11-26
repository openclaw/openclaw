import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";
import {
  prepareCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import { buildCodexPluginThreadConfigInputFingerprint } from "./plugin-thread-config.js";
import {
  areCodexAppServerRuntimeFingerprintsCompatible,
  shouldRotateCodexAppServerBindingForRuntime,
  shouldRotateCodexPluginThreadBinding,
} from "./thread-binding-policy.js";

function localAppServer(overrides?: { transport?: "stdio" | "websocket"; url?: string }) {
  return {
    start: {
      transport: overrides?.transport ?? ("stdio" as const),
      command: "codex",
      args: ["app-server"],
      ...(overrides?.url ? { url: overrides.url } : {}),
      headers: {},
    },
    connectionClass: "local-loopback" as const,
  };
}

describe("shouldRotateCodexAppServerBindingForRuntime", () => {
  it("does not rotate local bindings across version/userAgent bumps, including legacy persisted fingerprints", () => {
    const appServer = localAppServer();
    const v172_0 = buildCodexAppServerRuntimeFingerprint({
      appServer,
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (linux)",
        codexHome: "/tmp/codex-home",
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
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const legacyPersistedV172_0 = JSON.stringify({
      ...JSON.parse(v172_0),
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (linux)",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });

    expect(
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: "local-loopback",
        binding: v172_0,
        current: v172_1,
      }),
    ).toBe(false);
    expect(
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: "local-loopback",
        binding: legacyPersistedV172_0,
        current: v172_1,
      }),
    ).toBe(false);
  });

  it("still rotates local bindings when codexHome or transport/endpoint changes", () => {
    const base = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer(),
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: "/tmp/home-a" },
    });
    const changedHome = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer(),
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: "/tmp/home-b" },
    });
    const changedEndpoint = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer({ transport: "websocket", url: "ws://127.0.0.1:4500" }),
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: "/tmp/home-a" },
    });

    expect(
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: "local-loopback",
        binding: base,
        current: changedHome,
      }),
    ).toBe(true);
    expect(
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: "local-loopback",
        binding: base,
        current: changedEndpoint,
      }),
    ).toBe(true);
  });

  it("continues rotating remote bindings when the remote app-server version changes", () => {
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
    const v172_0 = buildCodexAppServerRuntimeFingerprint({
      appServer: remoteAppServer,
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: "/remote/.codex" },
    });
    const v172_1 = buildCodexAppServerRuntimeFingerprint({
      appServer: remoteAppServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: { serverVersion: "0.172.1", codexHome: "/remote/.codex" },
    });

    expect(
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: "remote",
        binding: v172_0,
        current: v172_1,
      }),
    ).toBe(true);
  });

  it("keeps local plugin app bindings across version bumps while rotating on home or policy drift", () => {
    const appServer = localAppServer();
    const startupPolicy = resolveCodexPluginThreadConfigStartupPolicy({
      pluginConfig: {},
      nativeToolSurfaceEnabled: false,
    });
    const policy = startupPolicy.resolvedPluginPolicy!;
    const keyV1 = buildCodexPluginAppCacheKey({
      appServer,
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const keyV2 = buildCodexPluginAppCacheKey({
      appServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const keyDifferentHome = buildCodexPluginAppCacheKey({
      appServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/other-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const legacyRuntimeFp = JSON.stringify({
      ...JSON.parse(
        buildCodexAppServerRuntimeFingerprint({
          appServer,
          appServerVersion: "0.172.0",
          runtimeIdentity: {
            serverVersion: "0.172.0",
            userAgent: "openclaw/0.172.0 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "linux",
          },
        }),
      ),
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const legacyInputFp = buildCodexPluginThreadConfigInputFingerprint({
      policy,
      appCacheKey: keyV1,
    });
    const providerV2 = prepareCodexPluginThreadConfigStartupProvider({
      startupPolicy,
      appCacheKey: keyV2,
      connectionClass: "local-loopback",
    })!({
      requestTimeoutMs: 5_000,
      signal: new AbortController().signal,
      client: { request: async () => ({}) },
    });
    const providerOtherHome = prepareCodexPluginThreadConfigStartupProvider({
      startupPolicy,
      appCacheKey: keyDifferentHome,
      connectionClass: "local-loopback",
    })!({
      requestTimeoutMs: 5_000,
      signal: new AbortController().signal,
      client: { request: async () => ({}) },
    });
    const legacyBinding = {
      threadId: "thread-legacy",
      cwd: "/tmp/ws",
      model: "gpt-5.4",
      appServerRuntimeFingerprint: legacyRuntimeFp,
      pluginAppsFingerprint: "fp-legacy",
      pluginAppsInputFingerprint: legacyInputFp,
      pluginAppPolicyContext: { fingerprint: "ctx-1", apps: {}, pluginAppIds: {} },
    };

    expect(shouldRotateCodexPluginThreadBinding(legacyBinding, providerV2)).toBe(false);
    expect(shouldRotateCodexPluginThreadBinding(legacyBinding, providerOtherHome)).toBe(true);
  });

  it("keeps supervised connection fingerprints exact across codexHome, homeScope, and cwd changes", () => {
    const baseOptions = {
      start: {
        ...localAppServer().start,
        homeScope: "user" as const,
        codexHome: "/tmp/supervised-home-a",
        cwd: "/tmp/ws-a",
      },
      connectionClass: "local-loopback" as const,
    };
    const base = buildCodexAppServerConnectionFingerprint(baseOptions);
    const identical = buildCodexAppServerConnectionFingerprint(baseOptions);
    const otherHome = buildCodexAppServerConnectionFingerprint({
      ...baseOptions,
      start: { ...baseOptions.start, codexHome: "/tmp/supervised-home-b" },
    });
    const otherScope = buildCodexAppServerConnectionFingerprint({
      ...baseOptions,
      start: { ...localAppServer().start, codexHome: "/tmp/supervised-home-a", cwd: "/tmp/ws-a" },
    });
    const otherCwd = buildCodexAppServerConnectionFingerprint({
      ...baseOptions,
      start: { ...baseOptions.start, cwd: "/tmp/ws-b" },
    });
    const localRuntime = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer(),
      appServerVersion: "0.172.0",
      runtimeIdentity: { serverVersion: "0.172.0", codexHome: "/tmp/supervised-home-a" },
    });

    expect(
      areCodexAppServerRuntimeFingerprintsCompatible({
        connectionClass: "local-loopback",
        binding: base,
        current: identical,
      }),
    ).toBe(true);
    for (const candidate of [otherHome, otherScope, otherCwd, localRuntime]) {
      expect(
        areCodexAppServerRuntimeFingerprintsCompatible({
          connectionClass: "local-loopback",
          binding: base,
          current: candidate,
        }),
      ).toBe(false);
      expect(
        shouldRotateCodexAppServerBindingForRuntime({
          connectionClass: "local-loopback",
          binding: base,
          current: candidate,
        }),
      ).toBe(true);
    }
  });
});

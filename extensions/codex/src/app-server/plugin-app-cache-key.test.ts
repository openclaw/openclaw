import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerConnectionFingerprint as connectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey as appCacheKey,
  buildLegacyLocalCodexPluginAppCacheKeys,
  normalizeCodexAppServerLocalRuntimeFingerprint,
  normalizeCodexPluginAppCacheKeyForLocalBinding,
} from "./plugin-app-cache-key.js";

function remoteStart() {
  return {
    transport: "websocket" as const,
    command: "codex",
    args: [],
    url: "wss://codex-app-server.example.internal/ws",
    authToken: "secret-token",
    headers: {},
  };
}

function stdioStart(command = "codex") {
  return { transport: "stdio" as const, command, args: ["app-server"], headers: {} };
}

const runtimeIdentity = { serverVersion: "0.20.0", codexHome: "/home/oai/.codex" };

function runtimeFingerprint(remoteWorkspaceRoot?: string) {
  return buildCodexAppServerRuntimeFingerprint({
    appServer: { start: remoteStart(), connectionClass: "remote", remoteWorkspaceRoot },
    runtimeIdentity,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCodexPluginAppCacheEndpoint", () => {
  it("keys plugin app inventory by initialized remote runtime identity", () => {
    const base = {
      appServer: { start: remoteStart() },
      authProfileId: "profile-1",
      runtimeIdentity: {
        ...runtimeIdentity,
        platformFamily: "unix",
        platformOs: "linux",
      },
    };
    const first = appCacheKey(base);
    const second = appCacheKey({
      ...base,
      runtimeIdentity: {
        ...base.runtimeIdentity,
        codexHome: "/Users/kevinlin/.codex",
        platformOs: "macos",
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-token");
    expect(second).not.toContain("secret-token");
  });

  it("separates plugin inventory across managed desktop generations", () => {
    const base = {
      appServer: {
        start: stdioStart("/Applications/ChatGPT.app/Contents/Resources/codex"),
      },
      agentDir: "/tmp/openclaw-agent",
      runtimeIdentity: { ...runtimeIdentity, codexHome: "/tmp/openclaw-agent/codex-home" },
    };

    const generationX = appCacheKey({
      ...base,
      desktopGenerationFingerprint: "desktop-x",
    });
    const generationY = appCacheKey({
      ...base,
      desktopGenerationFingerprint: "desktop-y",
    });

    expect(generationX).not.toEqual(generationY);
  });

  it("fingerprints the remote app-server runtime used by thread bindings", () => {
    const first = runtimeFingerprint("/home/oai/openclaw-workspaces");
    const second = runtimeFingerprint();

    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-token");
    expect(second).not.toContain("secret-token");
  });

  it("fingerprints the effective user Codex home for supervised connections", () => {
    const appServer = {
      start: {
        ...stdioStart(),
        homeScope: "user" as const,
      },
      connectionClass: "local-loopback" as const,
    };
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home-one");
    const first = connectionFingerprint(appServer);
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home-two");
    const second = connectionFingerprint(appServer);

    expect(first).not.toEqual(second);
  });

  it("keeps local-loopback runtime fingerprints stable across version and userAgent bumps", () => {
    const localAppServer = { start: stdioStart(), connectionClass: "local-loopback" as const };
    const v1 = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer,
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (linux)",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const v2 = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (linux)",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const differentHome = buildCodexAppServerRuntimeFingerprint({
      appServer: localAppServer,
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (linux)",
        codexHome: "/tmp/other-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const differentTransport = buildCodexAppServerRuntimeFingerprint({
      appServer: {
        start: { ...stdioStart(), transport: "websocket", url: "ws://127.0.0.1:4500" },
        connectionClass: "local-loopback",
      },
      appServerVersion: "0.172.1",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });

    expect(v1).toBe(v2);
    expect(v1).not.toBe(differentHome);
    expect(v1).not.toBe(differentTransport);
  });

  it("normalizes local app cache keys across version bumps and reconstructs legacy keys", () => {
    const localAppServer = { start: stdioStart(), connectionClass: "local-loopback" as const };
    const keyV1 = appCacheKey({
      appServer: localAppServer,
      authProfileId: "profile-1",
      appServerVersion: "0.172.0",
      desktopGenerationFingerprint: "desktop-a",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const keyV2 = appCacheKey({
      appServer: localAppServer,
      authProfileId: "profile-1",
      appServerVersion: "0.172.1",
      desktopGenerationFingerprint: "desktop-a",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const differentProfile = appCacheKey({
      appServer: localAppServer,
      authProfileId: "profile-2",
      appServerVersion: "0.172.1",
      desktopGenerationFingerprint: "desktop-a",
      runtimeIdentity: {
        serverVersion: "0.172.1",
        userAgent: "openclaw/0.172.1 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });

    expect(normalizeCodexPluginAppCacheKeyForLocalBinding(keyV1)).toBe(
      normalizeCodexPluginAppCacheKeyForLocalBinding(keyV2),
    );
    expect(normalizeCodexPluginAppCacheKeyForLocalBinding(keyV1)).not.toBe(
      normalizeCodexPluginAppCacheKeyForLocalBinding(differentProfile),
    );

    const legacyRuntimeFp = JSON.stringify({
      ...JSON.parse(
        buildCodexAppServerRuntimeFingerprint({
          appServer: localAppServer,
          appServerVersion: "0.172.0",
          runtimeIdentity: {
            serverVersion: "0.172.0",
            userAgent: "openclaw/0.172.0 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
            codexHome: "/tmp/local-codex-home",
            platformFamily: "unix",
            platformOs: "linux",
          },
        }),
      ),
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (Linux Unknown; x86_64) unknown (openclaw; 2026.11.10)",
        codexHome: "/tmp/local-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    expect(
      buildLegacyLocalCodexPluginAppCacheKeys({
        currentAppCacheKey: keyV2,
        legacyRuntimeFingerprint: legacyRuntimeFp,
      }),
    ).toContain(keyV1);
    expect(
      buildLegacyLocalCodexPluginAppCacheKeys({
        currentAppCacheKey: differentProfile,
        legacyRuntimeFingerprint: legacyRuntimeFp,
      }),
    ).not.toContain(keyV1);
  });

  it("keeps supervised connection fingerprints exact instead of normalizing them as local runtimes", () => {
    const supervisedHomeA = connectionFingerprint({
      start: {
        ...stdioStart(),
        homeScope: "user",
        codexHome: "/tmp/supervised-home-a",
        cwd: "/tmp/ws-a",
      },
      connectionClass: "local-loopback",
    });
    const supervisedHomeB = connectionFingerprint({
      start: {
        ...stdioStart(),
        homeScope: "user",
        codexHome: "/tmp/supervised-home-b",
        cwd: "/tmp/ws-a",
      },
      connectionClass: "local-loopback",
    });
    const supervisedManagedScope = connectionFingerprint({
      start: {
        ...stdioStart(),
        codexHome: "/tmp/supervised-home-a",
        cwd: "/tmp/ws-a",
      },
      connectionClass: "local-loopback",
    });
    const localRuntime = buildCodexAppServerRuntimeFingerprint({
      appServer: { start: stdioStart(), connectionClass: "local-loopback" },
      appServerVersion: "0.172.0",
      runtimeIdentity: {
        serverVersion: "0.172.0",
        userAgent: "openclaw/0.172.0 (linux)",
        codexHome: "/tmp/supervised-home-a",
      },
    });
    const currentCacheKey = appCacheKey({
      appServer: { start: stdioStart() },
      appServerVersion: "0.172.1",
      runtimeIdentity: { serverVersion: "0.172.1", codexHome: "/tmp/supervised-home-a" },
    });

    expect(normalizeCodexAppServerLocalRuntimeFingerprint(supervisedHomeA)).toBeUndefined();
    expect(normalizeCodexAppServerLocalRuntimeFingerprint(supervisedHomeB)).toBeUndefined();
    expect(normalizeCodexAppServerLocalRuntimeFingerprint(supervisedManagedScope)).toBeUndefined();
    expect(normalizeCodexAppServerLocalRuntimeFingerprint(localRuntime)).toBe(localRuntime);
    expect(
      buildLegacyLocalCodexPluginAppCacheKeys({
        currentAppCacheKey: currentCacheKey,
        legacyRuntimeFingerprint: supervisedHomeA,
      }),
    ).toEqual([]);
  });
});

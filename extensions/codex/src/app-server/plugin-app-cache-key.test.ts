import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexAppServerConnectionFingerprint as connectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey as appCacheKey,
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
});

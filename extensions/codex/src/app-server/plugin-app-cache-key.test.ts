// Codex tests cover plugin app cache key plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey,
  resolveCodexPluginAppCacheEndpoint,
} from "./plugin-app-cache-key.js";

describe("resolveCodexPluginAppCacheEndpoint", () => {
  it("keys plugin app inventory by websocket credentials without exposing them", () => {
    const first = resolveCodexPluginAppCacheEndpoint({
      start: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-first",
        headers: { Authorization: "Bearer first" },
      },
    });
    const second = resolveCodexPluginAppCacheEndpoint({
      start: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-second",
        headers: { Authorization: "Bearer second" },
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("token-first");
    expect(first).not.toContain("Bearer first");
    expect(second).not.toContain("token-second");
    expect(second).not.toContain("Bearer second");
  });

  it("keys plugin app inventory by initialized remote runtime identity", () => {
    const base = {
      appServer: {
        start: {
          transport: "websocket" as const,
          command: "codex",
          args: [],
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "secret-token",
          headers: {},
        },
      },
      authProfileId: "profile-1",
    };

    const first = buildCodexPluginAppCacheKey({
      ...base,
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/home/oai/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    const second = buildCodexPluginAppCacheKey({
      ...base,
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/Users/kevinlin/.codex",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-token");
    expect(second).not.toContain("secret-token");
  });

  it("fingerprints the remote app-server runtime used by thread bindings", () => {
    const first = buildCodexAppServerRuntimeFingerprint({
      appServer: {
        start: {
          transport: "websocket",
          command: "codex",
          args: [],
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "secret-token",
          headers: {},
        },
        connectionClass: "remote",
        remoteWorkspaceRoot: "/home/oai/openclaw-workspaces",
      },
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/home/oai/.codex",
      },
    });
    const second = buildCodexAppServerRuntimeFingerprint({
      appServer: {
        start: {
          transport: "websocket",
          command: "codex",
          args: [],
          url: "wss://codex-app-server.example.internal/ws",
          authToken: "secret-token",
          headers: {},
        },
        connectionClass: "remote",
      },
      runtimeIdentity: {
        serverVersion: "0.20.0",
        codexHome: "/home/oai/.codex",
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("secret-token");
    expect(second).not.toContain("secret-token");
  });
});

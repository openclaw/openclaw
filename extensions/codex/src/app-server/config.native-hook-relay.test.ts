import { describe, expect, it } from "vitest";
import { resolveRuntimeForTest } from "./config.test-support.js";

function resolveAppServer(appServer: unknown) {
  return resolveRuntimeForTest({ pluginConfig: { appServer } });
}

describe("Codex native hook callback configuration", () => {
  it("accepts an explicit HTTPS native hook callback without placing its configuration in the app-server transport", () => {
    const nativeHookRelay = {
      url: "https://gateway.example/node/__openclaw__/native-hook",
      credentialDirectory: "/home/node/.native-hooks",
    };
    const runtime = resolveAppServer({
      transport: "websocket",
      url: "wss://codex.example/ws",
      authToken: "synthetic-app-server-token",
      nativeHookRelay,
    });
    expect(runtime.nativeHookRelay).toEqual(nativeHookRelay);
    expect(runtime.start).not.toHaveProperty("nativeHookRelay");
  });

  it.each([
    ["http://gateway.example/hooks", "/private/hooks"],
    ["https://gateway.example/hooks?token=secret", "/private/hooks"],
    ["https://gateway.example/hooks", "relative/hooks"],
    ["https://example-user@gateway.example/hooks", "/private/hooks"],
    ["https://:example-password-not-real@gateway.example/hooks", "/private/hooks"],
  ])("rejects unsafe remote hook callback %s in %s", (url, credentialDirectory) => {
    expect(() => resolveAppServer({ nativeHookRelay: { url, credentialDirectory } })).toThrow();
  });
});

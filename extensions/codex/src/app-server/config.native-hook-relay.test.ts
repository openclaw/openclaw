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
    { url: "http://gateway.example/hooks", credentialDirectory: "/private/hooks" },
    { url: "https://gateway.example/hooks?token=secret", credentialDirectory: "/private/hooks" },
    { url: "https://gateway.example/hooks", credentialDirectory: "relative/hooks" },
  ])("rejects unsafe remote hook callback configuration: $url", (nativeHookRelay) => {
    expect(() => resolveAppServer({ nativeHookRelay })).toThrow();
  });

  it.each([
    { username: "example-user", password: "" },
    { username: "", password: "example-password-not-real" },
    { username: "example-user", password: "example-password-not-real" },
  ])("rejects native hook callback userinfo: $username / $password", ({ username, password }) => {
    const url = new URL("https://gateway.example/hooks");
    url.username = username;
    url.password = password;
    expect(() =>
      resolveAppServer({
        nativeHookRelay: { url: url.href, credentialDirectory: "/private/hooks" },
      }),
    ).toThrow();
  });
});

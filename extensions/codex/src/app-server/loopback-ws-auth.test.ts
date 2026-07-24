// Covers DNS hostname bypass of the remote-auth WS loopback boundary.
// Fix: guard `host.startsWith("127.")` with `isIP(host) === 4` so
// hostnames like `127.evil.com` don't skip authToken/Authorization.
import { describe, expect, it } from "vitest";

// Reach into config.ts for the internal helper; test through its canonical
// consumer `assertCodexAppServerConnectionSecurity` where possible.
const { assertCodexAppServerConnectionSecurity } = await import("./config.js");

describe("isLoopbackWebSocketUrl (via assertCodexAppServerConnectionSecurity)", () => {
  it("rejects DNS hostnames that start with 127.", () => {
    // DNS hostnames must NOT bypass the remote-auth boundary.
    // Before the fix, host.startsWith("127.") classified these as loopback.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://127.evil.com/app",
        authToken: undefined,
        headers: {},
      }),
    ).toThrow(/remote Codex app-server WebSocket URLs require/);
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "wss://127.example.com/codex",
        authToken: undefined,
        headers: {},
      }),
    ).toThrow(/remote Codex app-server WebSocket URLs require/);
  });

  it("rejects DNS hostnames with a 127-like subdomain", () => {
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "wss://ws.127.com/codex",
        authToken: undefined,
        headers: {},
      }),
    ).toThrow(/remote Codex app-server WebSocket URLs require/);
  });

  it("still classifies literal 127/8 IPv4 as loopback", () => {
    // Valid IPv4 loopback addresses must still skip auth.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://127.0.0.1:3333/app",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://127.255.255.254/codex",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
  });

  it("still classifies localhost and ::1 as loopback", () => {
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://localhost:3333/app",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://[::1]:3333/app",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
  });

  it("does not throw for non-WS transports (they are always local-loopback)", () => {
    // Non-websocket transports bypass the WS URL check entirely.
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "stdio",
        authToken: undefined,
        headers: {},
      }),
    ).not.toThrow();
  });

  it("does not throw for remote WS with valid auth", () => {
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "wss://remote.example.com/codex",
        authToken: "secret",
        headers: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexAppServerConnectionSecurity({
        transport: "websocket",
        url: "ws://remote.example.com/codex",
        headers: { authorization: "Bearer token" },
      }),
    ).not.toThrow();
  });
});

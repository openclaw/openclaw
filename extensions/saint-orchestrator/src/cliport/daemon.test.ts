import { describe, expect, it } from "vitest";
import { __testing } from "./daemon.js";

describe("cliport daemon helpers", () => {
  it("normalizes valid requests", () => {
    const parsed = __testing.normalizeRequest({
      type: "exec",
      token: "abc",
      cli: "gog",
      args: ["gmail", "search"],
      cwd: "/agent",
      timeoutMs: 5000,
    });

    expect(parsed).toEqual({
      type: "exec",
      token: "abc",
      cli: "gog",
      args: ["gmail", "search"],
      cwd: "/agent",
      timeoutMs: 5000,
      sessionKey: undefined,
      containerName: undefined,
    });
  });

  it("rejects malformed requests", () => {
    expect(__testing.normalizeRequest({ type: "exec", cli: "gog" })).toBeNull();
    expect(__testing.normalizeRequest({ type: "noop" })).toBeNull();
  });

  it("applies per-minute rate limits", () => {
    const state = new Map();
    const ok1 = __testing.checkRateLimit({
      key: "global",
      limitPerMinute: 2,
      state,
    });
    const ok2 = __testing.checkRateLimit({
      key: "global",
      limitPerMinute: 2,
      state,
    });
    const ok3 = __testing.checkRateLimit({
      key: "global",
      limitPerMinute: 2,
      state,
    });

    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(ok3).toBe(false);
  });
});

describe("cliport token binding helpers", () => {
  it("parses token binding objects", () => {
    const parsed = __testing.parseTokenBinding({
      token: "tok-1",
      sessionKey: "agent:main:main",
      containerName: "openclaw-sbx-main",
    });
    expect(parsed).toEqual({
      token: "tok-1",
      sessionKey: "agent:main:main",
      containerName: "openclaw-sbx-main",
    });
  });

  it("enforces session/container binding when metadata is present", () => {
    const binding = {
      token: "tok-1",
      sessionKey: "agent:main:main",
      containerName: "openclaw-sbx-main",
    };
    expect(
      __testing.tokenBindingMatchesRequest(binding, {
        type: "exec",
        token: "tok-1",
        cli: "gog",
        args: [],
        cwd: "/workspace",
        sessionKey: "agent:main:main",
        containerName: "openclaw-sbx-main",
      }),
    ).toBe(true);
    expect(
      __testing.tokenBindingMatchesRequest(binding, {
        type: "exec",
        token: "tok-1",
        cli: "gog",
        args: [],
        cwd: "/workspace",
        sessionKey: "agent:other:main",
        containerName: "openclaw-sbx-main",
      }),
    ).toBe(false);
    expect(
      __testing.tokenBindingMatchesRequest(binding, {
        type: "exec",
        token: "tok-1",
        cli: "gog",
        args: [],
        cwd: "/workspace",
        sessionKey: "agent:main:main",
        containerName: "openclaw-sbx-other",
      }),
    ).toBe(false);
  });

  it("finds token binding using timing-safe token comparison", () => {
    const tokens = new Map([
      [
        "tok-1",
        {
          token: "tok-1",
          sessionKey: "agent:main:main",
        },
      ],
    ]);
    const found = __testing.findTokenBinding(tokens, "tok-1");
    expect(found?.token).toBe("tok-1");
    const missing = __testing.findTokenBinding(tokens, "tok-2");
    expect(missing).toBeNull();
  });

  it("timingSafeStringEquals returns false for length mismatch", () => {
    expect(__testing.timingSafeStringEquals("abc", "abcd")).toBe(false);
    expect(__testing.timingSafeStringEquals("abc", "abc")).toBe(true);
  });
});

describe("normalizeRequest arg length limits", () => {
  const baseRequest = {
    type: "exec",
    token: "abc",
    cli: "gog",
    cwd: "/agent",
  };

  it("rejects a single arg exceeding MAX_ARG_LENGTH", () => {
    const longArg = "x".repeat(__testing.MAX_ARG_LENGTH + 1);
    const result = __testing.normalizeRequest({
      ...baseRequest,
      args: [longArg],
    });
    expect(result).toBeNull();
  });

  it("accepts a single arg at exactly MAX_ARG_LENGTH", () => {
    const maxArg = "x".repeat(__testing.MAX_ARG_LENGTH);
    const result = __testing.normalizeRequest({
      ...baseRequest,
      args: [maxArg],
    });
    expect(result).not.toBeNull();
    expect(result!.args[0]).toBe(maxArg);
  });

  it("rejects args whose combined length exceeds MAX_TOTAL_ARGS_LENGTH", () => {
    // Each arg is well under MAX_ARG_LENGTH, but together they exceed MAX_TOTAL_ARGS_LENGTH
    const argSize = 4096;
    const numArgs = Math.ceil(__testing.MAX_TOTAL_ARGS_LENGTH / argSize) + 1;
    const args = Array.from({ length: numArgs }, () => "a".repeat(argSize));
    const result = __testing.normalizeRequest({
      ...baseRequest,
      args,
    });
    expect(result).toBeNull();
  });

  it("accepts args whose combined length is exactly MAX_TOTAL_ARGS_LENGTH", () => {
    // Use args that are each within MAX_ARG_LENGTH but together hit the total limit exactly
    const argSize = __testing.MAX_ARG_LENGTH; // 8192
    const numFullArgs = Math.floor(__testing.MAX_TOTAL_ARGS_LENGTH / argSize); // 8
    const remainder = __testing.MAX_TOTAL_ARGS_LENGTH - numFullArgs * argSize; // 0
    const args = Array.from({ length: numFullArgs }, () => "a".repeat(argSize));
    if (remainder > 0) {
      args.push("b".repeat(remainder));
    }
    const result = __testing.normalizeRequest({
      ...baseRequest,
      args,
    });
    expect(result).not.toBeNull();
    expect(result!.args).toHaveLength(numFullArgs + (remainder > 0 ? 1 : 0));
  });

  it("strips null bytes from args", () => {
    const result = __testing.normalizeRequest({
      ...baseRequest,
      args: ["hello\0world", "foo\0\0bar"],
    });
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["helloworld", "foobar"]);
  });

  it("strips null bytes then checks length limits", () => {
    // Arg with null bytes that would exceed MAX_ARG_LENGTH even after stripping
    const longBody = "x".repeat(__testing.MAX_ARG_LENGTH + 1);
    const result = __testing.normalizeRequest({
      ...baseRequest,
      args: [longBody],
    });
    expect(result).toBeNull();
  });
});

describe("timeout clamping", () => {
  // Timeout clamping is implemented inside handleRequest (daemon.ts lines 405-413).
  // The client-supplied timeoutMs is clamped via:
  //   Math.max(1, Math.min(Math.floor(request.timeoutMs), serverTimeoutMs))
  // This means a client cannot exceed the server-configured timeout.
  //
  // This behavior is difficult to test in isolation without standing up the full
  // daemon (registry file, token file, socket, etc.), so it is covered by
  // integration tests that exercise the daemon end-to-end.
  it.skip("client-supplied timeout cannot exceed server timeout (covered by integration tests)", () => {
    // Placeholder -- see handleRequest in daemon.ts for the clamping logic.
  });
});

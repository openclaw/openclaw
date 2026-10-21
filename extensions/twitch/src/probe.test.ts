import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeTwitch } from "./probe.js";
import type { TwitchAccountConfig } from "./types.js";

const mockUnbind = vi.fn();
let authSuccessHandler: (() => void) | null = null;
let authFailureHandler: (() => void) | null = null;
let disconnectHandler: ((manually: boolean, reason?: Error) => void) | null = null;

const mockConnect = vi.fn(async () => authSuccessHandler?.());

const mockQuit = vi.fn().mockResolvedValue(undefined);
type AuthProviderArgs = ConstructorParameters<typeof import("@twurple/auth").StaticAuthProvider>;
const mockAuthProvider = vi.fn<(...args: AuthProviderArgs) => void>();

vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    connect = mockConnect;
    quit = mockQuit;
    onAuthenticationSuccess(handler: () => void) {
      authSuccessHandler = handler;
      return { unbind: mockUnbind };
    }
    onDisconnect(handler: (manually: boolean, reason?: Error) => void) {
      disconnectHandler = handler;
      return { unbind: mockUnbind };
    }
    onAuthenticationFailure(handler: () => void) {
      authFailureHandler = handler;
      return { unbind: mockUnbind };
    }
  },
}));

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function StaticAuthProvider(...args: AuthProviderArgs) {
    mockAuthProvider(...args);
  },
}));

describe("probeTwitch", () => {
  const mockAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "oauth:test123456789",
    clientId: "test-client-id",
    channel: "testchannel",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authSuccessHandler = null;
    authFailureHandler = null;
    disconnectHandler = null;
  });

  it("returns error when username is missing", async () => {
    expect(await probeTwitch({ ...mockAccount, username: "" }, 5000)).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing credentials"),
    });
  });

  it("times out when connection takes too long", async () => {
    vi.useFakeTimers();
    try {
      mockConnect.mockImplementationOnce(() => new Promise(() => {})); // Never resolves
      const resultPromise = probeTwitch(mockAccount, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await resultPromise).toMatchObject({ ok: false, error: "timeout after 100ms" });
      expect(mockQuit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects credentials refused after the transport connects", async () => {
    mockConnect.mockImplementationOnce(async () => {
      authFailureHandler?.();
    });

    expect(await probeTwitch(mockAccount, 5000)).toMatchObject({
      ok: false,
      error: "Authentication failed",
    });
    expect(mockQuit).toHaveBeenCalledOnce();
  });

  it("trims whitespace before removing the token prefix", async () => {
    const result = await probeTwitch(
      { ...mockAccount, accessToken: "  oauth:test123456789  " },
      5000,
    );
    expect(result).toMatchObject({
      ok: true,
      connected: true,
      username: "testbot",
      channel: "testchannel",
    });
    expect(mockAuthProvider).toHaveBeenCalledOnce();
    expect(mockAuthProvider).toHaveBeenCalledWith("test-client-id", "test123456789");
  });

  it("handles non-Error objects in catch block", async () => {
    mockConnect.mockImplementationOnce(async () => {
      disconnectHandler?.(false, "String error" as unknown as Error);
    });

    expect(await probeTwitch(mockAccount, 5000)).toMatchObject({
      ok: false,
      error: "String error",
    });
  });
});

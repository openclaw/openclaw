import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import { registerMatrixAutoJoin } from "./auto-join.js";

type InviteHandler = (roomId: string, inviteEvent: unknown) => Promise<void>;

function createClientStub() {
  let inviteHandler: InviteHandler | null = null;
  const client = {
    on: vi.fn((eventName: string, listener: unknown) => {
      if (eventName === "room.invite") {
        inviteHandler = listener as InviteHandler;
      }
      return client;
    }),
    joinRoom: vi.fn(async () => {}),
    resolveRoom: vi.fn(async () => null),
  } as unknown as import("../sdk.js").MatrixClient;

  return {
    client,
    getInviteHandler: () => inviteHandler,
    joinRoom: (client as unknown as { joinRoom: ReturnType<typeof vi.fn> }).joinRoom,
    resolveRoom: (client as unknown as { resolveRoom: ReturnType<typeof vi.fn> }).resolveRoom,
  };
}

describe("registerMatrixAutoJoin", () => {
  beforeEach(() => {
    setMatrixRuntime({
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime);
  });

  it("joins all invites when autoJoin=always", async () => {
    const { client, getInviteHandler, joinRoom } = createClientStub();
    const accountConfig: MatrixConfig = {
      autoJoin: "always",
    };

    registerMatrixAutoJoin({
      client,
      accountConfig,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not auto-join invites by default", async () => {
    const { client, getInviteHandler, joinRoom } = createClientStub();

    registerMatrixAutoJoin({
      client,
      accountConfig: {},
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    expect(getInviteHandler()).toBeNull();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("ignores invites outside allowlist when autoJoin=allowlist", async () => {
    const { client, getInviteHandler, joinRoom, resolveRoom } = createClientStub();
    resolveRoom.mockResolvedValue(null);
    const accountConfig: MatrixConfig = {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["#allowed:example.org"],
    };

    registerMatrixAutoJoin({
      client,
      accountConfig,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("joins invite when allowlisted alias resolves to the invited room", async () => {
    const { client, getInviteHandler, joinRoom, resolveRoom } = createClientStub();
    resolveRoom.mockResolvedValue("!room:example.org");
    const accountConfig: MatrixConfig = {
      autoJoin: "allowlist",
      autoJoinAllowlist: [" #allowed:example.org "],
    };

    registerMatrixAutoJoin({
      client,
      accountConfig,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("retries alias resolution after an unresolved lookup", async () => {
    const { client, getInviteHandler, joinRoom, resolveRoom } = createClientStub();
    resolveRoom.mockResolvedValueOnce(null).mockResolvedValueOnce("!room:example.org");

    registerMatrixAutoJoin({
      client,
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#allowed:example.org"],
      },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});
    await inviteHandler!("!room:example.org", {});

    expect(resolveRoom).toHaveBeenCalledTimes(2);
    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not trust room-provided alias claims for allowlist joins", async () => {
    const { client, getInviteHandler, joinRoom, resolveRoom } = createClientStub();
    resolveRoom.mockResolvedValue("!different-room:example.org");

    registerMatrixAutoJoin({
      client,
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#allowed:example.org"],
      },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("uses account-scoped auto-join settings for non-default accounts", async () => {
    const { client, getInviteHandler, joinRoom, resolveRoom } = createClientStub();
    resolveRoom.mockResolvedValue("!room:example.org");

    registerMatrixAutoJoin({
      client,
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#ops-allowed:example.org"],
      },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk/matrix").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });
});

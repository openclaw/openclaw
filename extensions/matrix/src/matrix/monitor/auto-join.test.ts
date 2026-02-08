import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import { setMatrixRuntime } from "../../runtime.js";
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
    getRoomStateEvent: vi.fn(async () => ({})),
  } as unknown as import("../sdk.js").MatrixClient;

  return {
    client,
    getInviteHandler: () => inviteHandler,
    joinRoom: (client as unknown as { joinRoom: ReturnType<typeof vi.fn> }).joinRoom,
    getRoomStateEvent: (client as unknown as { getRoomStateEvent: ReturnType<typeof vi.fn> })
      .getRoomStateEvent,
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
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          autoJoin: "always",
        },
      },
    };

    registerMatrixAutoJoin({
      client,
      cfg,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("ignores invites outside allowlist when autoJoin=allowlist", async () => {
    const { client, getInviteHandler, joinRoom, getRoomStateEvent } = createClientStub();
    getRoomStateEvent.mockResolvedValue({
      alias: "#other:example.org",
      alt_aliases: ["#else:example.org"],
    });
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          autoJoin: "allowlist",
          autoJoinAllowlist: ["#allowed:example.org"],
        },
      },
    };

    registerMatrixAutoJoin({
      client,
      cfg,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("joins invite when alias matches allowlist", async () => {
    const { client, getInviteHandler, joinRoom, getRoomStateEvent } = createClientStub();
    getRoomStateEvent.mockResolvedValue({
      alias: "#allowed:example.org",
      alt_aliases: ["#backup:example.org"],
    });
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          autoJoin: "allowlist",
          autoJoinAllowlist: [" #allowed:example.org "],
        },
      },
    };

    registerMatrixAutoJoin({
      client,
      cfg,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as unknown as import("openclaw/plugin-sdk").RuntimeEnv,
    });

    const inviteHandler = getInviteHandler();
    expect(inviteHandler).toBeTruthy();
    await inviteHandler!("!room:example.org", {});

    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });
});

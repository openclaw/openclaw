import { describe, expect, it, vi } from "vitest";

const shouldLogVerboseMock = vi.hoisted(() => vi.fn(() => true));
const setupOnClientMock = vi.hoisted(() => vi.fn());

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: vi.fn(() => ({
    logging: {
      shouldLogVerbose: shouldLogVerboseMock,
    },
  })),
}));

vi.mock("../sdk-runtime.js", () => ({
  loadMatrixSdk: vi.fn(() => ({
    AutojoinRoomsMixin: {
      setupOnClient: setupOnClientMock,
    },
  })),
}));

import { registerMatrixAutoJoin } from "./auto-join.js";

function createClient() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    getRoomStateEvent: vi.fn().mockResolvedValue(null),
    joinRoom: vi.fn().mockResolvedValue(undefined),
    emitInvite: async (roomId: string, event: unknown) => {
      const handler = handlers.get("room.invite");
      if (!handler) {
        throw new Error("room.invite handler not registered");
      }
      await handler(roomId, event);
    },
  };
}

describe("registerMatrixAutoJoin", () => {
  it("auto-joins allowlisted inviter user ids", async () => {
    const client = createClient();
    const runtime = { log: vi.fn(), error: vi.fn() };

    registerMatrixAutoJoin({
      client: client as never,
      cfg: {
        channels: {
          matrix: {
            autoJoin: "allowlist",
            autoJoinAllowlist: ["@inviter:example.test"],
          },
        },
      },
      runtime: runtime as never,
    });

    await client.emitInvite("!room123:example.test", { sender: "@inviter:example.test" });

    expect(client.joinRoom).toHaveBeenCalledWith("!room123:example.test");
  });

  it("still auto-joins allowlisted room aliases", async () => {
    const client = createClient();
    const runtime = { log: vi.fn(), error: vi.fn() };
    client.getRoomStateEvent.mockResolvedValue({ alias: "#ops:example.test" });

    registerMatrixAutoJoin({
      client: client as never,
      cfg: {
        channels: {
          matrix: {
            autoJoin: "allowlist",
            autoJoinAllowlist: ["#ops:example.test"],
          },
        },
      },
      runtime: runtime as never,
    });

    await client.emitInvite("!room123:example.test", { sender: "@other:example.test" });

    expect(client.joinRoom).toHaveBeenCalledWith("!room123:example.test");
  });

  it("still auto-joins allowlisted room ids", async () => {
    const client = createClient();
    const runtime = { log: vi.fn(), error: vi.fn() };

    registerMatrixAutoJoin({
      client: client as never,
      cfg: {
        channels: {
          matrix: {
            autoJoin: "allowlist",
            autoJoinAllowlist: ["!room123:example.test"],
          },
        },
      },
      runtime: runtime as never,
    });

    await client.emitInvite("!room123:example.test", { sender: "@other:example.test" });

    expect(client.joinRoom).toHaveBeenCalledWith("!room123:example.test");
  });

  it("does not join invites outside the allowlist", async () => {
    const client = createClient();
    const runtime = { log: vi.fn(), error: vi.fn() };

    registerMatrixAutoJoin({
      client: client as never,
      cfg: {
        channels: {
          matrix: {
            autoJoin: "allowlist",
            autoJoinAllowlist: ["@inviter:example.test"],
          },
        },
      },
      runtime: runtime as never,
    });

    await client.emitInvite("!room999:example.test", { sender: "@someoneelse:example.test" });

    expect(client.joinRoom).not.toHaveBeenCalled();
  });
});

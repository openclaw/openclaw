import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixRawEvent } from "./types.js";
import { createMatrixVerificationEventRouter } from "./verification-events.js";

const roomId = "!dm:localhost";
const alice = "@alice:localhost";

const adminsCfg = {
  accessGroups: {
    admins: { type: "message.senders", members: { matrix: [alice] } },
  },
} satisfies Pick<OpenClawConfig, "accessGroups">;
const revokedCfg = {
  accessGroups: {
    admins: { type: "message.senders", members: { matrix: [] } },
  },
} satisfies Pick<OpenClawConfig, "accessGroups">;

function createClient() {
  const sendMessage = vi.fn(async () => ({}));
  const client = {
    getUserId: async () => "@bot:localhost",
    getJoinedRoomMembers: async () => ["@bot:localhost", alice],
    getRoomStateEvent: async () => ({ is_direct: false }),
    sendMessage,
  } as unknown as MatrixClient;
  return { client, sendMessage };
}

function verificationStartEvent(): MatrixRawEvent {
  return {
    type: "m.key.verification.start",
    sender: alice,
    event_id: "$verification-start",
    origin_server_ts: Date.now(),
    content: {},
  } as MatrixRawEvent;
}

function createRouter(
  client: MatrixClient,
  resolveLiveAuthorization: () => Promise<{
    cfg?: Pick<OpenClawConfig, "accessGroups">;
    allowFrom: string[];
  }>,
) {
  let pending: Promise<void> | undefined;
  const router = createMatrixVerificationEventRouter({
    client,
    allowFrom: ["accessGroup:admins"],
    dmEnabled: true,
    dmPolicy: "allowlist",
    readStoreAllowFrom: async () => [],
    logVerboseMessage: () => {},
    resolveLiveAuthorization,
    runDetachedTask: (_label, task) => {
      pending = task();
      return pending;
    },
  });
  return {
    route: () => router.routeVerificationEvent(roomId, verificationStartEvent()),
    settle: async () => await pending,
  };
}

beforeEach(() => setMatrixRuntime(createPluginRuntimeMock()));

describe("createMatrixVerificationEventRouter authority freshness", () => {
  it("sends a verification notice when live membership still authorizes the sender", async () => {
    const { client, sendMessage } = createClient();
    const { route, settle } = createRouter(client, async () => ({
      cfg: adminsCfg,
      allowFrom: ["accessGroup:admins"],
    }));

    expect(route()).toBe(true);
    await settle();

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops the notice when membership is revoked while the crypto lookup was pending", async () => {
    const { client, sendMessage } = createClient();
    const authorizations = [
      { cfg: adminsCfg, allowFrom: ["accessGroup:admins"] },
      { cfg: revokedCfg, allowFrom: ["accessGroup:admins"] },
    ];
    const { route, settle } = createRouter(client, async () => authorizations.shift()!);

    expect(route()).toBe(true);
    await settle();

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

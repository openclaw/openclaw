import { describe, expect, it, vi } from "vitest";
import { imessagePlugin } from "./channel.js";

const messaging = imessagePlugin.messaging!;
type RouteConfig = Parameters<NonNullable<typeof messaging.resolveOutboundSessionRoute>>[0]["cfg"];
const routeTo = (target: string, cfg: RouteConfig = {}) =>
  messaging.resolveOutboundSessionRoute!({ cfg, agentId: "main", target });
const resolveTarget = (target: string, cfg: RouteConfig = {}) =>
  messaging.targetResolver!.resolveTarget!({ cfg, input: target, normalized: target });

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: async () => ({
    request: async () => ({
      chats: [
        { id: 42, guid: "iMessage;-;+15551234567", identifier: "+15551234567" },
        { id: 43, guid: "iMessage;+;chat123", identifier: "team-thread" },
      ],
    }),
    stop: async () => {},
  }),
}));

describe("iMessage outbound session routing", () => {
  it("keeps a service-qualified contact alias as target presentation", async () => {
    const resolved = await resolveTarget("imessage:Alice");

    expect(resolved).toMatchObject({ to: "imessage:Alice", display: "Alice" });
  });

  it.each([
    ["+15551234567", true],
    ["+1 (555) 123-4567", true],
    ["imessage:User@Example.com", true],
    ["imessage:Alice", false],
    ["alice@example", false],
    ["1-800-FLOWERS", false],
    ["chat_id:42", true],
    ["chat_guid:iMessage;+;chat123", false],
    ["chat_identifier:team-thread", false],
  ] as const)("reports canonical identity for %s", async (target, exact) => {
    expect(await routeTo(target)).toMatchObject({ recipientSessionExact: exact });
  });

  it.each([
    ["direct reply", "chat_id:42", false],
    ["explicit chat ID send", "chat_id:42", true],
    ["explicit GUID send", "chat_guid:iMessage;-;+15551234567", true],
    ["explicit identifier send", "chat_identifier:+15551234567", true],
  ] as const)("keeps a %s on the direct session", async (_name, target, explicit) => {
    const cfg = { session: { dmScope: "per-channel-peer" as const } };
    if (explicit) {
      expect(await resolveTarget(target, cfg)).toMatchObject({ to: target, kind: "user" });
    }
    expect(await routeTo(target, cfg)).toMatchObject({
      sessionKey: "agent:main:imessage:direct:+15551234567",
      peer: { kind: "direct", id: "+15551234567" },
      chatType: "direct",
      from: "imessage:+15551234567",
      to: target,
      recipientSessionExact: true,
    });
  });

  it.each([
    ["native group", "chat_id:43", {}, "43"],
    ["native group GUID", "chat_guid:iMessage;+;chat123", {}, "43"],
    ["configured group", "chat_id:42", { channels: { imessage: { groups: { "42": {} } } } }, "42"],
    [
      "named default account group",
      "chat_id:42",
      {
        channels: {
          imessage: { defaultAccount: "work", accounts: { work: { groups: { "42": {} } } } },
        },
      },
      "42",
    ],
  ] as const)("keeps a %s on the group session", async (_name, target, cfg, id) => {
    expect(await resolveTarget(target, cfg)).toMatchObject({ to: target, kind: "group" });
    expect(await routeTo(target, cfg)).toMatchObject({
      sessionKey: `agent:main:imessage:group:${id}`,
      peer: { kind: "group", id },
      to: target,
    });
  });

  it("uses the resolved default account for account-scoped direct sessions", async () => {
    expect(
      await routeTo("chat_id:42", {
        channels: { imessage: { defaultAccount: "work", accounts: { work: {} } } },
        session: { dmScope: "per-account-channel-peer" },
      }),
    ).toMatchObject({ sessionKey: "agent:main:imessage:work:direct:+15551234567" });
  });

  it("does not invent a session for an unresolved chat ID", async () => {
    expect(await routeTo("chat_id:999")).toBeNull();
  });

  it.each([
    [undefined, "+15551234567", "auto"],
    ["sms", "+15551234567", "sms"],
    ["imessage", "sms:+15551234567", "sms"],
    ["sms", "auto:+15551234567", "auto"],
  ] as const)(
    "routes configured %s target %s using %s",
    async (service, target, expectedService) => {
      const cfg = service ? { channels: { imessage: { service } } } : {};
      expect(await routeTo(target, cfg)).toMatchObject({
        from: `${expectedService}:+15551234567`,
        to: `${expectedService}:+15551234567`,
      });
    },
  );
});

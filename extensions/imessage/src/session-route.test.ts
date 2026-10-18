import { describe, expect, it, vi } from "vitest";
import { imessagePlugin } from "./channel.js";

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
    const resolved = await imessagePlugin.messaging?.targetResolver?.resolveTarget?.({
      cfg: {},
      input: "imessage:Alice",
      normalized: "imessage:Alice",
    });

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
    const route = await imessagePlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target,
    });

    expect(route?.recipientSessionExact).toBe(exact);
  });

  it.each([
    ["direct reply", "chat_id:42", false],
    ["explicit chat ID send", "chat_id:42", true],
    ["explicit GUID send", "chat_guid:iMessage;-;+15551234567", true],
    ["explicit identifier send", "chat_identifier:+15551234567", true],
  ] as const)("keeps a %s on the direct session", async (_name, target, explicit) => {
    const cfg = { session: { dmScope: "per-channel-peer" as const } };
    const resolvedTarget = explicit
      ? await imessagePlugin.messaging!.targetResolver!.resolveTarget!({
          cfg,
          input: target,
          normalized: target,
        })
      : undefined;
    if (explicit) {
      expect(resolvedTarget).toMatchObject({ to: target, kind: "user" });
    }
    const route = await imessagePlugin.messaging!.resolveOutboundSessionRoute!({
      cfg,
      agentId: "main",
      target,
    });
    expect(route).toMatchObject({
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
    expect(
      await imessagePlugin.messaging!.targetResolver!.resolveTarget!({
        cfg,
        input: target,
        normalized: target,
      }),
    ).toMatchObject({ to: target, kind: "group" });
    expect(
      await imessagePlugin.messaging!.resolveOutboundSessionRoute!({
        cfg,
        agentId: "main",
        target,
      }),
    ).toMatchObject({
      sessionKey: `agent:main:imessage:group:${id}`,
      peer: { kind: "group", id },
      to: target,
    });
  });

  it("uses the resolved default account for account-scoped direct sessions", async () => {
    expect(
      await imessagePlugin.messaging!.resolveOutboundSessionRoute!({
        cfg: {
          channels: { imessage: { defaultAccount: "work", accounts: { work: {} } } },
          session: { dmScope: "per-account-channel-peer" },
        },
        agentId: "main",
        target: "chat_id:42",
      }),
    ).toMatchObject({ sessionKey: "agent:main:imessage:work:direct:+15551234567" });
  });

  it("does not invent a session for an unresolved chat ID", async () => {
    expect(
      await imessagePlugin.messaging!.resolveOutboundSessionRoute!({
        cfg: {},
        agentId: "main",
        target: "chat_id:999",
      }),
    ).toBeNull();
  });

  it.each([
    ["uses auto when a bare direct target has no configured service", {}, "+15551234567", "auto"],
    [
      "uses the configured SMS override for a bare direct target",
      { channels: { imessage: { service: "sms" } } },
      "+15551234567",
      "sms",
    ],
    [
      "keeps an explicit SMS target authoritative",
      { channels: { imessage: { service: "imessage" } } },
      "sms:+15551234567",
      "sms",
    ],
    [
      "keeps an explicit auto target authoritative",
      { channels: { imessage: { service: "sms" } } },
      "auto:+15551234567",
      "auto",
    ],
  ] as const)("%s", async (_label, cfg, target, expectedService) => {
    const route = await imessagePlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg,
      agentId: "main",
      target,
    });

    expect(route).toMatchObject({
      from: `${expectedService}:+15551234567`,
      to: `${expectedService}:+15551234567`,
    });
  });
});

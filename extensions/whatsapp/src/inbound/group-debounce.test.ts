import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  buildWhatsAppInboundDebounceKey,
  formatBatchedWhatsAppInboundBody,
  resolveWhatsAppGroupDebounceConfig,
  resolveWhatsAppInboundDebounceConfig,
  resolveWhatsAppInboundQueueLaneDecision,
  selectBatchedWhatsAppInboundAnchor,
} from "./monitor.js";
import type { WebInboundMessage } from "./types.js";

const noop = async () => undefined;
const GROUP_ID = "120363406331109499@g.us";
const SELF_JID = "919152233366@s.whatsapp.net";
const SELF_LID = "57711827927237@lid";

const conversationCfg = {
  agents: {
    list: [{ id: "main", name: "shoar" }],
  },
  channels: {
    whatsapp: {
      groups: {
        [GROUP_ID]: {
          debounceScope: "conversation",
        },
      },
    },
  },
} as unknown as OpenClawConfig;

function groupMsg(body: string, overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  const senderJid = overrides.senderJid ?? "111@s.whatsapp.net";
  const senderName = overrides.senderName ?? "Abhay";
  return {
    id: overrides.id,
    from: GROUP_ID,
    conversationId: GROUP_ID,
    to: "+57711827927237",
    accountId: "default",
    body,
    chatType: "group",
    chatId: GROUP_ID,
    sender: {
      jid: senderJid,
      e164: overrides.senderE164,
      name: senderName,
    },
    senderJid,
    senderE164: overrides.senderE164,
    senderName,
    self: {
      jid: SELF_JID,
      lid: SELF_LID,
      e164: "+919152233366",
    },
    selfJid: SELF_JID,
    selfLid: SELF_LID,
    selfE164: "+919152233366",
    sendComposing: noop,
    reply: noop,
    sendMedia: noop,
    ...overrides,
  };
}

function priorityLaneCfg(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", name: "shoar" }],
    },
    channels: {
      whatsapp: {
        allowFrom: ["+919022233366"],
        groups: {
          [GROUP_ID]: {
            debounceScope: "conversation",
            priorityLanes: {
              enabled: true,
              directOwnerPull: { debounceMs: 1200, maxWaitMs: 3500, maxBatchItems: 5 },
              bothBotAsk: { debounceMs: 2500, maxWaitMs: 6000, maxBatchItems: 6 },
              ambientRoomBurst: { debounceMs: 4500, maxWaitMs: 9000, maxBatchItems: 12 },
              otherTargetAmbient: { debounceMs: 4500, maxWaitMs: 9000, maxBatchItems: 12 },
            },
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("WhatsApp group inbound debounce", () => {
  it("resolves conversation-scoped group debounce from config", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "120363406331109499@g.us": {
              debounceScope: "conversation",
              debounceMs: 4500,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveWhatsAppGroupDebounceConfig({
        cfg,
        accountId: "default",
        msg: groupMsg("shoar wdyt"),
      }),
    ).toEqual({ scope: "conversation", debounceMs: 4500 });
  });

  it("shares a room key across senders only when conversation scope is enabled", () => {
    const senderCfg = { channels: { whatsapp: { groups: {} } } } as unknown as OpenClawConfig;
    const abhay = groupMsg("Brodie check this", {
      senderJid: "111@s.whatsapp.net",
      senderName: "Abhay",
    });
    const kavish = groupMsg("oooo", {
      senderJid: "222@s.whatsapp.net",
      senderName: "Kavish",
    });

    expect(
      buildWhatsAppInboundDebounceKey({ cfg: conversationCfg, accountId: "default", msg: abhay }),
    ).toBe(
      buildWhatsAppInboundDebounceKey({ cfg: conversationCfg, accountId: "default", msg: kavish }),
    );
    expect(
      buildWhatsAppInboundDebounceKey({ cfg: senderCfg, accountId: "default", msg: abhay }),
    ).not.toBe(
      buildWhatsAppInboundDebounceKey({ cfg: senderCfg, accountId: "default", msg: kavish }),
    );
  });

  it("keeps direct WhatsApp DMs on sender-scoped debounce", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "*": {
              debounceScope: "conversation",
              debounceMs: 4500,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const direct = {
      ...groupMsg("ask Brodie to check this"),
      from: "+111",
      conversationId: "+111",
      chatType: "direct" as const,
      chatId: "111@s.whatsapp.net",
    };

    expect(resolveWhatsAppGroupDebounceConfig({ cfg, accountId: "default", msg: direct })).toEqual({
      scope: "sender",
    });
    expect(buildWhatsAppInboundDebounceKey({ cfg, accountId: "default", msg: direct })).toBe(
      "default:+111:+111",
    );
  });

  it("keeps self-addressed group tasks sender-scoped inside conversation debounce", () => {
    const abhayTask = groupMsg("shoar.. can you give us diff stats?", {
      senderJid: "111@s.whatsapp.net",
      senderName: "Abhay",
    });
    const kavishSideComment = groupMsg("oh i know what codex did hahaha", {
      senderJid: "222@s.whatsapp.net",
      senderName: "Kavish",
    });

    expect(
      buildWhatsAppInboundDebounceKey({
        cfg: conversationCfg,
        accountId: "default",
        msg: abhayTask,
      }),
    ).toBe("default:120363406331109499@g.us:111@s.whatsapp.net");
    expect(
      buildWhatsAppInboundDebounceKey({
        cfg: conversationCfg,
        accountId: "default",
        msg: abhayTask,
      }),
    ).not.toBe(
      buildWhatsAppInboundDebounceKey({
        cfg: conversationCfg,
        accountId: "default",
        msg: kavishSideComment,
      }),
    );
  });

  it("uses shorter self-addressed debounce while preserving room max controls", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", name: "shoar" }],
      },
      channels: {
        whatsapp: {
          groups: {
            [GROUP_ID]: {
              debounceScope: "conversation",
              debounceMs: 4500,
              selfAddressedDebounceMs: 2500,
              debounceMaxWaitMs: 5000,
              debounceMaxBatchItems: 8,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveWhatsAppInboundDebounceConfig({
        cfg,
        accountId: "default",
        msg: groupMsg("shoar can you check this"),
      }),
    ).toEqual({
      scope: "conversation",
      debounceMs: 2500,
      selfAddressedDebounceMs: 2500,
      debounceMaxWaitMs: 5000,
      debounceMaxBatchItems: 8,
    });
    expect(
      resolveWhatsAppInboundDebounceConfig({
        cfg,
        accountId: "default",
        msg: groupMsg("room check this"),
      }),
    ).toEqual({
      scope: "conversation",
      debounceMs: 4500,
      selfAddressedDebounceMs: 2500,
      debounceMaxWaitMs: 5000,
      debounceMaxBatchItems: 8,
    });
  });

  it("keeps a Kavish self-pull out of an ambient Brodie and Abhay room burst", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", name: "shoar" }],
      },
      channels: {
        whatsapp: {
          groups: {
            [GROUP_ID]: {
              debounceScope: "conversation",
              debounceMs: 4500,
              selfAddressedDebounceMs: 2500,
              debounceMaxWaitMs: 5000,
              debounceMaxBatchItems: 8,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const abhayAmbient = groupMsg("this is wild", {
      senderJid: "111@s.whatsapp.net",
      senderName: "Abhay",
    });
    const brodieAmbient = groupMsg("agreed", {
      senderJid: "333@s.whatsapp.net",
      senderName: "Brodie",
    });
    const kavishPull = groupMsg("shoar pls confirm you can hear me", {
      senderJid: "222@s.whatsapp.net",
      senderName: "Kavish",
    });

    expect(
      buildWhatsAppInboundDebounceKey({
        cfg,
        accountId: "default",
        msg: abhayAmbient,
      }),
    ).toBe("default:120363406331109499@g.us:conversation");
    expect(
      buildWhatsAppInboundDebounceKey({
        cfg,
        accountId: "default",
        msg: brodieAmbient,
      }),
    ).toBe("default:120363406331109499@g.us:conversation");
    expect(
      buildWhatsAppInboundDebounceKey({
        cfg,
        accountId: "default",
        msg: kavishPull,
      }),
    ).toBe("default:120363406331109499@g.us:222@s.whatsapp.net");
    expect(
      resolveWhatsAppInboundDebounceConfig({ cfg, accountId: "default", msg: kavishPull }),
    ).toMatchObject({
      debounceMs: 2500,
      debounceMaxWaitMs: 5000,
      debounceMaxBatchItems: 8,
    });
  });

  it("sender-scopes loose self aliases, self mentions, and replies to self", () => {
    const spacedAlias = groupMsg("s h o a r");
    const lidMention = groupMsg("do this", { mentionedJids: [SELF_LID] });
    const replyToSelf = groupMsg("do this", {
      replyToBody: "earlier shoar reply",
      replyToSenderJid: SELF_JID,
    });

    for (const msg of [spacedAlias, lidMention, replyToSelf]) {
      expect(
        buildWhatsAppInboundDebounceKey({
          cfg: conversationCfg,
          accountId: "default",
          msg,
        }),
      ).toBe("default:120363406331109499@g.us:111@s.whatsapp.net");
    }
  });

  it("labels cross-sender room beats while keeping same-sender fragments compact", () => {
    expect(
      formatBatchedWhatsAppInboundBody([
        groupMsg("secret weapon queue", {
          senderJid: "111@s.whatsapp.net",
          senderName: "Abhay",
        }),
        groupMsg("oooo", {
          senderJid: "222@s.whatsapp.net",
          senderName: "Kavish",
        }),
      ]),
    ).toBe("Abhay: secret weapon queue\nKavish: oooo");

    expect(formatBatchedWhatsAppInboundBody([groupMsg("shoar"), groupMsg("wdyt")])).toBe(
      "shoar\nwdyt",
    );
  });

  it("anchors a batched room beat on the latest direct self pull", () => {
    const selfPull = groupMsg("shoar can you check this", {
      id: "direct",
      senderJid: "222@s.whatsapp.net",
      senderName: "Kavish",
    });
    const laterAmbient = groupMsg("lol wait", {
      id: "ambient",
      senderJid: "333@s.whatsapp.net",
      senderName: "Abhay",
    });

    expect(
      selectBatchedWhatsAppInboundAnchor({
        cfg: conversationCfg,
        entries: [selfPull, laterAmbient],
      })?.id,
    ).toBe("direct");
  });

  it("uses priority lane keys and values when enabled for Bot Bros", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", name: "shoar" }],
      },
      channels: {
        whatsapp: {
          allowFrom: ["+919022233366"],
          groups: {
            [GROUP_ID]: {
              debounceScope: "conversation",
              priorityLanes: {
                enabled: true,
                directOwnerPull: { debounceMs: 1200, maxWaitMs: 3500, maxBatchItems: 5 },
                ambientRoomBurst: { debounceMs: 4500, maxWaitMs: 9000, maxBatchItems: 12 },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const ownerPull = groupMsg("shoar pls confirm", {
      senderJid: "919022233366@s.whatsapp.net",
      senderE164: "+919022233366",
      senderName: "Kavish",
    });
    const ambient = groupMsg("this is wild", {
      senderJid: "333@s.whatsapp.net",
      senderName: "Brodie",
    });

    expect(
      resolveWhatsAppInboundQueueLaneDecision({ cfg, accountId: "default", msg: ownerPull }),
    ).toMatchObject({
      id: "direct_owner_pull",
      priority: 1,
      debounceMs: 1200,
      maxWaitMs: 3500,
      maxBatchItems: 5,
    });
    expect(buildWhatsAppInboundDebounceKey({ cfg, accountId: "default", msg: ownerPull })).toBe(
      "default:120363406331109499@g.us:lane:direct_owner_pull",
    );
    expect(buildWhatsAppInboundDebounceKey({ cfg, accountId: "default", msg: ambient })).toBe(
      "default:120363406331109499@g.us:lane:ambient_room_burst",
    );
    expect(
      resolveWhatsAppInboundDebounceConfig({ cfg, accountId: "default", msg: ambient }),
    ).toMatchObject({
      debounceMs: 4500,
      debounceMaxWaitMs: 9000,
      debounceMaxBatchItems: 12,
    });
  });

  it("promotes owner behavior complaints to the direct owner lane", () => {
    const cfg = priorityLaneCfg();
    const ownerPull = groupMsg("classic, the inline thing isnt working either", {
      senderJid: "919022233366@s.whatsapp.net",
      senderE164: "+919022233366",
      senderName: "Kavish",
    });

    expect(
      resolveWhatsAppInboundQueueLaneDecision({ cfg, accountId: "default", msg: ownerPull }),
    ).toMatchObject({
      id: "direct_owner_pull",
      priority: 1,
      reason: "owner_direct_pull",
    });
    expect(buildWhatsAppInboundDebounceKey({ cfg, accountId: "default", msg: ownerPull })).toBe(
      "default:120363406331109499@g.us:lane:direct_owner_pull",
    );
  });

  it("keeps owner multi-agent asks foreground without stealing other-agent tasks", () => {
    const cfg = priorityLaneCfg();
    const ownerAsk = groupMsg("why did nobody simplify it?", {
      senderJid: "919022233366@s.whatsapp.net",
      senderE164: "+919022233366",
      senderName: "Kavish",
    });
    const brodieTask = groupMsg("Brodie can you check this?", {
      senderJid: "919022233366@s.whatsapp.net",
      senderE164: "+919022233366",
      senderName: "Kavish",
    });

    expect(
      resolveWhatsAppInboundQueueLaneDecision({ cfg, accountId: "default", msg: ownerAsk }),
    ).toMatchObject({
      id: "both_bot_ask",
      priority: 3,
    });
    expect(
      resolveWhatsAppInboundQueueLaneDecision({ cfg, accountId: "default", msg: brodieTask }),
    ).toMatchObject({
      id: "other_target_ambient",
      priority: 5,
    });
  });

  it("anchors batched room beats on owner pulls before later ambient", () => {
    const cfg = priorityLaneCfg();
    const ownerPull = groupMsg("why did you disappear after typing?", {
      id: "direct",
      senderJid: "919022233366@s.whatsapp.net",
      senderE164: "+919022233366",
      senderName: "Kavish",
    });
    const laterAmbient = groupMsg("lol wait", {
      id: "ambient",
      senderJid: "333@s.whatsapp.net",
      senderName: "Abhay",
    });

    expect(
      selectBatchedWhatsAppInboundAnchor({
        cfg,
        entries: [ownerPull, laterAmbient],
      })?.id,
    ).toBe("direct");
  });
});

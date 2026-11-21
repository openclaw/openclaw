import { expect, it, vi } from "vitest";
import { handleWhatsAppMessageAction } from "./channel-react-action.js";
import { createWebSendApi } from "./inbound/send-api.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { cacheInboundMessageMeta } from "./quoted-message.js";

const connection = vi.hoisted(() => ({ listener: undefined as ActiveWebListener | undefined }));
vi.mock("./connection-controller-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection-controller-runtime-context.js")>()),
  getWhatsAppConnectionController: () => ({ getActiveListener: () => connection.listener }),
}));
const cfg = {
  channels: {
    whatsapp: { allowFrom: ["*"], actions: { reactions: true }, reactionLevel: "minimal" as const },
  },
};
const group = "120363000000000000@g.us";
const lid = "900000001@lid";
const pn = "15550001111@s.whatsapp.net";
type KeyFields = { fromMe?: boolean; participant?: string };

it.each<{
  label: string;
  cached?: KeyFields;
  explicit?: KeyFields;
  implicitId?: boolean;
  expected: KeyFields;
}>([
  {
    label: "received LID",
    cached: { fromMe: false, participant: lid },
    expected: { fromMe: false, participant: lid },
  },
  {
    label: "outbound",
    cached: { fromMe: true },
    expected: { fromMe: true, participant: undefined },
  },
  {
    label: "explicit overrides",
    cached: { fromMe: true, participant: lid },
    explicit: { fromMe: false, participant: pn },
    expected: { fromMe: false, participant: pn },
  },
  {
    label: "implicit current ID",
    implicitId: true,
    cached: { fromMe: false, participant: lid },
    expected: { fromMe: false, participant: lid },
  },
  { label: "uncached explicit ID", expected: { fromMe: false, participant: undefined } },
  { label: "uncached implicit ID", implicitId: true, expected: { fromMe: false, participant: pn } },
])("preserves the final reaction target key: $label", async (row) => {
  const messageId = `synthetic-${row.label}`;
  const sock = {
    sendMessage: vi.fn<Parameters<typeof createWebSendApi>[0]["sock"]["sendMessage"]>(
      async (jid) => ({ key: { id: "synthetic-reaction", remoteJid: jid, fromMe: true } }),
    ),
    sendPresenceUpdate: vi.fn(async () => {}),
  };
  connection.listener = createWebSendApi({ sock, defaultAccountId: "default" });
  if (row.cached) {
    cacheInboundMessageMeta("default", group, messageId, row.cached);
  }
  await handleWhatsAppMessageAction({
    action: "react",
    cfg,
    requesterSenderId: pn,
    params: { emoji: "🧪", ...(row.implicitId ? {} : { messageId }), ...row.explicit },
    toolContext: {
      currentChannelProvider: "whatsapp",
      currentChannelId: group,
      currentMessageId: messageId,
    },
  });
  expect(sock.sendMessage).toHaveBeenCalledExactlyOnceWith(group, {
    react: { text: "🧪", key: { remoteJid: group, id: messageId, ...row.expected } },
  });
});

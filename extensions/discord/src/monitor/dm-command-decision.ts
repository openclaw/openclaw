import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";

export async function handleDiscordDmCommandDecision(params: {
  senderAccess: Pick<ResolvedChannelMessageIngress["senderAccess"], "decision">;
  accountId: string;
  sender: {
    id: string;
    tag?: string;
    name?: string;
  };
  onPairingCreated: (code: string) => Promise<void>;
  onUnauthorized: () => Promise<void>;
}): Promise<void> {
  if (params.senderAccess.decision === "pairing") {
    const result = await createChannelPairingChallengeIssuer({
      channel: "discord",
      accountId: params.accountId,
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertChannelPairingRequest({
          channel: "discord",
          id,
          accountId: params.accountId,
          meta,
        }),
    })({
      senderId: params.sender.id,
      senderIdLine: `Your Discord user id: ${params.sender.id}`,
      meta: {
        tag: params.sender.tag,
        name: params.sender.name,
      },
      sendPairingReply: async () => {},
    });
    if (result.created && result.code) {
      await params.onPairingCreated(result.code);
    }
    return;
  }

  await params.onUnauthorized();
}

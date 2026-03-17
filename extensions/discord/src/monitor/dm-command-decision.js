import { issuePairingChallenge } from "../../../../src/pairing/pairing-challenge.js";
import { upsertChannelPairingRequest } from "../../../../src/pairing/pairing-store.js";
async function handleDiscordDmCommandDecision(params) {
  if (params.dmAccess.decision === "allow") {
    return true;
  }
  if (params.dmAccess.decision === "pairing") {
    const upsertPairingRequest = params.upsertPairingRequest ?? upsertChannelPairingRequest;
    const result = await issuePairingChallenge({
      channel: "discord",
      senderId: params.sender.id,
      senderIdLine: `Your Discord user id: ${params.sender.id}`,
      meta: {
        tag: params.sender.tag,
        name: params.sender.name
      },
      upsertPairingRequest: async ({ id, meta }) => await upsertPairingRequest({
        channel: "discord",
        id,
        accountId: params.accountId,
        meta
      }),
      sendPairingReply: async () => {
      }
    });
    if (result.created && result.code) {
      await params.onPairingCreated(result.code);
    }
    return false;
  }
  await params.onUnauthorized();
  return false;
}
export {
  handleDiscordDmCommandDecision
};

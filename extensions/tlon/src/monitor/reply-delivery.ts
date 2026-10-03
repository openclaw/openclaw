// Tlon monitor reply delivery keeps DM, club, and channel wire contracts separate.
import { parseChannelNest } from "../targets.js";
import { sendClubMessage, sendDm, sendGroupMessage } from "../urbit/send.js";

type TlonReplyApi = {
  poke: (params: { app: string; mark: string; json: unknown }) => Promise<unknown>;
};

export async function deliverTlonReply(params: {
  api: TlonReplyApi;
  botShipName: string;
  senderShip: string;
  text: string;
  channelNest?: string;
  clubId?: string;
  parentId?: string | null;
}): Promise<{ visibleReplySent: boolean; replyToId?: string }> {
  if (params.clubId) {
    await sendClubMessage({
      api: params.api,
      fromShip: params.botShipName,
      clubId: params.clubId,
      text: params.text,
    });
    return { visibleReplySent: true };
  }

  if (params.channelNest) {
    const parsed = parseChannelNest(params.channelNest);
    if (!parsed) {
      return { visibleReplySent: false };
    }
    await sendGroupMessage({
      api: params.api,
      fromShip: params.botShipName,
      hostShip: parsed.hostShip,
      channelName: parsed.channelName,
      text: params.text,
      replyToId: params.parentId ?? undefined,
    });
    return { visibleReplySent: true, replyToId: params.parentId ?? undefined };
  }

  await sendDm({
    api: params.api,
    fromShip: params.botShipName,
    toShip: params.senderShip,
    text: params.text,
  });
  return { visibleReplySent: true };
}

import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { sendSmsViaTwilio } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

export async function sendSmsTextChunks(params: {
  account: ResolvedSmsAccount;
  to: string;
  text: string;
}): Promise<Array<{ sid: string; to: string }>> {
  const chunks = chunkTextForOutbound(params.text, params.account.textChunkLimit).filter(Boolean);
  const sendChunks = chunks.length ? chunks : [params.text];
  const results: Array<{ sid: string; to: string }> = [];
  for (const text of sendChunks) {
    results.push(
      await sendSmsViaTwilio({
        account: params.account,
        to: params.to,
        text,
      }),
    );
  }
  return results;
}

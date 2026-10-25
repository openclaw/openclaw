import type { CoreConfig } from "../types.js";
import { chunkMatrixText } from "./send/chunking.js";
import type { MatrixSendOpts, MatrixSendResult } from "./send/types.js";

/** One quiet text lane for both live dispatch and retained follow-up delivery. */
export async function sendMatrixReasoningNotices(params: {
  text: string;
  cfg: CoreConfig;
  accountId?: string;
  shouldDeliver: () => boolean;
  assertDirectAdapterHandoff?: () => void;
  send: (
    text: string,
    options: Pick<MatrixSendOpts, "extraContent" | "assertDirectAdapterHandoff">,
  ) => Promise<MatrixSendResult>;
}): Promise<MatrixSendResult[]> {
  const results: MatrixSendResult[] = [];
  const { chunks } = chunkMatrixText(params.text, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  for (const chunk of chunks) {
    if (!params.shouldDeliver()) {
      break;
    }
    let suppressed = false;
    try {
      results.push(
        await params.send(chunk, {
          extraContent: { msgtype: "m.notice", "m.mentions": {} },
          assertDirectAdapterHandoff: () => {
            params.assertDirectAdapterHandoff?.();
            if (!params.shouldDeliver()) {
              suppressed = true;
              throw new DOMException("Matrix reasoning visibility revoked", "AbortError");
            }
          },
        }),
      );
    } catch (error) {
      if (!suppressed) {
        throw error;
      }
      break;
    }
  }
  return results;
}

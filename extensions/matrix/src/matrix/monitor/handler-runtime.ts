import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MatrixClient } from "../sdk.js";

export type MatrixDraftStreamHandle = ReturnType<
  typeof import("../draft-stream.js").createMatrixDraftStream
>;

export const loadMatrixSendModule = createLazyRuntimeModule(() => import("../send.js"));

export const loadAcpBindingRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/acp-binding-runtime"),
);

export const loadSessionBindingRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/session-binding-runtime"),
);

export const loadMatrixReactionEvents = createLazyRuntimeModule(
  () => import("./reaction-events.js"),
);

export const loadMatrixDraftStream = createLazyRuntimeModule(() => import("../draft-stream.js"));

export async function matrixTextWouldActivateMentions(
  client: MatrixClient,
  text: string,
): Promise<boolean> {
  const { resolveMatrixMentionsForBody } = await loadMatrixSendModule();
  const mentions = await resolveMatrixMentionsForBody({ client, body: text });
  return mentions.room === true || (mentions.user_ids?.length ?? 0) > 0;
}

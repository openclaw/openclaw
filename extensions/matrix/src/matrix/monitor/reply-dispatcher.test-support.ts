import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";

type DispatcherConfig = Parameters<typeof createMatrixReplyDispatcher>[0];
export type MatrixTestReplyOptions = Pick<DispatcherConfig, "client" | "runtime"> &
  Partial<
    Pick<
      DispatcherConfig,
      | "cfg"
      | "roomId"
      | "accountId"
      | "replyToMode"
      | "threadTarget"
      | "replyToEventId"
      | "mediaLocalRoots"
    >
  >;

export async function createMatrixTestReplyDispatcher(options: MatrixTestReplyOptions) {
  const context = {
    cfg: { channels: { matrix: {} } },
    roomId: "!room:example.org",
    accountId: "default",
    mediaLocalRoots: [],
    ...options,
    replyToMode: options.replyToMode ?? "off",
    streaming: "off",
    logVerboseMessage: () => {},
  } satisfies Pick<
    DispatcherConfig,
    | "cfg"
    | "roomId"
    | "accountId"
    | "mediaLocalRoots"
    | "client"
    | "runtime"
    | "replyToMode"
    | "streaming"
    | "logVerboseMessage"
  >;
  const draftController = await createMatrixDraftController({
    ...context,
    messageId: options.replyToEventId ?? "$incoming",
    threadTarget: options.threadTarget,
    previewToolProgressEnabled: false,
  });
  return createMatrixReplyDispatcher({
    ...context,
    draftController,
    draftStream: undefined,
    prefixOptions: { responsePrefixContextProvider: () => ({}) },
    humanDelay: undefined,
    typingCallbacks: createTypingCallbacks({ start: async () => {}, onStartError: () => {} }),
  });
}

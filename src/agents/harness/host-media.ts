import { bindHarnessContextMedia } from "./context-media.js";
import { bindHarnessInputAttachments } from "./input-attachments.js";
import { bindHarnessReplyMedia } from "./reply-media.js";

/** Bind media capabilities to the same captured attempt policy and host lifetime. */
export function bindHarnessMedia(params: Parameters<typeof bindHarnessReplyMedia>[0]) {
  const { prepareInputAttachments, setInputAttachmentReadAllowed } =
    bindHarnessInputAttachments(params);
  const prepareContextMedia = bindHarnessContextMedia(params);
  const prepareReplyMedia = bindHarnessReplyMedia(params);
  return {
    capabilities: {
      ...(prepareContextMedia ? { prepareContextMedia } : {}),
      ...(prepareInputAttachments ? { prepareInputAttachments } : {}),
      ...(prepareReplyMedia ? { prepareReplyMedia } : {}),
    },
    setInputAttachmentReadAllowed,
  };
}

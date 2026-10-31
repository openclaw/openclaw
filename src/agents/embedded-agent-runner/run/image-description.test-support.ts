import type { RuntimeMsgContext as MsgContext } from "../../../auto-reply/templating.js";

export const describedImageUnderstanding = (): NonNullable<MsgContext["MediaUnderstanding"]> => [
  {
    kind: "image.description",
    attachmentIndex: 0,
    text: "already described",
    provider: "test",
  },
];

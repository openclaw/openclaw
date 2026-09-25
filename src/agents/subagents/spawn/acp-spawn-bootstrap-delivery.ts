import type { AcpTurnAttachment } from "../../../acp/control-plane/manager.types.js";

type GatewayImageAttachmentInput = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export function toGatewayImageAttachments(
  attachments: AcpTurnAttachment[] | undefined,
): GatewayImageAttachmentInput[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.mediaType,
      data: attachment.data,
    },
  }));
}

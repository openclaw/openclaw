import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";

export const matrixPresentationCapabilities = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  limits: {
    text: {
      markdownDialect: "markdown",
      supportsEdit: true,
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

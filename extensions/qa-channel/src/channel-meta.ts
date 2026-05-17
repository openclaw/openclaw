export const QA_CHANNEL_ID = "qa-channel" as const;

export const qaChannelMeta = {
  id: QA_CHANNEL_ID,
  label: "QA Channel",
  selectionLabel: "QA Channel (Synthetic)",
  detailLabel: "QA Channel",
  docsPath: "/channels/qa-channel",
  docsLabel: "qa-channel",
  blurb: "Synthetic Slack-class transport for automated OpenClaw QA scenarios.",
  systemImage: "checklist",
  order: 999,
  exposure: {
    configured: false,
    setup: false,
    docs: false,
  },
};

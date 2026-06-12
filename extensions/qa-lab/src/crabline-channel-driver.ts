// Qa Lab plugin module models SDK-backed Crabline channel-driver metadata.

export type QaChannelDriverId = "crabline";
export type QaCrablineChannelId = "telegram";

export type QaCrablineChannelDriverSelection = {
  channel: QaCrablineChannelId;
  channelDriver: QaChannelDriverId;
  channelDriverId: "telegram-local-v1";
  channelLive: false;
  capabilityMatrixPath: typeof QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
};

export type QaCrablineChannelCapabilityStatus = "covered" | "planned";

export type QaCrablineChannelCapabilityRow = {
  capabilityId: string;
  channel: string;
  driverId?: string;
  notes: string;
  status: QaCrablineChannelCapabilityStatus;
};

export type QaCrablineChannelCapabilityMatrix = {
  version: 1;
  source: "openclaw/crabline";
  channelDriver: QaChannelDriverId;
  selectedChannel: QaCrablineChannelId;
  rows: readonly QaCrablineChannelCapabilityRow[];
};

export const QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH = "crabline-channel-capability-matrix.json";

const SUPPORTED_CRABLINE_CHANNELS = ["telegram"] as const satisfies readonly QaCrablineChannelId[];

export function normalizeQaChannelDriverId(input?: string | null): QaChannelDriverId | null {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "crabline") {
    return "crabline";
  }
  throw new Error(`--channel-driver must be crabline, got "${input}".`);
}

export function normalizeQaCrablineChannel(input?: string | null): QaCrablineChannelId {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    throw new Error("--channel is required when --channel-driver crabline is set.");
  }
  if (SUPPORTED_CRABLINE_CHANNELS.includes(normalized as QaCrablineChannelId)) {
    return normalized as QaCrablineChannelId;
  }
  throw new Error(
    `--channel must be one of ${SUPPORTED_CRABLINE_CHANNELS.join(", ")} for --channel-driver crabline, got "${input}".`,
  );
}

export function resolveQaCrablineChannelDriverSelection(params: {
  channel?: string | null;
  channelDriver?: string | null;
}): QaCrablineChannelDriverSelection | null {
  const channelDriver = normalizeQaChannelDriverId(params.channelDriver);
  if (!channelDriver) {
    if (params.channel?.trim()) {
      throw new Error("--channel requires --channel-driver crabline.");
    }
    return null;
  }

  const channel = normalizeQaCrablineChannel(params.channel);
  return {
    channel,
    channelDriver,
    channelDriverId: "telegram-local-v1",
    channelLive: false,
    capabilityMatrixPath: QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
  };
}

export function buildQaCrablineChannelCapabilityMatrix(
  selection: QaCrablineChannelDriverSelection,
): QaCrablineChannelCapabilityMatrix {
  return {
    version: 1,
    source: "openclaw/crabline",
    channelDriver: selection.channelDriver,
    selectedChannel: selection.channel,
    rows: [
      {
        capabilityId: "telegram.dm.text",
        channel: "telegram",
        driverId: selection.channelDriverId,
        notes: "Direct-message text turn with source-visible transcript assertions.",
        status: "covered",
      },
      {
        capabilityId: "telegram.group.mention",
        channel: "telegram",
        driverId: selection.channelDriverId,
        notes: "Group mention semantics for routing and reply isolation.",
        status: "covered",
      },
      {
        capabilityId: "telegram.group.topic",
        channel: "telegram",
        driverId: selection.channelDriverId,
        notes: "Forum topic/thread identity for group conversations.",
        status: "covered",
      },
      {
        capabilityId: "telegram.action.inline_button",
        channel: "telegram",
        driverId: selection.channelDriverId,
        notes: "Native approval/action event shape.",
        status: "covered",
      },
      {
        capabilityId: "telegram.media.metadata",
        channel: "telegram",
        driverId: selection.channelDriverId,
        notes: "Media/location metadata placeholder coverage.",
        status: "covered",
      },
      {
        capabilityId: "telegram.connection.reconnect",
        channel: "telegram",
        driverId: selection.channelDriverId,
        notes: "Reconnect marker for future Gateway recovery assertions.",
        status: "covered",
      },
      {
        capabilityId: "discord.dm.text",
        channel: "discord",
        notes: "Planned local Discord upstream driver.",
        status: "planned",
      },
      {
        capabilityId: "slack.dm.text",
        channel: "slack",
        notes: "Planned local Slack upstream driver.",
        status: "planned",
      },
      {
        capabilityId: "whatsapp.dm.text",
        channel: "whatsapp",
        notes: "Planned local WhatsApp upstream driver.",
        status: "planned",
      },
    ],
  };
}

export function createQaCrablineChannelReportNotes(
  selection: QaCrablineChannelDriverSelection | null | undefined,
): string[] {
  if (!selection) {
    return [];
  }

  return [
    `Channel driver: ${selection.channelDriver} (${selection.channelDriverId}) for ${selection.channel}, channel_live=false.`,
    `Channel capability matrix: ${selection.capabilityMatrixPath}.`,
    "This is the openclaw/crabline messaging SDK driver path; it is independent of the Canonical Multipass VM runner.",
  ];
}

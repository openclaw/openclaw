// Qa Lab plugin module models SDK-backed Crabline channel-driver metadata.
import {
  runLocalChannelDriverSmoke,
  type ChannelCapabilityMatrixRow,
  type LocalChannelDriverSmokeResult,
} from "crabline";

export type QaChannelDriverId = "crabline";
export type QaCrablineChannelId = "telegram";

export type QaCrablineChannelDriverSelection = {
  channel: QaCrablineChannelId;
  channelDriver: QaChannelDriverId;
  channelDriverId: "telegram-local-v1";
  channelLive: false;
  capabilityMatrixPath: typeof QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
  smokeArtifactPath: typeof QA_CRABLINE_CHANNEL_SMOKE_PATH;
};

export type QaCrablineChannelCapabilityStatus = "covered" | "planned" | "unsupported";

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
export const QA_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-channel-smoke.json";

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
    smokeArtifactPath: QA_CRABLINE_CHANNEL_SMOKE_PATH,
  };
}

export function buildQaCrablineChannelCapabilityMatrix(
  selection: QaCrablineChannelDriverSelection,
  rows: readonly ChannelCapabilityMatrixRow[],
): QaCrablineChannelCapabilityMatrix {
  return {
    version: 1,
    source: "openclaw/crabline",
    channelDriver: selection.channelDriver,
    selectedChannel: selection.channel,
    rows: rows.map((row) => ({ ...row })),
  };
}

export async function runQaCrablineChannelDriverSmoke(
  selection: QaCrablineChannelDriverSelection,
): Promise<LocalChannelDriverSmokeResult> {
  return await runLocalChannelDriverSmoke({
    channel: selection.channel,
    driverId: selection.channelDriverId,
    manifestPath: "openclaw-qa-lab-crabline-smoke.json",
    userName: "openclaw-qa",
  });
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
    `Channel driver smoke: ${selection.smokeArtifactPath}.`,
    "This is the openclaw/crabline messaging SDK driver path; it is independent of the Canonical Multipass VM runner.",
  ];
}

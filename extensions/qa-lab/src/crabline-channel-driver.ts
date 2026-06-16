// Qa Lab plugin module models SDK-backed Crabline channel-driver metadata.
import {
  findLocalChannelDriver,
  listLocalChannelDriverMatrix,
  runLocalChannelDriverSmoke,
  type LocalChannelDriverSmokeResult,
} from "crabline";

type CrablineChannel = Parameters<typeof runLocalChannelDriverSmoke>[0]["channel"];

export type QaChannelDriverId = "crabline";
export type QaCrablineChannelId = CrablineChannel;

export type QaCrablineChannelDriverSelection = {
  channel: QaCrablineChannelId;
  channelDriver: QaChannelDriverId;
  capabilityMatrixPath: typeof QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
  smokeArtifactPath: typeof QA_CRABLINE_CHANNEL_SMOKE_PATH;
};

export const QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH = "crabline-channel-capability-matrix.json";
export const QA_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-channel-smoke.json";

function listSupportedCrablineChannels(): QaCrablineChannelId[] {
  return Array.from(
    new Set(listLocalChannelDriverMatrix().drivers.map((driver) => driver.channel)),
  ) as QaCrablineChannelId[];
}

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
  const channel = normalized as QaCrablineChannelId;
  if (findLocalChannelDriver({ channel })) {
    return channel;
  }
  const supportedChannels = listSupportedCrablineChannels();
  throw new Error(
    `--channel must be one of ${supportedChannels.join(", ")} for --channel-driver crabline, got "${input}".`,
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
    capabilityMatrixPath: QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
    smokeArtifactPath: QA_CRABLINE_CHANNEL_SMOKE_PATH,
  };
}

export async function runQaCrablineChannelDriverSmoke(
  selection: QaCrablineChannelDriverSelection,
): Promise<LocalChannelDriverSmokeResult> {
  return await runLocalChannelDriverSmoke({
    channel: selection.channel,
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
    `Channel driver: ${selection.channelDriver} for ${selection.channel}.`,
    `Channel capability matrix: ${selection.capabilityMatrixPath}.`,
    `Channel driver smoke: ${selection.smokeArtifactPath}.`,
    "This is the openclaw/crabline messaging SDK driver path; it is independent of the Canonical Multipass VM runner.",
  ];
}

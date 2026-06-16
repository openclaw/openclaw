// Qa Lab plugin module models SDK-backed Crabline channel-driver metadata.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SUPPORTED_CRABLINE_CHANNELS = ["telegram"] as const;

type CrablineChannel = (typeof SUPPORTED_CRABLINE_CHANNELS)[number];

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
export const QA_CRABLINE_MANIFEST_PATH = "crabline-smoke.json";
export const QA_CRABLINE_DEFAULT_CHANNEL = "telegram";

function listSupportedCrablineChannels(): QaCrablineChannelId[] {
  return [...SUPPORTED_CRABLINE_CHANNELS];
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
  const normalized = input?.trim().toLowerCase() || QA_CRABLINE_DEFAULT_CHANNEL;
  if ((SUPPORTED_CRABLINE_CHANNELS as readonly string[]).includes(normalized)) {
    return normalized as QaCrablineChannelId;
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

type CrablineCommandResult = {
  command: string[];
  stderr: string;
  stdout: string;
};

export type QaCrablineChannelDriverSmokeResult = {
  capabilityReport: unknown;
  manifestPath: string;
  smoke: unknown;
};

function resolveCrablineBinPath() {
  const indexPath = fileURLToPath(import.meta.resolve("crabline"));
  return path.join(path.dirname(indexPath), "bin", "crabline.js");
}

function createCrablineManifest(selection: QaCrablineChannelDriverSelection, outputDir: string) {
  switch (selection.channel) {
    case "telegram":
      return {
        configVersion: 1,
        fixtures: [
          {
            id: "telegram-openclaw-doctor",
            mode: "probe",
            provider: "telegram",
            target: {
              id: "openclaw-qa-lab-crabline-doctor",
            },
          },
        ],
        providers: {
          telegram: {
            adapter: "telegram",
            env: ["TELEGRAM_BOT_TOKEN"],
            telegram: {
              mode: "polling",
              recorder: {
                path: path.join(outputDir, ".crabline", "recorders", "telegram.jsonl"),
              },
            },
          },
        },
        userName: "openclaw-qa",
      };
  }
}

async function runCrablineJsonCommand(params: {
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ json: unknown; result: CrablineCommandResult }> {
  const command = [resolveCrablineBinPath(), "--json", ...params.args];
  const displayCommand = ["node", "crabline", "--json", ...params.args];
  try {
    const result = await execFileAsync(process.execPath, command, {
      cwd: params.cwd,
      encoding: "utf8",
      env: params.env ?? process.env,
      maxBuffer: 1024 * 1024,
    });
    const stdout = result.stdout.toString();
    return {
      json: JSON.parse(stdout),
      result: {
        command: displayCommand,
        stderr: result.stderr.toString(),
        stdout,
      },
    };
  } catch (error) {
    const childError = error as Error & {
      code?: number | string;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const stdout = childError.stdout?.toString() ?? "";
    const stderr = childError.stderr?.toString() ?? "";
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      `Crabline command failed (${displayCommand.join(" ")}): ${details || childError.message}`,
      { cause: error },
    );
  }
}

export async function runQaCrablineChannelDriverSmoke(
  selection: QaCrablineChannelDriverSelection,
  params: {
    env?: NodeJS.ProcessEnv;
    outputDir: string;
  },
): Promise<QaCrablineChannelDriverSmokeResult> {
  const manifestPath = path.join(params.outputDir, QA_CRABLINE_MANIFEST_PATH);
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(createCrablineManifest(selection, params.outputDir), null, 2)}\n`,
    "utf8",
  );
  const providers = await runCrablineJsonCommand({
    args: ["--config", manifestPath, "providers"],
    cwd: params.outputDir,
    env: params.env,
  });
  const doctor = await runCrablineJsonCommand({
    args: ["--config", manifestPath, "doctor"],
    cwd: params.outputDir,
    env: params.env,
  });
  return {
    capabilityReport: {
      command: providers.result.command,
      manifestPath: path.basename(manifestPath),
      result: providers.json,
    },
    manifestPath: path.basename(manifestPath),
    smoke: {
      command: doctor.result.command,
      manifestPath: path.basename(manifestPath),
      result: doctor.json,
    },
  };
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
    "This is the openclaw/crabline Chat SDK messaging-provider path; it is independent of the Canonical Multipass VM runner.",
  ];
}

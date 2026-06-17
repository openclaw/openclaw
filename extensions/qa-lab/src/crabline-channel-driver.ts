// Qa Lab plugin module models SDK-backed Crabline channel-driver metadata.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const execFileAsync = promisify(execFile);

export type QaChannelDriverId = "crabline";
export type QaCrablineChannelId = string;

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

let supportedCrablineChannelsPromise: Promise<QaCrablineChannelId[]> | undefined;

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

export async function normalizeQaCrablineChannel(
  input?: string | null,
): Promise<QaCrablineChannelId> {
  const normalized = input?.trim().toLowerCase() || QA_CRABLINE_DEFAULT_CHANNEL;
  const supportedChannels = await listSupportedCrablineChannels();
  if (supportedChannels.includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `--channel must be one of ${supportedChannels.join(", ")} for --channel-driver crabline, got "${input}".`,
  );
}

export async function resolveQaCrablineChannelDriverSelection(params: {
  channel?: string | null;
  channelDriver?: string | null;
}): Promise<QaCrablineChannelDriverSelection | null> {
  const channelDriver = normalizeQaChannelDriverId(params.channelDriver);
  if (!channelDriver) {
    if (params.channel?.trim()) {
      throw new Error("--channel requires --channel-driver crabline.");
    }
    return null;
  }

  const channel = await normalizeQaCrablineChannel(params.channel);
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

function createCrablineCatalogManifest() {
  return {
    configVersion: 1,
    fixtures: [],
    providers: {},
    userName: "openclaw-qa",
  };
}

function createCrablineManifest(selection: QaCrablineChannelDriverSelection) {
  return {
    configVersion: 1,
    fixtures: [],
    providers: {
      [selection.channel]: {
        adapter: selection.channel,
      },
    },
    userName: "openclaw-qa",
  };
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
    const stdout = result.stdout;
    return {
      json: JSON.parse(stdout),
      result: {
        command: displayCommand,
        stderr: result.stderr,
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

function readCrablineSupportedChannels(payload: unknown): QaCrablineChannelId[] {
  const support = (payload as { support?: unknown }).support;
  if (!Array.isArray(support)) {
    throw new Error("Crabline providers output did not include a support catalog.");
  }
  const channels = support
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = entry as { platform?: unknown; status?: unknown };
      return candidate.status === "ready" &&
        typeof candidate.platform === "string" &&
        candidate.platform !== "loopback"
        ? [candidate.platform]
        : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
  return [...new Set(channels)];
}

async function readSupportedCrablineChannels(): Promise<QaCrablineChannelId[]> {
  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "qa-crabline-catalog-"),
  );
  try {
    const manifestPath = path.join(tempDir, "crabline-catalog.json");
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(createCrablineCatalogManifest(), null, 2)}\n`,
      "utf8",
    );
    const providers = await runCrablineJsonCommand({
      args: ["--config", manifestPath, "providers"],
      cwd: tempDir,
    });
    const supportedChannels = readCrablineSupportedChannels(providers.json);
    if (supportedChannels.length === 0) {
      throw new Error("Crabline did not report any ready channel providers.");
    }
    return supportedChannels;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function listSupportedCrablineChannels(): Promise<QaCrablineChannelId[]> {
  supportedCrablineChannelsPromise ??= readSupportedCrablineChannels();
  return await supportedCrablineChannelsPromise;
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
    `${JSON.stringify(createCrablineManifest(selection), null, 2)}\n`,
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

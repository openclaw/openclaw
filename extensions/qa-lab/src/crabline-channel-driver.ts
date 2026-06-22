// Qa Lab plugin module models Crabline channel-driver metadata.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CatalogEntry, ManifestDefinition, ProviderAdapter, Registry } from "crabline";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  createQaCrablineCatalogManifestInput,
  createQaCrablineManifestInput,
  parseQaCrablineManifest,
  type QaCrablineManifestSchema,
} from "./crabline-manifest.js";

const execFileAsync = promisify(execFile);

export type QaCrablineChannelId = string;

export type QaCrablineChannelDriverSelection = {
  channel: QaCrablineChannelId;
  channelDriver: "crabline";
  capabilityMatrixPath: typeof QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH;
  smokeArtifactPath: typeof QA_CRABLINE_CHANNEL_SMOKE_PATH;
};

export const QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH = "crabline-channel-capability-matrix.json";
export const QA_CRABLINE_CHANNEL_SMOKE_PATH = "crabline-channel-smoke.json";
export const QA_CRABLINE_MANIFEST_PATH = "crabline-smoke.json";
export const QA_CRABLINE_DEFAULT_CHANNEL = "telegram";

export async function normalizeQaCrablineChannel(
  input?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<QaCrablineChannelId> {
  const normalized = input?.trim().toLowerCase() || QA_CRABLINE_DEFAULT_CHANNEL;
  const supportedChannels = await readSupportedCrablineChannels(env ?? process.env);
  if (supportedChannels.includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `--channel must be one of ${supportedChannels.join(", ")} for --channel-driver crabline, got "${input}".`,
  );
}

export async function resolveQaCrablineChannelDriverSelection(params: {
  channel?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<QaCrablineChannelDriverSelection> {
  const channel = await normalizeQaCrablineChannel(params.channel, params.env);
  return {
    channel,
    channelDriver: "crabline",
    capabilityMatrixPath: QA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
    smokeArtifactPath: QA_CRABLINE_CHANNEL_SMOKE_PATH,
  };
}

type CrablineCommandResult = {
  command: string[];
  stderr: string;
  stdout: string;
};

type CrablineCommandError = Error & {
  code?: string;
};

type CrablineRuntimeModule = {
  ManifestSchema: QaCrablineManifestSchema;
  createRegistry: (manifest: ManifestDefinition, manifestPath: string) => Registry;
};

export type QaCrablineChannelDriverSmokeResult = {
  capabilityReport: unknown;
  manifestPath: string;
  smoke: unknown;
};

function resolveCrablineCommand(env: NodeJS.ProcessEnv) {
  const explicitCli = env.OPENCLAW_QA_CRABLINE_BIN?.trim();
  if (explicitCli) {
    return {
      file: process.execPath,
      argsPrefix: [explicitCli],
      displayPrefix: ["node", explicitCli],
    };
  }
  return {
    file: "crabline",
    argsPrefix: [] as string[],
    displayPrefix: ["crabline"],
  };
}

async function loadCrablineRuntime(env: NodeJS.ProcessEnv): Promise<CrablineRuntimeModule> {
  const explicitRuntime = env.OPENCLAW_QA_CRABLINE_RUNTIME?.trim();
  if (explicitRuntime) {
    return (await import(
      pathToFileURL(path.resolve(explicitRuntime)).href
    )) as unknown as CrablineRuntimeModule;
  }
  return (await import("crabline")) as unknown as CrablineRuntimeModule;
}

async function runCrablineJsonCommand(params: {
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ json: unknown; result: CrablineCommandResult }> {
  const env = params.env ?? process.env;
  const crabline = resolveCrablineCommand(env);
  const command = [...crabline.argsPrefix, "--json", ...params.args];
  const displayCommand = [...crabline.displayPrefix, "--json", ...params.args];
  try {
    const result = await execFileAsync(crabline.file, command, {
      cwd: params.cwd,
      encoding: "utf8",
      env,
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
    const hint =
      childError.code === "ENOENT"
        ? " Install crabline on PATH or set OPENCLAW_QA_CRABLINE_BIN to a Crabline CLI JavaScript file."
        : "";
    const wrappedError = new Error(
      `Crabline command failed (${displayCommand.join(" ")}): ${details || childError.message}.${hint}`,
      { cause: error },
    ) as CrablineCommandError;
    wrappedError.code = typeof childError.code === "string" ? childError.code : undefined;
    throw wrappedError;
  }
}

function parseCrablineProviderCatalogChannels(payload: unknown): QaCrablineChannelId[] {
  const support = (payload as { support?: unknown }).support;
  if (!Array.isArray(support)) {
    throw new Error("Crabline providers output did not include a support catalog.");
  }
  const channels = support
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = entry as Partial<CatalogEntry>;
      return candidate.status === "ready" &&
        typeof candidate.platform === "string" &&
        candidate.platform !== "loopback"
        ? [candidate.platform]
        : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
  return [...new Set(channels)];
}

async function readSupportedCrablineChannels(
  env: NodeJS.ProcessEnv,
): Promise<QaCrablineChannelId[]> {
  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "qa-crabline-catalog-"),
  );
  try {
    const manifestPath = path.join(tempDir, "crabline-catalog.json");
    const manifestInput = createQaCrablineCatalogManifestInput();
    await fs.writeFile(manifestPath, `${JSON.stringify(manifestInput, null, 2)}\n`, "utf8");
    const providers = env.OPENCLAW_QA_CRABLINE_BIN?.trim()
      ? (
          await runCrablineJsonCommand({
            args: ["--config", manifestPath, "providers"],
            cwd: tempDir,
            env,
          })
        ).json
      : await (async () => {
          const runtime = await loadCrablineRuntime(env);
          const manifest = parseQaCrablineManifest(runtime.ManifestSchema, manifestInput);
          return {
            support: runtime.createRegistry(manifest, manifestPath).catalog,
          };
        })();
    const supportedChannels = parseCrablineProviderCatalogChannels(providers);
    if (supportedChannels.length === 0) {
      throw new Error("Crabline did not report any ready channel providers.");
    }
    return supportedChannels;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runQaCrablineChannelDriverSmoke(
  selection: QaCrablineChannelDriverSelection,
  params: {
    env?: NodeJS.ProcessEnv;
    outputDir: string;
  },
): Promise<QaCrablineChannelDriverSmokeResult> {
  const env = params.env ?? process.env;
  const manifestPath = path.join(params.outputDir, QA_CRABLINE_MANIFEST_PATH);
  const { fixtureId, manifest: manifestInput } = createQaCrablineManifestInput(selection.channel);
  if (!env.OPENCLAW_QA_CRABLINE_BIN?.trim()) {
    const runtime = await loadCrablineRuntime(env);
    const manifest = parseQaCrablineManifest(runtime.ManifestSchema, manifestInput);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const registry = runtime.createRegistry(manifest, manifestPath);
    const provider: ProviderAdapter = registry.resolve(selection.channel, fixtureId);
    const fixture = manifest.fixtures[0];
    const config = manifest.providers[selection.channel];
    try {
      const probe = await provider.probe({
        config,
        fixture,
        manifestPath,
        providerId: selection.channel,
        userName: manifest.userName,
      });
      return {
        capabilityReport: {
          command: ["node", "-e", "import('crabline')"],
          manifestPath: path.basename(manifestPath),
          result: {
            configured: [{ adapter: selection.channel, platform: selection.channel }],
            support: registry.catalog.filter((entry) => entry.platform === selection.channel),
          },
        },
        manifestPath: path.basename(manifestPath),
        smoke: {
          command: ["node", "-e", "import('crabline').then(m=>m.createRegistry(...))"],
          manifestPath: path.basename(manifestPath),
          result: {
            findings: [],
            ok: true,
            probe,
          },
        },
      };
    } finally {
      await provider.cleanup?.();
    }
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifestInput, null, 2)}\n`, "utf8");
  const providers = await runCrablineJsonCommand({
    args: ["--config", manifestPath, "providers"],
    cwd: params.outputDir,
    env,
  });
  const doctor = await runCrablineJsonCommand({
    args: ["--config", manifestPath, "doctor"],
    cwd: params.outputDir,
    env,
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
    "This is the openclaw/crabline channel-provider path; it is independent of the Canonical Multipass VM runner.",
  ];
}

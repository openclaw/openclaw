import { realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import type { ResolvedSignalTransport } from "./accounts.js";
import { spawnSignalDaemon } from "./daemon.js";
import { assertSignalSetupDaemonBindAvailable } from "./setup-daemon-bind.js";
import {
  probeSignalTransport,
  resolveConfiguredSignalTransport,
  type SignalTransportProbeResult,
} from "./setup-transport.js";
import { buildSignalTransportHttpUrl } from "./transport-url.js";

export type ManagedSignalTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;
export type ResolvedManagedSignalTransport = Extract<
  ResolvedSignalTransport,
  { kind: "managed-native" }
>;
export type LiveManagedTransportState =
  | "not-running"
  | "reuse-active-transport"
  | "validate-different-store";

function resolveSignalCliConfigPath(raw: string): string {
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(homedir(), raw.slice(2));
  }
  return raw;
}

function resolveExplicitSignalCliDataDirectory(configPath: string | undefined): string | undefined {
  const configured = normalizeOptionalString(configPath);
  if (!configured) {
    return undefined;
  }
  const absolute = path.resolve(resolveSignalCliConfigPath(configured));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

type SignalCliDataDirectoryRelationship = "same" | "different" | "unknown";

function compareSignalCliDataDirectories(
  active: ResolvedManagedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): SignalCliDataDirectoryRelationship {
  const activeDirectory = resolveExplicitSignalCliDataDirectory(active.configPath);
  const candidateDirectory = resolveExplicitSignalCliDataDirectory(candidate.configPath);
  if (!activeDirectory || !candidateDirectory) {
    return !activeDirectory && !candidateDirectory ? "same" : "unknown";
  }
  const same =
    process.platform === "win32"
      ? activeDirectory.toLowerCase() === candidateDirectory.toLowerCase()
      : activeDirectory === candidateDirectory;
  return same ? "same" : "different";
}

function isSameResolvedManagedTransport(
  existing: ResolvedSignalTransport,
  candidate: ResolvedManagedSignalTransport,
): boolean {
  return (
    existing.kind === "managed-native" &&
    existing.httpHost === candidate.httpHost &&
    existing.httpPort === candidate.httpPort &&
    existing.baseUrl === candidate.baseUrl &&
    existing.cliPath === candidate.cliPath &&
    compareSignalCliDataDirectories(existing, candidate) === "same" &&
    existing.startupTimeoutMs === candidate.startupTimeoutMs &&
    existing.receiveMode === candidate.receiveMode &&
    existing.ignoreStories === candidate.ignoreStories
  );
}

export async function evaluateLiveManagedTransport(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: string | undefined;
  activeTransport: ResolvedSignalTransport;
  candidateTransport: ResolvedManagedSignalTransport;
}): Promise<LiveManagedTransportState> {
  const configuredTransport = resolveConfiguredSignalTransport(params.cfg, params.accountId);
  if (
    params.activeTransport.kind !== "managed-native" ||
    (!params.account && configuredTransport?.kind !== "managed-native")
  ) {
    return "not-running";
  }
  const existingTransport = configuredTransport ?? { kind: "managed-native" };
  const existingProbe = await probeSignalTransport({
    cfg: params.cfg,
    accountId: params.accountId,
    transport: existingTransport,
    ...(params.account ? { account: params.account } : {}),
    timeoutMs: 1_000,
  }).catch((error: unknown) => ({ ok: false, error: String(error) }));
  if (!existingProbe.ok) {
    return "not-running";
  }
  if (isSameResolvedManagedTransport(params.activeTransport, params.candidateTransport)) {
    if (!params.account) {
      throw new Error(
        "The running Signal daemon is using this signal-cli config directory. Stop the OpenClaw gateway before discovering or linking an account, then retry setup.",
      );
    }
    return "reuse-active-transport";
  }
  if (
    compareSignalCliDataDirectories(params.activeTransport, params.candidateTransport) !==
    "different"
  ) {
    throw new Error(
      "The running Signal daemon may be using this signal-cli config directory. Stop the OpenClaw gateway before changing its signal-cli settings, then retry setup.",
    );
  }
  return "validate-different-store";
}

export async function probeManagedSignalSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  transport: ManagedSignalTransport;
  resolvedTransport: ResolvedManagedSignalTransport;
  account: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  useTemporaryPort: boolean;
}): Promise<SignalTransportProbeResult> {
  const progress = params.prompter.progress("Validating Signal setup...");
  const configuredBindUrl = buildSignalTransportHttpUrl(
    params.resolvedTransport.httpHost,
    params.resolvedTransport.httpPort,
  );
  const hasSeparateConnectionUrl = params.resolvedTransport.baseUrl !== configuredBindUrl;
  let validationTransport = params.transport;
  let validationResolvedTransport = params.resolvedTransport;
  let daemon: ReturnType<typeof spawnSignalDaemon> | undefined;
  let successfulProbe: SignalTransportProbeResult | undefined;
  let result: SignalTransportProbeResult;
  try {
    if (params.useTemporaryPort) {
      const httpPort = await allocateSignalValidationPort(validationResolvedTransport.httpHost);
      const baseUrl = buildSignalTransportHttpUrl(validationResolvedTransport.httpHost, httpPort);
      validationTransport = { ...validationTransport, httpPort, url: baseUrl };
      validationResolvedTransport = {
        ...validationResolvedTransport,
        httpPort,
        baseUrl,
      };
    } else {
      await assertSignalSetupDaemonBindAvailable({
        httpHost: validationResolvedTransport.httpHost,
        httpPort: validationResolvedTransport.httpPort,
      });
    }
    const bindUrl = buildSignalTransportHttpUrl(
      validationResolvedTransport.httpHost,
      validationResolvedTransport.httpPort,
    );
    const bindTransport: ManagedSignalTransport = {
      ...validationTransport,
      httpHost: validationResolvedTransport.httpHost,
      httpPort: validationResolvedTransport.httpPort,
      url: bindUrl,
    };
    const spawnedDaemon = spawnSignalDaemon({
      cliPath: validationResolvedTransport.cliPath,
      ...(validationResolvedTransport.configPath
        ? { configPath: validationResolvedTransport.configPath }
        : {}),
      account: params.account,
      httpHost: validationResolvedTransport.httpHost,
      httpPort: validationResolvedTransport.httpPort,
      // Setup validation must not drain queued messages before the real monitor owns delivery.
      receiveMode: "manual",
      ...(typeof validationResolvedTransport.ignoreStories === "boolean"
        ? { ignoreStories: validationResolvedTransport.ignoreStories }
        : {}),
    });
    daemon = spawnedDaemon;
    const startupTimeoutMs = Math.min(
      120_000,
      Math.max(1_000, validationResolvedTransport.startupTimeoutMs),
    );
    await waitForTransportReady({
      label: "signal-cli setup daemon",
      timeoutMs: startupTimeoutMs,
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      runtime: params.runtime,
      check: async () => {
        if (spawnedDaemon.isExited()) {
          throw new Error("signal-cli exited before its HTTP server became ready.");
        }
        const probe = await probeSignalTransport({
          cfg: params.cfg,
          accountId: params.accountId,
          transport: bindTransport,
          account: params.account,
          timeoutMs: 1_000,
        }).catch((error: unknown) => ({ ok: false, error: String(error) }));
        if (probe.ok) {
          successfulProbe = probe;
        }
        return probe;
      },
    });
    result = successfulProbe ?? { ok: false, error: "Signal transport probe failed." };
    if (result.ok && hasSeparateConnectionUrl) {
      result = await probeSignalTransport({
        cfg: params.cfg,
        accountId: params.accountId,
        transport: params.transport,
        account: params.account,
        timeoutMs: 1_000,
      }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    }
  } catch (error) {
    result = { ok: false, error: String(error) };
  } finally {
    await daemon?.stop();
  }
  progress.stop(result.ok ? "Signal setup validated." : "Signal setup validation failed.");
  return result;
}

async function allocateSignalValidationPort(host: string): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not allocate a temporary Signal validation port.");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

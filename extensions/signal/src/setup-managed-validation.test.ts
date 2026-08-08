import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSignalTransport } from "./accounts.js";
import type { SignalDaemonHandle } from "./daemon.js";
import type { SignalTransportProbeResult } from "./setup-transport.js";

type SpawnSignalDaemonParams = Parameters<typeof import("./daemon.js").spawnSignalDaemon>[0];

const mocks = vi.hoisted(() => ({
  assertSignalSetupDaemonBindAvailable: vi.fn(async () => undefined),
  probeSignalTransport: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
  ),
  spawnSignalDaemon: vi.fn(
    (_params: SpawnSignalDaemonParams): SignalDaemonHandle => ({
      pid: 1234,
      stop: vi.fn(async () => undefined),
      exited: new Promise<never>(() => {}),
      isExited: () => false,
    }),
  ),
}));

vi.mock("./daemon.js", () => ({
  spawnSignalDaemon: mocks.spawnSignalDaemon,
}));

vi.mock("./setup-daemon-bind.js", () => ({
  assertSignalSetupDaemonBindAvailable: mocks.assertSignalSetupDaemonBindAvailable,
}));

vi.mock("./setup-transport.js", async () => {
  const actual =
    await vi.importActual<typeof import("./setup-transport.js")>("./setup-transport.js");
  return { ...actual, probeSignalTransport: mocks.probeSignalTransport };
});

import {
  evaluateLiveManagedTransport,
  probeManagedSignalSetup,
  type ResolvedManagedSignalTransport,
} from "./setup-managed-validation.js";

function resolvedManagedTransport(
  overrides: {
    cliPath?: string;
    configPath?: string;
    httpPort?: number;
    url?: string;
  } = {},
): ResolvedManagedSignalTransport {
  const resolved = resolveSignalTransport({
    kind: "managed-native",
    cliPath: overrides.cliPath ?? "/opt/openclaw/signal-cli",
    configPath: overrides.configPath ?? "/var/lib/signal-cli",
    httpHost: "127.0.0.1",
    httpPort: overrides.httpPort ?? 8080,
    ...(overrides.url ? { url: overrides.url } : {}),
  });
  if (resolved.kind !== "managed-native") {
    throw new Error("expected managed Signal transport");
  }
  return resolved;
}

function configuredManagedSignalConfig(configPath = "/var/lib/signal-cli"): OpenClawConfig {
  return {
    channels: {
      signal: {
        accounts: {
          work: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              cliPath: "/opt/openclaw/signal-cli",
              configPath,
              httpHost: "127.0.0.1",
              httpPort: 8080,
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("managed Signal validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeSignalTransport.mockResolvedValue({ ok: true, status: 200 });
  });

  it("reuses an unchanged running transport instead of starting a competing daemon", async () => {
    const transport = resolvedManagedTransport();

    await expect(
      evaluateLiveManagedTransport({
        cfg: configuredManagedSignalConfig(),
        accountId: "work",
        account: "+15555550123",
        activeTransport: transport,
        candidateTransport: transport,
      }),
    ).resolves.toBe("reuse-active-transport");

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
  });

  it("uses a temporary port when a live account changes to a different explicit data store", async () => {
    const activeTransport = resolvedManagedTransport({ configPath: "/var/lib/signal-cli-active" });
    const candidateTransport = resolvedManagedTransport({
      configPath: "/var/lib/signal-cli-candidate",
    });
    await expect(
      evaluateLiveManagedTransport({
        cfg: configuredManagedSignalConfig("/var/lib/signal-cli-active"),
        accountId: "work",
        account: "+15555550123",
        activeTransport,
        candidateTransport,
      }),
    ).resolves.toBe("validate-different-store");

    const queued = createQueuedWizardPrompter();
    const result = await probeManagedSignalSetup({
      cfg: configuredManagedSignalConfig("/var/lib/signal-cli-active"),
      accountId: "work",
      transport: {
        kind: "managed-native",
        cliPath: candidateTransport.cliPath,
        configPath: candidateTransport.configPath,
        httpHost: candidateTransport.httpHost,
        httpPort: candidateTransport.httpPort,
      },
      resolvedTransport: candidateTransport,
      account: "+15555550123",
      runtime: createRuntimeEnv({ throwOnExit: false }),
      prompter: queued.prompter,
      useTemporaryPort: true,
    });

    expect(result.ok).toBe(true);
    expect(mocks.assertSignalSetupDaemonBindAvailable).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon.mock.calls[0]?.[0]).toMatchObject({
      receiveMode: "manual",
    });
    expect(mocks.spawnSignalDaemon.mock.calls[0]?.[0].httpPort).not.toBe(8080);
  });

  it("checks a separate connection URL after temporary-port validation", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, error: "proxy unavailable" });
    const resolvedTransport = resolvedManagedTransport({ url: "https://signal.example.test" });

    const result = await probeManagedSignalSetup({
      cfg: {},
      accountId: "work",
      transport: {
        kind: "managed-native",
        cliPath: resolvedTransport.cliPath,
        configPath: resolvedTransport.configPath,
        httpHost: resolvedTransport.httpHost,
        httpPort: resolvedTransport.httpPort,
        url: "https://signal.example.test",
      },
      resolvedTransport,
      account: "+15555550123",
      runtime: createRuntimeEnv({ throwOnExit: false }),
      prompter: createQueuedWizardPrompter().prompter,
      useTemporaryPort: true,
    });

    expect(result).toMatchObject({ ok: false, error: "proxy unavailable" });
    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.probeSignalTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({ url: "https://signal.example.test" }),
      }),
    );
    expect(mocks.spawnSignalDaemon.mock.calls[0]?.[0].httpPort).not.toBe(8080);
  });
});

import os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalTransportConfig } from "./account-types.js";
import { resolveSignalAccount } from "./accounts.js";
import type { SignalDaemonHandle } from "./daemon.js";
import {
  configuredManagedSignalConfig,
  managedSignalCredentialValues,
} from "./setup-surface.test-fixtures.js";
import type { SignalTransportProbeResult } from "./setup-transport.js";

type SpawnSignalDaemonParams = Parameters<typeof import("./daemon.js").spawnSignalDaemon>[0];

const mocks = vi.hoisted(() => ({
  runPluginCommandWithTimeout: vi.fn(async () => ({
    code: 0,
    stdout: '[{"number":"+15555550123"}]',
    stderr: "",
  })),
  spawnSignalDaemon: vi.fn(
    (_params: SpawnSignalDaemonParams): SignalDaemonHandle => ({
      pid: 1234,
      stop: vi.fn(async () => undefined),
      exited: new Promise<never>(() => {}),
      isExited: () => false,
    }),
  ),
  assertSignalDaemonBindAvailable: vi.fn(async () => undefined),
  prepareSignalManagedNativeTransport: vi.fn(
    (): Extract<SignalTransportConfig, { kind: "managed-native" }> => ({
      kind: "managed-native",
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    }),
  ),
  probeSignalTransport: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
  ),
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: mocks.runPluginCommandWithTimeout,
}));

vi.mock("./daemon.js", () => ({
  assertSignalDaemonBindAvailable: mocks.assertSignalDaemonBindAvailable,
  spawnSignalDaemon: mocks.spawnSignalDaemon,
}));

vi.mock("./setup-transport.js", async () => {
  const actual =
    await vi.importActual<typeof import("./setup-transport.js")>("./setup-transport.js");
  return {
    ...actual,
    prepareSignalManagedNativeTransport: mocks.prepareSignalManagedNativeTransport,
    probeSignalTransport: mocks.probeSignalTransport,
  };
});

import { signalSetupWizard } from "./setup-surface.js";

describe("managed Signal validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeSignalTransport.mockReset().mockResolvedValue({ ok: true, status: 200 });
    mocks.assertSignalDaemonBindAvailable.mockReset().mockResolvedValue(undefined);
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550123"}]',
      stderr: "",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes an unchanged running managed daemon without starting a competing process", async () => {
    const queued = createQueuedWizardPrompter();

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: configuredManagedSignalConfig(),
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(queued.progress).not.toHaveBeenCalled();
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.accountUuid,
    ).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("does not enumerate accounts locked by an unchanged running daemon", async () => {
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550124"}]',
      stderr: "",
    });
    const queued = createQueuedWizardPrompter();

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: configuredManagedSignalConfig(),
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550123");
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.accountUuid,
    ).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("stops before account discovery when an accountless managed daemon is running", async () => {
    const queued = createQueuedWizardPrompter();

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {
          channels: {
            signal: {
              accounts: {
                work: {
                  transport: {
                    kind: "managed-native",
                    cliPath: "/opt/openclaw/signal-cli",
                    configPath: "/var/lib/signal-cli",
                    httpHost: "127.0.0.1",
                    httpPort: 8080,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toThrow(
      "The running Signal daemon is using this signal-cli config directory. Stop the OpenClaw gateway before discovering or linking an account, then retry setup.",
    );

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
  });

  it("reuses an unchanged active transport when both data directories are implicit", async () => {
    mocks.prepareSignalManagedNativeTransport.mockReturnValueOnce({
      kind: "managed-native",
      cliPath: "/opt/openclaw/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    const cfg = configuredManagedSignalConfig();
    const work = cfg.channels?.signal?.accounts?.work;
    if (work?.transport?.kind !== "managed-native") {
      throw new Error("expected managed Signal fixture");
    }
    delete work.transport.configPath;

    await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg,
      accountId: "work",
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
      },
      prompter: createQueuedWizardPrompter().prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
  });

  it("compares signal-cli data directories against the OS home, not OPENCLAW_HOME", async () => {
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = "/srv/openclaw-home";
    vi.spyOn(os, "homedir").mockReturnValue("/Users/signal-owner");
    mocks.prepareSignalManagedNativeTransport.mockReturnValueOnce({
      kind: "managed-native",
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/srv/openclaw-home/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    try {
      await runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {
          channels: {
            signal: {
              accounts: {
                work: {
                  account: "+15555550123",
                  transport: {
                    kind: "managed-native",
                    cliPath: "/opt/openclaw/signal-cli",
                    configPath: "~/signal-cli",
                    httpHost: "127.0.0.1",
                    httpPort: 8080,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: createQueuedWizardPrompter().prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      });
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
    }

    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.runPluginCommandWithTimeout).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon.mock.calls[0]?.[0].httpPort).not.toBe(8080);
  });

  it("fails closed when an active implicit data directory is compared with an explicit path", async () => {
    const queued = createQueuedWizardPrompter();
    const cfg = configuredManagedSignalConfig();
    const work = cfg.channels?.signal?.accounts?.work;
    if (work?.transport?.kind !== "managed-native") {
      throw new Error("expected managed Signal fixture");
    }
    delete work.transport.configPath;

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toThrow("The running Signal daemon may be using this signal-cli config directory");

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
  });

  it("preserves account UUID while revalidating the same offline managed account", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "not running" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const queued = createQueuedWizardPrompter();

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: configuredManagedSignalConfig(),
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.runPluginCommandWithTimeout).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon).toHaveBeenCalledOnce();
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.accountUuid,
    ).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("explains that a live daemon must stop before changing its signal-cli settings", async () => {
    const queued = createQueuedWizardPrompter();

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {
          channels: {
            signal: {
              accounts: {
                work: {
                  account: "+15555550123",
                  transport: {
                    kind: "managed-native",
                    cliPath: "signal-cli",
                    configPath: "/var/lib/signal-cli",
                    httpHost: "127.0.0.1",
                    httpPort: 8080,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toThrow(
      "The running Signal daemon may be using this signal-cli config directory. Stop the OpenClaw gateway before changing its signal-cli settings, then retry setup.",
    );

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
  });

  it("requires the live daemon to stop before switching from an explicit to implicit store", async () => {
    const queued = createQueuedWizardPrompter();

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: configuredManagedSignalConfig(),
        accountId: "work",
        credentialValues: {
          ...managedSignalCredentialValues,
          signalCliConfigPath: "",
        },
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toThrow("The running Signal daemon may be using this signal-cli config directory");

    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.runPluginCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
  });
});

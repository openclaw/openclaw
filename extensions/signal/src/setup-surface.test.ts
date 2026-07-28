import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalTransportConfig } from "./account-types.js";
import { resolveSignalAccount } from "./accounts.js";
import type { SignalDaemonHandle } from "./daemon.js";
import type { SignalInstallResult } from "./install-signal-cli.js";
import {
  configuredManagedSignalConfig,
  managedSignalCredentialValues,
  toCredentialValues,
} from "./setup-surface.test-fixtures.js";
import type { SignalTransportProbeResult } from "./setup-transport.js";
import type { SignalCliLinkResult } from "./signal-cli-link.js";

type SpawnSignalDaemonParams = Parameters<typeof import("./daemon.js").spawnSignalDaemon>[0];
type ProbeSignalTransportParams = Parameters<
  typeof import("./setup-transport.js").probeSignalTransport
>[0];

const mocks = vi.hoisted(() => ({
  detectBinary: vi.fn(async (_cliPath: string) => false),
  detectSignalTransport: vi.fn(
    async (params: {
      url: string;
    }): Promise<{ kind: "external-native" | "container"; url: string }> => ({
      kind: "external-native",
      url: params.url,
    }),
  ),
  installSignalCli: vi.fn(
    async (): Promise<SignalInstallResult> => ({
      ok: true,
      cliPath: "/opt/openclaw/signal-cli",
    }),
  ),
  linkSignalCliAccount: vi.fn(
    async (params: {
      cliPath: string;
      configPath?: string;
      onLinkUri: (uri: string, completion: Promise<{ ok: boolean }>) => Promise<void>;
    }): Promise<SignalCliLinkResult> => {
      await params.onLinkUri(
        "sgnl://linkdevice?uuid=test&pub_key=test",
        Promise.resolve({ ok: true }),
      );
      return { ok: true as const, associatedAccount: "+15555550123" };
    },
  ),
  renderQrTerminal: vi.fn(async () => "\x1b[47m\x1b[30m █▀▄ \x1b[0m"),
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
    async (_params: ProbeSignalTransportParams): Promise<SignalTransportProbeResult> => ({
      ok: true,
      status: 200,
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/setup-tools")>(
    "openclaw/plugin-sdk/setup-tools",
  );
  return { ...actual, detectBinary: mocks.detectBinary };
});

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: mocks.runPluginCommandWithTimeout,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  renderQrTerminal: mocks.renderQrTerminal,
}));

vi.mock("./daemon.js", () => ({
  assertSignalDaemonBindAvailable: mocks.assertSignalDaemonBindAvailable,
  spawnSignalDaemon: mocks.spawnSignalDaemon,
}));

vi.mock("./install-signal-cli.js", () => ({
  installSignalCli: mocks.installSignalCli,
}));

vi.mock("./signal-cli-link.js", () => ({
  linkSignalCliAccount: mocks.linkSignalCliAccount,
}));

vi.mock("./setup-transport.js", async () => {
  const actual =
    await vi.importActual<typeof import("./setup-transport.js")>("./setup-transport.js");
  return {
    ...actual,
    detectSignalTransport: mocks.detectSignalTransport,
    prepareSignalManagedNativeTransport: mocks.prepareSignalManagedNativeTransport,
    probeSignalTransport: mocks.probeSignalTransport,
  };
});

import { signalCompletionNote } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

describe("signalSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectSignalTransport.mockImplementation(async ({ url }: { url: string }) => ({
      kind: "external-native",
      url,
    }));
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

  it("keeps account entry reversible until immediately before signal-cli installation", async () => {
    mocks.detectBinary.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "not running" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const beforePersistentEffect = vi.fn(async () => undefined);
    const queued = createQueuedWizardPrompter({
      selectValues: ["local", "custom"],
      confirmValues: [true],
      textValues: ["/var/lib/signal-cli"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {},
      accountId: "work",
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
      options: { allowSignalInstall: true, beforePersistentEffect },
    });

    expect(beforePersistentEffect).not.toHaveBeenCalled();
    expect(mocks.installSignalCli).not.toHaveBeenCalled();
    expect(prepared?.credentialValues).toEqual({
      signalTransportKind: "managed-native",
      signalCliPath: "signal-cli",
      signalCliConfigPath: "/var/lib/signal-cli",
      signalInstallRequested: "true",
    });
    expect(queued.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "local",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "local", label: "Use local signal-cli" }),
          expect.objectContaining({
            value: "existing-server",
            label: "Connect to an existing Signal server",
          }),
        ]),
      }),
    );

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                account: "+15555550123",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: toCredentialValues(prepared?.credentialValues),
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
      options: { allowSignalInstall: true, beforePersistentEffect },
    });

    expect(beforePersistentEffect).toHaveBeenCalledOnce();
    expect(mocks.installSignalCli).toHaveBeenCalledOnce();
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installSignalCli.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).toEqual(
      expect.objectContaining({ kind: "managed-native" }),
    );
  });

  it("defaults a configured existing server account to existing server setup", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://signal-helper:8080"],
    });

    await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                transport: {
                  kind: "external-native",
                  url: "http://signal-helper:8080",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "existing-server" }),
    );
    expect(queued.text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "http://signal-helper:8080" }),
    );
  });

  it("probes and writes a prepared managed transport for the selected account", async () => {
    const queued = createQueuedWizardPrompter({ textValues: ["+15555550123"] });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.prepareSignalManagedNativeTransport).toHaveBeenCalledWith({
      cfg: {},
      accountId: "work",
      overrides: {
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli",
      },
    });
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        transport: expect.objectContaining({ kind: "managed-native" }),
        account: "+15555550123",
      }),
    );
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).toEqual(
      expect.objectContaining({ kind: "managed-native" }),
    );
  });

  it("links an unconfigured local account inside the wizard before probing it", async () => {
    mocks.runPluginCommandWithTimeout
      .mockResolvedValueOnce({
        code: 0,
        stdout: "[]",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '[{"number":"+15555550123"}]',
        stderr: "",
      });
    const beforePersistentEffect = vi.fn(async () => undefined);
    const queued = createQueuedWizardPrompter({ selectValues: ["link"] });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
      options: { beforePersistentEffect },
    });

    expect(queued.select).toHaveBeenCalledWith({
      message: "No linked Signal account was found. How should setup continue?",
      options: [
        { value: "link", label: "Link a Signal account now" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "link",
    });
    expect(beforePersistentEffect).toHaveBeenCalledOnce();
    expect(mocks.linkSignalCliAccount).toHaveBeenCalledWith({
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      onLinkUri: expect.any(Function),
    });
    expect(mocks.renderQrTerminal).toHaveBeenCalledWith(
      "sgnl://linkdevice?uuid=test&pub_key=test",
      { small: true },
    );
    expect(queued.plain).toHaveBeenCalledWith(
      expect.stringContaining("Signal > Settings > Linked devices"),
    );
    expect(queued.plain).toHaveBeenCalledWith(expect.stringContaining("Scan this QR code:"));
    expect(queued.text).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({ account: "+15555550123" }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550123");
  });

  it("falls back to a note when the prompter cannot render plain QR output", async () => {
    mocks.runPluginCommandWithTimeout
      .mockResolvedValueOnce({
        code: 0,
        stdout: "[]",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '[{"number":"+15555550123"}]',
        stderr: "",
      });
    const queued = createQueuedWizardPrompter({ selectValues: ["link"] });
    const { plain: _plain, ...prompterWithoutPlain } = queued.prompter;

    await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: prompterWithoutPlain,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("Scan this QR code:"),
      "Signal account linking",
    );
  });

  it("explains and retries a failed in-TUI signal-cli link", async () => {
    mocks.runPluginCommandWithTimeout
      .mockResolvedValueOnce({
        code: 0,
        stdout: "[]",
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '[{"number":"+15555550123"}]',
        stderr: "",
      });
    mocks.linkSignalCliAccount.mockResolvedValueOnce({
      ok: false,
      error: "Link request timed out, please try again.",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["link", "retry"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.note).toHaveBeenCalledWith(
      "signal-cli could not link this device.\n\nLink request timed out, please try again.",
      "Signal account linking",
    );
    expect(queued.select).toHaveBeenLastCalledWith({
      message: "How should Signal account linking continue?",
      options: [
        { value: "retry", label: "Retry account linking" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "retry",
    });
    expect(mocks.linkSignalCliAccount).toHaveBeenCalledTimes(2);
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550123");
  });

  it("adopts the only existing local signal-cli account without asking for its number", async () => {
    const queued = createQueuedWizardPrompter();

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).not.toHaveBeenCalled();
    expect(queued.select).not.toHaveBeenCalled();
    expect(mocks.linkSignalCliAccount).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({ account: "+15555550123" }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550123");
  });

  it("lets the user correct local signal-cli settings after account discovery fails", async () => {
    mocks.runPluginCommandWithTimeout
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "signal-cli not found",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '[{"number":"+15555550123"}]',
        stderr: "",
      });
    mocks.prepareSignalManagedNativeTransport
      .mockReturnValueOnce({
        kind: "managed-native",
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      })
      .mockReturnValueOnce({
        kind: "managed-native",
        cliPath: "/usr/local/bin/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      });
    const queued = createQueuedWizardPrompter({
      selectValues: ["settings", "default"],
      textValues: ["/usr/local/bin/signal-cli"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli could not list its linked accounts"),
      "Signal account discovery",
    );
    expect(queued.select).toHaveBeenCalledWith({
      message: "How should local signal-cli setup continue?",
      options: [
        { value: "retry", label: "Retry account discovery" },
        { value: "settings", label: "Change signal-cli settings" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "settings",
    });
    expect(mocks.runPluginCommandWithTimeout).toHaveBeenLastCalledWith({
      argv: ["/usr/local/bin/signal-cli", "--output", "json", "listAccounts"],
      timeoutMs: 10_000,
    });
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).toEqual(
      expect.objectContaining({
        kind: "managed-native",
        cliPath: "/usr/local/bin/signal-cli",
      }),
    );
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).not.toHaveProperty(
      "configPath",
    );
  });

  it("rechecks the live signal-cli store after account-discovery settings recovery", async () => {
    mocks.runPluginCommandWithTimeout.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "signal-cli data store unavailable",
    });
    mocks.prepareSignalManagedNativeTransport
      .mockReturnValueOnce({
        kind: "managed-native",
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli-candidate",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      })
      .mockReturnValueOnce({
        kind: "managed-native",
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli-active",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      });
    const queued = createQueuedWizardPrompter({
      selectValues: ["settings", "custom"],
      textValues: ["/opt/openclaw/signal-cli", "/var/lib/signal-cli-active"],
    });

    const finalized = await runSetupWizardFinalize({
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
                  configPath: "/var/lib/signal-cli-active",
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
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.runPluginCommandWithTimeout).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).toEqual(
      expect.objectContaining({
        kind: "managed-native",
        configPath: "/var/lib/signal-cli-active",
      }),
    );
  });

  it("lets the user choose among multiple existing local signal-cli accounts", async () => {
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550124"},{"number":"+15555550123"}]',
      stderr: "",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["account:+15555550124"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.select).toHaveBeenCalledWith({
      message: "Choose the linked Signal account for OpenClaw",
      options: [
        { value: "account:+15555550123", label: "+15555550123" },
        { value: "account:+15555550124", label: "+15555550124" },
        { value: "link", label: "Link another Signal account" },
      ],
      initialValue: "account:+15555550123",
    });
    expect(queued.text).not.toHaveBeenCalled();
    expect(mocks.linkSignalCliAccount).not.toHaveBeenCalled();
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550124");
  });

  it("stops before linking when the user declines in-TUI account linking", async () => {
    mocks.probeSignalTransport.mockResolvedValueOnce({ ok: false, error: "not running" });
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "[]",
      stderr: "",
    });
    const queued = createQueuedWizardPrompter({ selectValues: ["stop"] });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {
          channels: {
            signal: {
              accounts: { work: { account: "+15555550123" } },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(queued.select).toHaveBeenCalledWith({
      message: "No linked Signal account was found. How should setup continue?",
      options: [
        { value: "link", label: "Link a Signal account now" },
        { value: "stop", label: "Stop Signal setup" },
      ],
      initialValue: "link",
    });
    expect(mocks.runPluginCommandWithTimeout).toHaveBeenCalledWith({
      argv: [
        "/opt/openclaw/signal-cli",
        "--config",
        "/var/lib/signal-cli",
        "--output",
        "json",
        "listAccounts",
      ],
      timeoutMs: 10_000,
    });
    expect(mocks.linkSignalCliAccount).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
  });

  it("saves a manual account for a remote client that cannot own Signal linking", async () => {
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "[]",
      stderr: "",
    });
    const queued = createQueuedWizardPrompter({
      textValues: ["+15555550123"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
      options: { deferDeviceLinkToClient: true, remoteWizard: true },
    });

    expect(mocks.linkSignalCliAccount).not.toHaveBeenCalled();
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).not.toHaveBeenCalled();
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.account).toBe("+15555550123");
    expect(finalized?.credentialValues).toEqual({
      signalLinkDeferred: "true",
    });
    expect(queued.note).toHaveBeenLastCalledWith(
      expect.stringContaining("Signal will not be ready until that linking step succeeds."),
      "Signal next steps",
    );
    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("After this wizard finishes"),
      "Signal account linking",
    );
  });

  it("uses a temporary port when validating changes to a configured managed daemon", async () => {
    mocks.prepareSignalManagedNativeTransport.mockReturnValueOnce({
      kind: "managed-native",
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      receiveMode: "on-start",
      ignoreStories: true,
    });
    const queued = createQueuedWizardPrompter();

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
                  configPath: "/var/lib/signal-cli-old",
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
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    const validationPort = mocks.spawnSignalDaemon.mock.calls[0]?.[0]?.httpPort;
    expect(validationPort).toEqual(expect.any(Number));
    expect(validationPort).not.toBe(8080);
    expect(mocks.spawnSignalDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "/var/lib/signal-cli",
        account: "+15555550123",
        httpHost: "127.0.0.1",
        httpPort: validationPort,
        receiveMode: "manual",
        ignoreStories: true,
      }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          kind: "managed-native",
          httpPort: validationPort,
          url: `http://127.0.0.1:${String(validationPort)}`,
        }),
      }),
    );
    expect(queued.progress).toHaveBeenCalledWith("Validating Signal setup...");
    expect(queued.progress.mock.results[0]?.value.stop).toHaveBeenCalledWith(
      "Signal setup validated.",
    );
    expect(mocks.spawnSignalDaemon.mock.results[0]?.value.stop).toHaveBeenCalledOnce();
  });

  it("does not accept a separate connection URL before the spawned daemon bind is ready", async () => {
    mocks.prepareSignalManagedNativeTransport.mockReturnValueOnce({
      kind: "managed-native",
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      url: "https://signal.example.test",
    });
    const stop = vi.fn(async () => undefined);
    mocks.spawnSignalDaemon.mockReturnValueOnce({
      pid: 1234,
      stop,
      exited: Promise.resolve({ source: "process", code: 1, signal: null }),
      isExited: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    mocks.probeSignalTransport.mockImplementation(async ({ transport }) => ({
      ok: transport.url === "https://signal.example.test",
      ...(transport.url === "https://signal.example.test"
        ? { status: 200 }
        : { error: "spawned bind is not ready" }),
    }));
    const queued = createQueuedWizardPrompter({ selectValues: ["stop"] });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {},
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: expect.objectContaining({
          kind: "managed-native",
          url: "http://127.0.0.1:8080",
        }),
      }),
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects an occupied managed bind before probing a different process", async () => {
    mocks.assertSignalDaemonBindAvailable.mockRejectedValueOnce(
      new Error(
        "Signal cannot start a managed daemon on 127.0.0.1:8080 because that address is already in use.",
      ),
    );
    const queued = createQueuedWizardPrompter({ selectValues: ["stop"] });

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
                    kind: "external-native",
                    url: "http://127.0.0.1:8080",
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
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("address is already in use"),
      "Signal setup",
    );
    expect(mocks.spawnSignalDaemon).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).not.toHaveBeenCalled();
  });

  it("stops managed validation immediately when the remote wizard is cancelled", async () => {
    const abortController = new AbortController();
    const cancellation = new WizardCancelledError("Signal setup stopped");
    const stop = vi.fn(async () => undefined);
    mocks.spawnSignalDaemon.mockReturnValueOnce({
      pid: 1234,
      stop,
      exited: new Promise<never>(() => {}),
      isExited: () => false,
    });
    mocks.probeSignalTransport.mockImplementationOnce(async () => {
      abortController.abort(cancellation);
      return { ok: false, error: "not ready" };
    });
    const queued = createQueuedWizardPrompter();

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {
          channels: {
            signal: {
              accounts: { work: { account: "+15555550123" } },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
        options: { abortSignal: abortController.signal },
      }),
    ).rejects.toBe(cancellation);

    expect(stop).toHaveBeenCalledOnce();
  });

  it("offers the default signal-cli directory as a choice instead of a text answer", async () => {
    mocks.detectBinary.mockResolvedValueOnce(true);
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "not running" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const queued = createQueuedWizardPrompter({
      selectValues: ["local", "default"],
    });
    const cfg = {
      channels: {
        signal: {
          accounts: {
            work: {
              account: "+15555550123",
              transport: {
                kind: "managed-native",
                cliPath: "/opt/openclaw/signal-cli",
                configPath: "/var/lib/signal-cli",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg,
      accountId: "work",
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });
    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg,
      accountId: "work",
      credentialValues: toCredentialValues(prepared?.credentialValues),
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(prepared?.credentialValues).toMatchObject({ signalCliConfigPath: "" });
    expect(queued.select).toHaveBeenCalledWith({
      message: "Where should signal-cli store its configuration?",
      options: [
        { value: "default", label: "Use the default location" },
        { value: "custom", label: "Choose a custom directory" },
      ],
      initialValue: "custom",
    });
    expect(queued.text).not.toHaveBeenCalled();
    expect(mocks.prepareSignalManagedNativeTransport).toHaveBeenLastCalledWith({
      cfg,
      accountId: "work",
      overrides: {
        cliPath: "/opt/openclaw/signal-cli",
        configPath: "",
      },
    });
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.transport,
    ).not.toHaveProperty("configPath");
  });

  it("shows user-facing completion guidance instead of a raw gateway RPC", () => {
    const lines = signalCompletionNote.lines.join("\n");

    expect(lines).toContain("Signal setup validation passed.");
    expect(lines).toContain("save this connection when channel setup finishes");
    expect(lines).toContain("openclaw channels status --probe");
    expect(lines).not.toContain("gateway call");
    expect(
      signalCompletionNote.shouldShow({
        cfg: {},
        accountId: "work",
        credentialValues: { signalLinkDeferred: "true" },
      }),
    ).toBe(false);
  });

  it("stops a temporary daemon that exits before its managed probe", async () => {
    mocks.probeSignalTransport.mockResolvedValueOnce({ ok: false, error: "not running" });
    const stop = vi.fn(async () => undefined);
    mocks.spawnSignalDaemon.mockReturnValueOnce({
      pid: 1234,
      stop,
      exited: Promise.resolve({
        source: "process" as const,
        code: 1,
        signal: null,
      }),
      isExited: () => true,
    });
    const queued = createQueuedWizardPrompter({ selectValues: ["stop"] });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {
          channels: {
            signal: {
              accounts: { work: { account: "+15555550123" } },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: managedSignalCredentialValues,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli exited before its HTTP server became ready"),
      "Signal setup",
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("selects another linked local account before validating managed setup", async () => {
    mocks.probeSignalTransport.mockResolvedValueOnce({ ok: false, error: "not running" });
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550123"},{"number":"+15555550124"}]',
      stderr: "",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["account:+15555550124"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: configuredManagedSignalConfig({ withTransport: false }),
      accountId: "work",
      credentialValues: managedSignalCredentialValues,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).not.toHaveBeenCalled();
    expect(queued.select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Choose the linked Signal account for OpenClaw",
      }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.probeSignalTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: "+15555550124" }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550124");
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.accountUuid,
    ).toBeUndefined();
  });
});

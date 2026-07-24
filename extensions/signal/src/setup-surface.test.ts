import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import type { SignalDaemonHandle } from "./daemon.js";
import type { SignalInstallResult } from "./install-signal-cli.js";
import type { SignalTransportProbeResult } from "./setup-transport.js";
import type { SignalCliLinkResult } from "./signal-cli-link.js";

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
      onLinkUri: (uri: string) => Promise<void>;
    }): Promise<SignalCliLinkResult> => {
      await params.onLinkUri("sgnl://linkdevice?uuid=test&pub_key=test");
      return { ok: true as const, associatedAccount: "+15555550123" };
    },
  ),
  renderQrTerminal: vi.fn(async () => "TERMINAL-QR"),
  runPluginCommandWithTimeout: vi.fn(async () => ({
    code: 0,
    stdout: '[{"number":"+15555550123"}]',
    stderr: "",
  })),
  spawnSignalDaemon: vi.fn(
    (): SignalDaemonHandle => ({
      pid: 1234,
      stop: vi.fn(async () => undefined),
      exited: new Promise<never>(() => {}),
      isExited: () => false,
    }),
  ),
  prepareSignalManagedNativeTransport: vi.fn(() => ({
    kind: "managed-native" as const,
    cliPath: "/opt/openclaw/signal-cli",
    configPath: "/var/lib/signal-cli",
    httpHost: "127.0.0.1",
    httpPort: 8080,
  })),
  probeSignalTransport: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
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

import { createSignalSetupWizardProxy, signalNumberTextInputs } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

function toCredentialValues(
  values: Partial<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

describe("signalSetupWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectSignalTransport.mockImplementation(async ({ url }: { url: string }) => ({
      kind: "external-native",
      url,
    }));
    mocks.probeSignalTransport.mockResolvedValue({ ok: true, status: 200 });
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550123"}]',
      stderr: "",
    });
  });

  it("keeps account entry reversible until immediately before signal-cli installation", async () => {
    mocks.detectBinary.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const beforePersistentEffect = vi.fn(async () => undefined);
    const queued = createQueuedWizardPrompter({
      selectValues: ["local"],
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
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
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
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
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
    expect(beforePersistentEffect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.linkSignalCliAccount.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.linkSignalCliAccount).toHaveBeenCalledWith({
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      onLinkUri: expect.any(Function),
    });
    expect(mocks.renderQrTerminal).toHaveBeenCalledWith("sgnl://linkdevice?uuid=test&pub_key=test");
    expect(queued.plain).toHaveBeenCalledWith(
      expect.stringContaining("Signal > Settings > Linked devices"),
    );
    expect(queued.plain).toHaveBeenCalledWith(expect.stringContaining("TERMINAL-QR"));
    expect(queued.text).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith(
      expect.objectContaining({ account: "+15555550123" }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550123");
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
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
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
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
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

  it("lets the user choose among multiple existing local signal-cli accounts", async () => {
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
      cfg: {},
      accountId: "work",
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
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
        credentialValues: {
          signalTransportKind: "managed-native",
          signalCliPath: "/opt/openclaw/signal-cli",
          signalCliConfigPath: "/var/lib/signal-cli",
        },
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
    expect(mocks.probeSignalTransport).not.toHaveBeenCalled();
  });

  it("starts and stops a temporary signal-cli daemon around a managed probe", async () => {
    const runtime = createRuntimeEnv({ throwOnExit: false });
    const queued = createQueuedWizardPrompter();

    await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: { work: { account: "+15555550123" } },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
      prompter: queued.prompter,
      runtime,
    });

    expect(mocks.spawnSignalDaemon).toHaveBeenCalledWith({
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "/var/lib/signal-cli",
      account: "+15555550123",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      runtime,
    });
    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.spawnSignalDaemon.mock.results[0]?.value.stop).toHaveBeenCalledOnce();
  });

  it("stops a temporary daemon that exits before its managed probe", async () => {
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
        credentialValues: {
          signalTransportKind: "managed-native",
          signalCliPath: "/opt/openclaw/signal-cli",
          signalCliConfigPath: "/var/lib/signal-cli",
        },
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("signal-cli exited before its HTTP server became ready"),
      "Signal setup",
    );
    expect(mocks.probeSignalTransport).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("detects, probes, and writes a concrete existing container transport", async () => {
    mocks.detectSignalTransport.mockResolvedValue({
      kind: "container",
      url: "http://signal-helper:8080",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {},
      accountId: "work",
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });
    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: { work: { account: "+15555550123" } },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: toCredentialValues(prepared?.credentialValues),
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.detectSignalTransport).toHaveBeenCalledWith({
      url: "http://signal-helper:8080",
    });
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "work",
      transport: { kind: "container", url: "http://signal-helper:8080" },
      account: "+15555550123",
    });
    expect(finalized?.cfg?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-helper:8080",
    });
  });

  it("requires a Signal account before probing a container", async () => {
    const queued = createQueuedWizardPrompter({ textValues: ["+15555550123"] });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "work",
      credentialValues: {
        signalTransportKind: "container",
        signalServerUrl: "http://signal-helper:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Signal phone number" }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "work",
      transport: { kind: "container", url: "http://signal-helper:8080" },
      account: "+15555550123",
    });
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550123");
  });

  it("changes the Signal account and retries after a failed probe", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "account not registered" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const queued = createQueuedWizardPrompter({
      selectValues: ["account"],
      textValues: ["+15555550124"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: { work: { account: "+15555550123" } },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.probeSignalTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: "+15555550124" }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550124");
  });

  it("selects another linked local account after a managed probe failure", async () => {
    mocks.runPluginCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: '[{"number":"+15555550123"},{"number":"+15555550124"}]',
      stderr: "",
    });
    mocks.spawnSignalDaemon.mockReturnValueOnce({
      pid: 1234,
      stop: vi.fn(async () => undefined),
      exited: Promise.resolve({
        source: "process" as const,
        code: 1,
        signal: null,
      }),
      isExited: () => true,
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["account", "account:+15555550124"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: { work: { account: "+15555550123" } },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: {
        signalTransportKind: "managed-native",
        signalCliPath: "/opt/openclaw/signal-cli",
        signalCliConfigPath: "/var/lib/signal-cli",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).not.toHaveBeenCalled();
    expect(queued.select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Choose the linked Signal account for OpenClaw",
      }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.probeSignalTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: "+15555550124" }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550124");
  });

  it("changes and re-detects the server URL after a failed probe", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "receive probe failed" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const queued = createQueuedWizardPrompter({
      selectValues: ["url"],
      textValues: ["http://signal-helper-new:8080"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "default",
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper-old:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledOnce();
    expect(mocks.detectSignalTransport).toHaveBeenCalledWith({
      url: "http://signal-helper-new:8080",
    });
    expect(finalized?.cfg?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-helper-new:8080",
    });
  });

  it("prompts for an account when URL recovery changes to a container", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "receive probe failed" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    mocks.detectSignalTransport.mockResolvedValueOnce({
      kind: "container",
      url: "http://signal-helper-new:8080",
    });
    const queued = createQueuedWizardPrompter({
      selectValues: ["url"],
      textValues: ["http://signal-helper-new:8080", "+15555550123"],
    });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      accountId: "default",
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper-old:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "Signal server URL" }),
    );
    expect(queued.text).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "Signal phone number" }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transport: { kind: "container", url: "http://signal-helper-new:8080" },
        account: "+15555550123",
      }),
    );
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "default" }).config.account,
    ).toBe("+15555550123");
  });

  it("retries the same candidate without re-detecting it", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "not ready" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const queued = createQueuedWizardPrompter({ selectValues: ["retry"] });

    await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.probeSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.detectSignalTransport).not.toHaveBeenCalled();
  });

  it("retries failed server detection without prompting for the URL again", async () => {
    mocks.detectSignalTransport
      .mockRejectedValueOnce(new Error("server starting"))
      .mockResolvedValueOnce({
        kind: "external-native",
        url: "http://signal-helper:8080",
      });
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "retry"],
      textValues: ["http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {},
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).toHaveBeenCalledOnce();
    expect(mocks.detectSignalTransport).toHaveBeenCalledTimes(2);
    expect(mocks.detectSignalTransport).toHaveBeenNthCalledWith(1, {
      url: "http://signal-helper:8080",
    });
    expect(mocks.detectSignalTransport).toHaveBeenNthCalledWith(2, {
      url: "http://signal-helper:8080",
    });
    expect(prepared?.credentialValues).toMatchObject({
      signalTransportKind: "external-native",
    });
  });

  it("allows an unambiguous external-native server without a Signal account", async () => {
    const queued = createQueuedWizardPrompter();

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {},
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper:8080",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.text).not.toHaveBeenCalled();
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith({
      cfg: {},
      accountId: "default",
      transport: { kind: "external-native", url: "http://signal-helper:8080" },
      account: undefined,
    });
    expect(finalized?.cfg?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-helper:8080",
    });
  });

  it("stops failed setup with the generic wizard cancellation", async () => {
    mocks.probeSignalTransport.mockResolvedValue({ ok: false, error: "not ready" });
    const queued = createQueuedWizardPrompter({ selectValues: ["stop"] });

    await expect(
      runSetupWizardFinalize({
        finalize: signalSetupWizard.finalize,
        cfg: {},
        credentialValues: {
          signalTransportKind: "external-native",
          signalServerUrl: "http://signal-helper:8080",
        },
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBeInstanceOf(WizardCancelledError);
  });

  it("rejects a URL that aliases an OpenClaw-managed daemon", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://localhost:8080", "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "127.0.0.1",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledTimes(2);
    expect(prepared?.credentialValues).toMatchObject({
      signalTransportKind: "external-native",
      signalServerUrl: "http://signal-helper:8080",
    });
  });

  it("propagates generic Back navigation without Signal-specific catches", async () => {
    const back = new Error("wizard back");
    const queued = createQueuedWizardPrompter();
    queued.select.mockRejectedValueOnce(back);

    await expect(
      runSetupWizardPrepare({
        prepare: signalSetupWizard.prepare,
        prompter: queued.prompter,
        runtime: createRuntimeEnv({ throwOnExit: false }),
      }),
    ).rejects.toBe(back);
  });

  it("collects account numbers only where the selected transport requires them", () => {
    const requiredAccountInput = signalNumberTextInputs.find((input) => input.required !== false);
    const optionalAccountInput = signalNumberTextInputs.find(
      (input) => input.message === "Signal phone number (optional)",
    );
    const proxy = createSignalSetupWizardProxy(async () => signalSetupWizard);

    expect(
      requiredAccountInput?.shouldPrompt?.({
        cfg: {},
        accountId: "default",
        credentialValues: { signalTransportKind: "managed-native" },
      }),
    ).toBe(false);
    expect(
      requiredAccountInput?.shouldPrompt?.({
        cfg: {},
        accountId: "default",
        credentialValues: { signalTransportKind: "container" },
      }),
    ).toBe(true);
    expect(optionalAccountInput?.required).toBe(false);
    expect(
      optionalAccountInput?.shouldPrompt?.({
        cfg: {},
        accountId: "default",
        credentialValues: { signalTransportKind: "external-native" },
      }),
    ).toBe(true);
    expect(proxy.finalize).toBeTypeOf("function");
  });
});

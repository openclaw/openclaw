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
import {
  configuredManagedSignalConfig,
  toCredentialValues,
} from "./setup-surface.test-fixtures.js";
import type { SignalTransportProbeResult } from "./setup-transport.js";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(
    async (_hostname: string, _options: { all: true }) =>
      [] as Array<{ address: string; family: number }>,
  ),
  detectSignalTransport: vi.fn(
    async (params: {
      url: string;
    }): Promise<{ kind: "external-native" | "container"; url: string }> => ({
      kind: "external-native",
      url: params.url,
    }),
  ),
  probeSignalTransport: vi.fn(
    async (): Promise<SignalTransportProbeResult> => ({ ok: true, status: 200 }),
  ),
}));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
}));

vi.mock("./setup-transport.js", async () => {
  const actual =
    await vi.importActual<typeof import("./setup-transport.js")>("./setup-transport.js");
  return {
    ...actual,
    detectSignalTransport: mocks.detectSignalTransport,
    probeSignalTransport: mocks.probeSignalTransport,
  };
});

import { signalSetupWizard } from "./setup-surface.js";

describe("Signal existing-server setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectSignalTransport.mockImplementation(async ({ url }: { url: string }) => ({
      kind: "external-native",
      url,
    }));
    mocks.probeSignalTransport.mockResolvedValue({ ok: true, status: 200 });
    mocks.lookup.mockResolvedValue([]);
  });

  it("changes and re-detects the server URL after a failed probe", async () => {
    mocks.probeSignalTransport
      .mockResolvedValueOnce({ ok: false, error: "receive probe failed" })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const queued = createQueuedWizardPrompter({
      selectValues: ["url"],
      textValues: ["+15555550123", "http://signal-helper-new:8080"],
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
      textValues: ["+15555550123", "http://signal-helper-new:8080"],
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
      expect.objectContaining({ message: "Signal phone number" }),
    );
    expect(queued.text).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "Signal server URL" }),
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
    const queued = createQueuedWizardPrompter({
      selectValues: ["retry"],
      textValues: ["+15555550123"],
    });

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
      textValues: ["http://signal-helper:8080", "+15555550123"],
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

  it("changes the URL after server detection fails", async () => {
    mocks.detectSignalTransport
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        kind: "external-native",
        url: "http://signal-helper-new:8080",
      });
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: [
        "http://signal-helper-old:8080",
        "http://signal-helper-new:8080",
        "+15555550123",
      ],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {},
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenNthCalledWith(1, {
      url: "http://signal-helper-old:8080",
    });
    expect(mocks.detectSignalTransport).toHaveBeenNthCalledWith(2, {
      url: "http://signal-helper-new:8080",
    });
    expect(prepared?.credentialValues).toMatchObject({
      signalTransportKind: "external-native",
      signalServerUrl: "http://signal-helper-new:8080",
    });
  });

  it("requires an explicit account for an external-native server", async () => {
    const queued = createQueuedWizardPrompter({ textValues: ["+15555550123"] });

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

    expect(queued.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Signal phone number" }),
    );
    expect(mocks.probeSignalTransport).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "default",
      transport: { kind: "external-native", url: "http://signal-helper:8080" },
      account: "+15555550123",
    });
    expect(finalized?.cfg?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-helper:8080",
    });
  });

  it("stops failed setup with the generic wizard cancellation", async () => {
    mocks.probeSignalTransport.mockResolvedValue({ ok: false, error: "not ready" });
    const queued = createQueuedWizardPrompter({
      selectValues: ["stop"],
      textValues: ["+15555550123"],
    });

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

  it("allows a URL formerly owned by a disabled managed account", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://localhost:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            enabled: false,
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

    expect(mocks.detectSignalTransport).toHaveBeenCalledOnce();
    expect(queued.note).not.toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed Signal daemon"),
      "Signal server URL",
    );
    expect(prepared?.credentialValues).toMatchObject({
      signalTransportKind: "external-native",
      signalServerUrl: "http://localhost:8080",
    });
  });

  it("rejects an IPv4-mapped IPv6 alias of an OpenClaw-managed daemon", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://[::ffff:127.0.0.1]:8080", "http://signal-helper:8080"],
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

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed Signal daemon"),
      "Signal server URL",
    );
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "http://signal-helper:8080",
    });
  });

  it("rejects an equivalent fully qualified hostname for a managed daemon", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://localhost.:8080", "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "localhost",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed Signal daemon"),
      "Signal server URL",
    );
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "http://signal-helper:8080",
    });
  });

  it("rejects a DNS alias of a hostname-based managed daemon bind", async () => {
    mocks.lookup.mockImplementation(async (host: string) =>
      host === "gateway.local" || host === "signal-alias.local"
        ? [{ address: "192.0.2.10", family: 4 }]
        : [],
    );
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://signal-alias.local:8080", "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "gateway.local",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.lookup).toHaveBeenCalledWith("signal-alias.local", { all: true });
    expect(mocks.lookup).toHaveBeenCalledWith("gateway.local", { all: true });
    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed Signal daemon"),
      "Signal server URL",
    );
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "http://signal-helper:8080",
    });
  });

  it("allows a different base path on the same reverse-proxy origin", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://signal-proxy:8080/signal-b"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              url: "http://signal-proxy:8080/signal-a",
              httpHost: "127.0.0.1",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledOnce();
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "http://signal-proxy:8080/signal-b",
    });
  });

  it("allows distinct virtual hosts that share a reverse-proxy address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "192.0.2.10", family: 4 }]);
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["https://signal-b.example/signal"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              url: "https://signal-a.example/signal",
              httpHost: "127.0.0.1",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledOnce();
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "https://signal-b.example/signal",
    });
  });

  it("allows a distinct IPv4 loopback bind on the same port", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server"],
      textValues: ["http://127.0.0.3:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "127.0.0.2",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.detectSignalTransport).toHaveBeenCalledOnce();
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "http://127.0.0.3:8080",
    });
  });

  it("rejects any IPv4 loopback alias of an IPv4 wildcard managed bind", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://127.0.0.2:8080", "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "0.0.0.0",
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
      signalServerUrl: "http://signal-helper:8080",
    });
  });

  it("rejects an IPv4 loopback alias of an IPv6 wildcard managed bind", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://127.0.0.1:8080", "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "::",
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
      signalServerUrl: "http://signal-helper:8080",
    });
  });

  it("rejects a DNS alias of an IPv4 wildcard managed bind", async () => {
    mocks.lookup.mockImplementation(async (host: string) =>
      host === "managed-signal.local" ? [{ address: "127.0.0.2", family: 4 }] : [],
    );
    const queued = createQueuedWizardPrompter({
      selectValues: ["existing-server", "url"],
      textValues: ["http://managed-signal.local:8080", "http://signal-helper:8080"],
    });

    const prepared = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            transport: {
              kind: "managed-native",
              httpHost: "0.0.0.0",
              httpPort: 8080,
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(mocks.lookup).toHaveBeenCalledWith("managed-signal.local", { all: true });
    expect(queued.note).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw-managed Signal daemon"),
      "Signal server URL",
    );
    expect(prepared?.credentialValues).toMatchObject({
      signalServerUrl: "http://signal-helper:8080",
    });
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

  it("clears the previous account UUID when a later setup step changes the account", async () => {
    const queued = createQueuedWizardPrompter();

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                account: "+15555550124",
                accountUuid: "123e4567-e89b-12d3-a456-426614174000",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      credentialValues: {
        signalTransportKind: "external-native",
        signalServerUrl: "http://signal-helper:8080",
        signalOriginalAccount: "+15555550123",
      },
      prompter: queued.prompter,
      runtime: createRuntimeEnv({ throwOnExit: false }),
    });

    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.account,
    ).toBe("+15555550124");
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.accountUuid,
    ).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-phone-number"],
  ])("clears a stale account UUID when replacing a %s account", async (_label, previousAccount) => {
    const queued = createQueuedWizardPrompter({ textValues: ["+15555550123"] });

    const finalized = await runSetupWizardFinalize({
      finalize: signalSetupWizard.finalize,
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                ...(previousAccount ? { account: previousAccount } : {}),
                accountUuid: "123e4567-e89b-12d3-a456-426614174000",
              },
            },
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

    const account = resolveSignalAccount({
      cfg: finalized?.cfg ?? {},
      accountId: "work",
    }).config;
    expect(account.account).toBe("+15555550123");
    expect(account.accountUuid).toBeUndefined();
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
      cfg: configuredManagedSignalConfig({ withTransport: false }),
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
    expect(
      resolveSignalAccount({ cfg: finalized?.cfg ?? {}, accountId: "work" }).config.accountUuid,
    ).toBeUndefined();
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
});

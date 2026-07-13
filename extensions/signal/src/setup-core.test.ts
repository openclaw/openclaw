// Signal setup-core tests cover narrow setup adapter behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createQueuedWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import { finalizeSignalSetupWizard, signalSetupAdapter } from "./setup-core.js";

function requireSavedSignalSetup(result: Awaited<ReturnType<typeof finalizeSignalSetupWizard>>) {
  if (result.cancelled) {
    throw new Error("expected Signal setup to be saved");
  }
  return result;
}

describe("signalSetupAdapter", () => {
  it("allows non-interactive external server setup without a Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        input: {
          httpUrl: "http://127.0.0.1:8080",
        },
      }),
    ).toBeNull();
  });

  it("rejects non-interactive setup without an account or server input", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {} as OpenClawConfig,
        accountId: "default",
        input: {},
      }),
    ).toBe("Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.");
  });

  it("keeps a configured Signal account for non-interactive reconfiguration", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: {
                default: {
                  account: "+15555550123",
                },
              },
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        input: {
          httpUrl: "http://127.0.0.1:8080",
        },
      }),
    ).toBeNull();
  });

  it("persists native endpoint clears for named account setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            httpUrl: "http://stale-container:18080",
            httpHost: "stale-container",
            httpPort: 18080,
            apiMode: "container",
            autoStart: false,
            accounts: {
              work: {
                account: "+15555550123",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      input: {
        cliPath: "/usr/local/bin/signal-cli",
      },
    });

    const serialized = structuredClone(next) as OpenClawConfig;
    expect(serialized.channels?.signal?.accounts?.work).toMatchObject({
      account: "+15555550123",
      cliPath: "/usr/local/bin/signal-cli",
      autoStart: true,
      apiMode: "native",
      httpUrl: "",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    expect(resolveSignalAccount({ cfg: serialized, accountId: "work" }).baseUrl).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("allocates a distinct port for non-interactive named native setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            enabled: false,
            account: "+15555550123",
            autoStart: true,
            httpHost: "127.0.0.1",
            httpPort: 8080,
            accounts: {
              work: {
                account: "+15555550124",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      input: {
        cliPath: "/usr/local/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal?.accounts?.work).toMatchObject({
      autoStart: true,
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
    expect(next?.channels?.signal?.enabled).toBe(true);
    expect(resolveSignalAccount({ cfg: next as OpenClawConfig, accountId: "work" }).baseUrl).toBe(
      "http://127.0.0.1:8081",
    );
  });

  it("preserves an existing named native port when it does not collide", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            autoStart: true,
            httpPort: 8080,
            accounts: {
              work: {
                account: "+15555550124",
                autoStart: true,
                apiMode: "native",
                httpHost: "127.0.0.1",
                httpPort: 19089,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      input: {
        cliPath: "/opt/homebrew/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.httpPort).toBe(19089);
  });

  it("does not reserve an inherited root port for a nonexistent default account", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            autoStart: true,
            httpHost: "127.0.0.1",
            httpPort: 8080,
            accounts: {
              work: {
                account: "+15555550124",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      input: {
        cliPath: "/opt/homebrew/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal?.accounts?.work).toMatchObject({
      autoStart: true,
      apiMode: "native",
      httpPort: 8080,
    });
  });

  it("preserves a named native port when managed-daemon settings use defaults", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            httpPort: 8080,
            accounts: {
              work: {
                account: "+15555550124",
                httpHost: "127.0.0.1",
                httpPort: 19089,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      input: {
        cliPath: "/opt/homebrew/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal?.accounts?.work).toMatchObject({
      autoStart: true,
      apiMode: "native",
      httpPort: 19089,
    });
  });

  it("preserves custom native endpoints during partial non-interactive setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            cliPath: "/usr/local/bin/signal-cli",
            httpHost: "0.0.0.0",
            httpPort: 19089,
            autoStart: true,
            apiMode: "native",
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        cliPath: "/opt/homebrew/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal).toMatchObject({
      account: "+15555550123",
      cliPath: "/opt/homebrew/bin/signal-cli",
      httpHost: "0.0.0.0",
      httpPort: 19089,
      autoStart: true,
      apiMode: "native",
    });
    expect(resolveSignalAccount({ cfg: next as OpenClawConfig }).baseUrl).toBe(
      "http://0.0.0.0:19089",
    );
  });

  it("resets external host and port during partial non-interactive native setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            cliPath: "/usr/local/bin/signal-cli",
            httpHost: "192.0.2.10",
            httpPort: 18080,
            autoStart: false,
            apiMode: "auto",
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        cliPath: "/opt/homebrew/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal).toMatchObject({
      account: "+15555550123",
      cliPath: "/opt/homebrew/bin/signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
      autoStart: true,
      apiMode: "native",
    });
  });

  it("scopes non-interactive default native setup when named accounts exist", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            accounts: {
              work: {
                account: "+15555550124",
                httpUrl: "http://signal-container:8080",
                autoStart: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        signalNumber: "+15555550123",
        cliPath: "/usr/local/bin/signal-cli",
      },
    });

    const serialized = structuredClone(next) as OpenClawConfig;
    expect(serialized.channels?.signal?.apiMode).toBeUndefined();
    expect(serialized.channels?.signal?.cliPath).toBeUndefined();
    expect(serialized.channels?.signal?.accounts?.default).toMatchObject({
      account: "+15555550123",
      cliPath: "/usr/local/bin/signal-cli",
      apiMode: "native",
      autoStart: true,
    });
    expect(serialized.channels?.signal?.accounts?.work).toMatchObject({
      account: "+15555550124",
      httpUrl: "http://signal-container:8080",
      autoStart: false,
    });
    expect(resolveSignalAccount({ cfg: serialized, accountId: "work" }).config.apiMode).toBe(
      undefined,
    );
  });

  it("preserves the root native port when scoping non-interactive default setup", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            cliPath: "/usr/local/bin/signal-cli",
            httpHost: "127.0.0.1",
            httpPort: 19089,
            autoStart: true,
            apiMode: "native",
            accounts: {
              work: {
                account: "+15555550124",
                httpUrl: "http://signal-container:8080",
                autoStart: false,
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        cliPath: "/opt/homebrew/bin/signal-cli",
      },
    });

    expect(next?.channels?.signal?.httpPort).toBeUndefined();
    expect(next?.channels?.signal?.accounts?.default).toMatchObject({
      httpHost: "127.0.0.1",
      httpPort: 19089,
      autoStart: true,
      apiMode: "native",
    });
  });

  it("preserves implicit default account fields when scoping around named accounts", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            apiMode: "container",
            accounts: {
              work: {
                account: "+15555550124",
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      input: {
        cliPath: "/usr/local/bin/signal-cli",
      },
    });

    const serialized = structuredClone(next) as OpenClawConfig;
    expect(serialized.channels?.signal?.account).toBeUndefined();
    expect(serialized.channels?.signal?.accountUuid).toBeUndefined();
    expect(serialized.channels?.signal?.apiMode).toBe("container");
    expect(serialized.channels?.signal?.accounts?.default).toMatchObject({
      account: "+15555550123",
      accountUuid: "123e4567-e89b-12d3-a456-426614174000",
      cliPath: "/usr/local/bin/signal-cli",
      autoStart: true,
      apiMode: "native",
    });
    expect(serialized.channels?.signal?.accounts?.work).toMatchObject({
      account: "+15555550124",
    });
  });

  it("persists a prepared native cliPath during finalize", async () => {
    const prompts = createQueuedWizardPrompter({
      textValues: ["~/Signal Data"],
    });

    const result = requireSavedSignalSetup(
      await finalizeSignalSetupWizard({
        cfg: {
          channels: {
            signal: {
              cliPath: "/tmp/openclaw-stale-signal-cli",
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        credentialValues: {
          signalTransport: "native",
          signalNumber: "+1 (555) 555-0123",
          cliPath: "/tmp/openclaw-installed-signal-cli",
        },
        prompter: prompts.prompter,
      }),
    );

    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      cliPath: "/tmp/openclaw-installed-signal-cli",
      configPath: "~/Signal Data",
      autoStart: true,
    });
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Link device with: /tmp/openclaw-installed-signal-cli --config ~/'Signal Data' link -n OpenClaw",
      ),
      "Signal next steps",
    );
  });

  it("forces native apiMode when finalizing over an external auto server", async () => {
    const prompts = createQueuedWizardPrompter({
      textValues: [""],
    });

    const result = requireSavedSignalSetup(
      await finalizeSignalSetupWizard({
        cfg: {
          channels: {
            signal: {
              account: "+15555550123",
              cliPath: "/usr/local/bin/signal-cli",
              httpUrl: "http://127.0.0.1:8080",
              autoStart: false,
              apiMode: "auto",
            },
          },
        } as OpenClawConfig,
        accountId: "default",
        credentialValues: {
          signalTransport: "native",
          cliPath: "/usr/local/bin/signal-cli",
        },
        prompter: prompts.prompter,
      }),
    );

    expect(result.cfg.channels?.signal).toMatchObject({
      account: "+15555550123",
      cliPath: "/usr/local/bin/signal-cli",
      autoStart: true,
      apiMode: "native",
    });
    expect(result.cfg.channels?.signal?.httpUrl).toBeUndefined();
  });

  it("allocates a distinct port for interactive named native setup", async () => {
    const prompts = createQueuedWizardPrompter({ textValues: [""] });

    const result = requireSavedSignalSetup(
      await finalizeSignalSetupWizard({
        cfg: {
          channels: {
            signal: {
              enabled: false,
              account: "+15555550123",
              autoStart: true,
              httpHost: "127.0.0.1",
              httpPort: 8080,
              accounts: {
                work: {
                  account: "+15555550124",
                },
              },
            },
          },
        } as OpenClawConfig,
        accountId: "work",
        credentialValues: {
          signalTransport: "native",
          signalNumber: "+15555550124",
          cliPath: "/usr/local/bin/signal-cli",
        },
        prompter: prompts.prompter,
      }),
    );

    expect(result.cfg.channels?.signal?.httpPort).toBe(8080);
    expect(result.cfg.channels?.signal?.accounts?.work).toMatchObject({
      autoStart: true,
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
    expect(result.cfg.channels?.signal?.enabled).toBe(true);
  });
});

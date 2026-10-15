import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

describe("socket transport setup", () => {
  it("preserves sockets and does not reserve HTTP ports during setup", () => {
    const transport = {
      kind: "managed-native",
      socketPath: "/tmp/signal-private/daemon.sock",
    } as const;
    const cfg = { channels: { signal: { transport } } };
    expect(prepareSignalManagedNativeTransport({ cfg, accountId: "default" })).toEqual(transport);
    expect(prepareSignalManagedNativeTransport({ cfg, accountId: "work" }).httpPort).toBe(8080);
    expect(
      writeSignalAccountTransport({
        cfg,
        accountId: "http",
        transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
      }).channels?.signal?.accounts?.http?.transport,
    ).toEqual({ kind: "external-native", url: "http://127.0.0.1:8080" });
  });
});

function signalConfig(signal: NonNullable<OpenClawConfig["channels"]>["signal"]): OpenClawConfig {
  return { channels: { signal } };
}

describe("detectSignalTransport", () => {
  it("prefers native deterministically when both endpoints are healthy", async () => {
    const transport = await detectSignalTransport({
      url: "http://signal:8080",
      probeNative: vi.fn().mockResolvedValue({ ok: true }),
      probeContainer: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(transport).toEqual({ kind: "external-native", url: "http://signal:8080" });
  });

  it("selects container only when its endpoint is healthy", async () => {
    const probeContainer = vi.fn().mockResolvedValue({ ok: true });
    const transport = await detectSignalTransport({
      url: "http://signal:8080/",
      account: "+15555550123",
      probeNative: vi.fn().mockResolvedValue({ ok: false }),
      probeContainer,
    });

    expect(transport).toEqual({ kind: "container", url: "http://signal:8080" });
    expect(probeContainer).toHaveBeenCalledWith("http://signal:8080", 10_000, "+15555550123");
  });

  it("rejects an endpoint that matches neither transport", async () => {
    await expect(
      detectSignalTransport({
        url: "http://signal:8080",
        probeNative: vi.fn().mockResolvedValue({ ok: false }),
        probeContainer: vi.fn().mockResolvedValue({ ok: false }),
      }),
    ).rejects.toThrow("Signal transport not reachable at http://signal:8080");
  });
});

describe("prepareSignalManagedNativeTransport", () => {
  it("rejects an explicitly requested port owned by another account", () => {
    const cfg = signalConfig({
      account: "+15555550123",
      transport: { kind: "managed-native", httpPort: 8080 },
      accounts: { work: { account: "+15555550124" } },
    });

    expect(() =>
      prepareSignalManagedNativeTransport({
        cfg,
        accountId: "work",
        overrides: { httpPort: 8080 },
      }),
    ).toThrow("Signal managed native port 8080 is already reserved");
  });

  it("keeps sibling implicit allocation stable while updating an existing target", () => {
    const cfg = signalConfig({
      accounts: {
        a: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
        },
        b: { account: "+15555550124", transport: { kind: "managed-native" } },
      },
    });

    const transport = prepareSignalManagedNativeTransport({
      cfg,
      accountId: "a",
      overrides: { cliPath: "/opt/signal-cli" },
    });
    const next = writeSignalAccountTransport({
      cfg,
      accountId: "a",
      transport,
    });

    expect(transport.httpPort).toBe(8080);
    expect(resolveSignalAccount({ cfg: next, accountId: "b" }).transport).toMatchObject({
      httpPort: 8081,
    });
  });

  it("keeps an aligned managed connection URL on the allocated bind port", () => {
    const cfg = signalConfig({
      account: "+15555550123",
      transport: { kind: "managed-native", httpPort: 8080 },
      accounts: {
        work: {
          account: "+15555550124",
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8080",
            httpHost: "0.0.0.0",
          },
        },
      },
    });

    expect(prepareSignalManagedNativeTransport({ cfg, accountId: "work" })).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8081",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
  });

  it("reserves a local HTTPS proxy endpoint independently from the daemon bind", () => {
    const cfg = signalConfig({
      transport: {
        kind: "managed-native",
        url: "https://127.0.0.1:8080",
      },
    });

    expect(prepareSignalManagedNativeTransport({ cfg, accountId: "default" })).toEqual({
      kind: "managed-native",
      url: "https://127.0.0.1:8080",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("uses IPv6 loopback when an aligned endpoint moves to the IPv6 wildcard bind", () => {
    const cfg = signalConfig({
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8080",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      },
    });

    expect(
      prepareSignalManagedNativeTransport({
        cfg,
        accountId: "default",
        overrides: { httpHost: "::" },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://[::1]:8080",
      httpHost: "::",
      httpPort: 8080,
    });
  });

  it.each(["http://localhost.:8080"])("reserves port 8080 for loopback alias %s", (url) => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            external: {
              account: "+15555550123",
              transport: { kind: "external-native", url },
            },
            work: { account: "+15555550124" },
          },
        },
      },
    } as const;

    expect(prepareSignalManagedNativeTransport({ cfg, accountId: "work" }).httpPort).toBe(8081);
  });

  it("reserves managed bind and local connection endpoint ports", () => {
    const cfg = signalConfig({
      accounts: {
        proxy: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://localhost:8080",
            httpPort: 8181,
          },
        },
        work: { account: "+15555550124" },
      },
    });

    expect(prepareSignalManagedNativeTransport({ cfg, accountId: "work" }).httpPort).toBe(8081);
  });

  it.each([65_536])("rejects invalid preferred port %s", (httpPort) => {
    expect(() =>
      prepareSignalManagedNativeTransport({
        cfg: {},
        accountId: "work",
        overrides: { httpPort },
      }),
    ).toThrow("Signal managed native port must be an integer between 1 and 65535.");
  });
});

describe("probeSignalTransport", () => {
  it("probes only the configured concrete transport", async () => {
    const probeNative = vi.fn().mockResolvedValue({ ok: true });
    const probeContainer = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      probeSignalTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "container", url: "http://signal:8080" },
        account: "+15555550123",
        probeNative,
        probeContainer,
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeNative).not.toHaveBeenCalled();
    expect(probeContainer).toHaveBeenCalledWith("http://signal:8080", 10_000, "+15555550123");
  });

  it("probes the allocated port for an implicit managed account transport", async () => {
    const probeNative = vi.fn().mockResolvedValue({ ok: true });
    const cfg = signalConfig({
      account: "+15555550123",
      transport: { kind: "managed-native", httpPort: 8080 },
      accounts: { work: { account: "+15555550124" } },
    });

    await expect(
      probeSignalTransport({
        cfg,
        accountId: "work",
        transport: { kind: "managed-native" },
        probeNative,
      }),
    ).resolves.toEqual({ ok: true });
    expect(probeNative).toHaveBeenCalledWith("http://127.0.0.1:8081", 10_000);
  });
});

describe("writeSignalAccountTransport", () => {
  it("ignores the unconfigured implicit default account during endpoint collision checks", () => {
    const next = writeSignalAccountTransport({
      cfg: {},
      accountId: "work",
      transport: { kind: "external-native", url: "http://localhost:8080" },
    });

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://localhost:8080",
    });
  });

  it("rejects explicit non-HTTP endpoint schemes", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "external-native", url: "ftp://signal.example" },
      }),
    ).toThrow("Signal transport URL unsupported protocol: ftp:");
  });

  it.each(["http:/localhost:8080"])("rejects malformed HTTP endpoint %s", (url) => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "external-native", url },
      }),
    ).toThrow("Signal transport URL has a malformed HTTP scheme");
  });

  it("rejects a local external endpoint on an enabled sibling managed bind", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {
          channels: {
            signal: {
              enabled: false,
              account: "+15555550123",
              transport: { kind: "managed-native", httpPort: 8181 },
            },
          },
        },
        accountId: "work",
        transport: { kind: "external-native", url: "http://localhost:8181" },
      }),
    ).toThrow(
      'Signal external-native account "work" uses local port 8181, which conflicts with managed native account "default".',
    );
  });

  it("allows a local external endpoint on a disabled sibling managed bind", () => {
    const next = writeSignalAccountTransport({
      cfg: {
        channels: {
          signal: {
            account: "+15555550124",
            accounts: {
              dormant: {
                enabled: false,
                account: "+15555550123",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
            },
          },
        },
      },
      accountId: "work",
      transport: { kind: "container", url: "http://localhost:8181" },
    });

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://localhost:8181",
    });
  });

  it("rejects an enabled container transport without an effective account", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "work",
        transport: { kind: "container", url: "http://container:8080" },
      }),
    ).toThrow("Signal container transport requires an account number for an enabled account.");
  });

  it("rejects invalid managed native hosts", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {},
        accountId: "default",
        transport: { kind: "managed-native", httpHost: "bad host" },
      }),
    ).toThrow("Signal transport host must be a hostname or IP address");
  });

  it.each(["localhost:8181"])(
    "rejects a managed native host containing a non-IPv6 colon: %s",
    (httpHost) => {
      expect(() =>
        writeSignalAccountTransport({
          cfg: {},
          accountId: "default",
          transport: { kind: "managed-native", httpHost },
        }),
      ).toThrow("Signal transport host must be a hostname or IP address");
    },
  );

  it("rejects a managed bind on a sibling local endpoint", () => {
    expect(() =>
      writeSignalAccountTransport({
        cfg: {
          channels: {
            signal: {
              account: "+15555550123",
              accounts: {
                external: {
                  transport: { kind: "external-native", url: "http://localhost:8181" },
                },
              },
            },
          },
        },
        accountId: "managed",
        transport: { kind: "managed-native", httpPort: 8181 },
      }),
    ).toThrow(
      'Signal managed native account "managed" binds port 8181, which conflicts with account "external" local transport endpoint.',
    );
  });
});

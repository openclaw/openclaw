import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import {
  detectSignalTransport,
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

type Transport = Parameters<typeof writeSignalAccountTransport>[0]["transport"];
const native = (options: Omit<Extract<Transport, { kind: "managed-native" }>, "kind"> = {}) =>
  ({ kind: "managed-native", ...options }) as const;
const external = (url: string) => ({ kind: "external-native", url }) as const;
const account = (transport?: Transport, number = "+15555550123") => ({
  account: number,
  transport,
});
const prepare = (
  cfg: OpenClawConfig,
  accountId = "work",
  overrides?: Parameters<typeof prepareSignalManagedNativeTransport>[0]["overrides"],
) => prepareSignalManagedNativeTransport({ cfg, accountId, overrides });
const write = (cfg: OpenClawConfig, transport: Transport, accountId = "work") =>
  writeSignalAccountTransport({ cfg, accountId, transport });

describe("socket transport setup", () => {
  it("preserves sockets and does not reserve HTTP ports during setup", () => {
    const transport = native({ socketPath: "/tmp/signal-private/daemon.sock" });
    const cfg = { channels: { signal: { transport } } };
    expect(prepare(cfg, "default")).toEqual(transport);
    expect(prepare(cfg).httpPort).toBe(8080);
    expect(
      write(cfg, external("http://127.0.0.1:8080"), "http").channels?.signal?.accounts?.http
        ?.transport,
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
      ...account(native({ httpPort: 8080 })),
      accounts: { work: account(undefined, "+15555550124") },
    });

    expect(() => prepare(cfg, "work", { httpPort: 8080 })).toThrow(
      "Signal managed native port 8080 is already reserved",
    );
  });

  it("keeps sibling implicit allocation stable while updating an existing target", () => {
    const cfg = signalConfig({
      accounts: {
        a: account(native({ httpPort: 8080 })),
        b: account(native(), "+15555550124"),
      },
    });

    const transport = prepare(cfg, "a", { cliPath: "/opt/signal-cli" });
    const next = write(cfg, transport, "a");

    expect(transport.httpPort).toBe(8080);
    expect(resolveSignalAccount({ cfg: next, accountId: "b" }).transport).toMatchObject({
      httpPort: 8081,
    });
  });

  it("keeps an aligned managed connection URL on the allocated bind port", () => {
    const cfg = signalConfig({
      ...account(native({ httpPort: 8080 })),
      accounts: {
        work: account(
          native({ url: "http://127.0.0.1:8080", httpHost: "0.0.0.0" }),
          "+15555550124",
        ),
      },
    });

    expect(prepare(cfg)).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8081",
      httpHost: "0.0.0.0",
      httpPort: 8081,
    });
  });

  it("reserves a local HTTPS proxy endpoint independently from the daemon bind", () => {
    const cfg = signalConfig({
      transport: native({ url: "https://127.0.0.1:8080" }),
    });

    expect(prepare(cfg, "default")).toEqual({
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

    expect(prepare(cfg, "default", { httpHost: "::" })).toEqual({
      kind: "managed-native",
      url: "http://[::1]:8080",
      httpHost: "::",
      httpPort: 8080,
    });
  });

  it.each(["http://localhost.:8080"])("reserves port 8080 for loopback alias %s", (url) => {
    const cfg = signalConfig({
      accounts: { external: account(external(url)), work: account(undefined, "+15555550124") },
    });

    expect(prepare(cfg).httpPort).toBe(8081);
  });

  it("reserves managed bind and local connection endpoint ports", () => {
    const cfg = signalConfig({
      accounts: {
        proxy: account(native({ url: "http://localhost:8080", httpPort: 8181 })),
        work: account(undefined, "+15555550124"),
      },
    });

    expect(prepare(cfg).httpPort).toBe(8081);
  });

  it.each([65_536])("rejects invalid preferred port %s", (httpPort) => {
    expect(() => prepare({}, "work", { httpPort })).toThrow(
      "Signal managed native port must be an integer between 1 and 65535.",
    );
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
      ...account(native({ httpPort: 8080 })),
      accounts: { work: account(undefined, "+15555550124") },
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
    const next = write({}, external("http://localhost:8080"));

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://localhost:8080",
    });
  });

  it.each([
    [external("ftp://signal.example"), "Signal transport URL unsupported protocol: ftp:"],
    [external("http:/localhost:8080"), "Signal transport URL has a malformed HTTP scheme"],
    [native({ httpHost: "bad host" }), "Signal transport host must be a hostname or IP address"],
    [
      native({ httpHost: "localhost:8181" }),
      "Signal transport host must be a hostname or IP address",
    ],
  ] as const)("rejects invalid transport %j", (transport, error) => {
    expect(() => write({}, transport, "default")).toThrow(error);
  });

  it("rejects a local external endpoint on an enabled sibling managed bind", () => {
    const cfg = signalConfig({ enabled: false, ...account(native({ httpPort: 8181 })) });
    expect(() => write(cfg, external("http://localhost:8181"))).toThrow(
      'Signal external-native account "work" uses local port 8181, which conflicts with managed native account "default".',
    );
  });

  it("allows a local external endpoint on a disabled sibling managed bind", () => {
    const cfg = signalConfig({
      account: "+15555550124",
      accounts: { dormant: { enabled: false, ...account(native({ httpPort: 8181 })) } },
    });
    const next = write(cfg, { kind: "container", url: "http://localhost:8181" });

    expect(next.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://localhost:8181",
    });
  });

  it("rejects an enabled container transport without an effective account", () => {
    expect(() => write({}, { kind: "container", url: "http://container:8080" })).toThrow(
      "Signal container transport requires an account number for an enabled account.",
    );
  });

  it("rejects a managed bind on a sibling local endpoint", () => {
    const cfg = signalConfig({
      account: "+15555550123",
      accounts: { external: { transport: external("http://localhost:8181") } },
    });
    expect(() => write(cfg, native({ httpPort: 8181 }), "managed")).toThrow(
      'Signal managed native account "managed" binds port 8181, which conflicts with account "external" local transport endpoint.',
    );
  });
});

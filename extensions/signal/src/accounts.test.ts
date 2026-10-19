import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalTransport,
} from "./accounts.js";

type Signal = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;
type Transport = NonNullable<Signal["transport"]>;
type Native = Omit<Extract<Transport, { kind: "managed-native" }>, "kind">;
type Check = [expected: Partial<ResolvedSignalTransport>, accountId?: string, exact?: boolean];
type Case = [name: string, signal: Signal, ...checks: Check[]];
const phone = "+15555550123";
const socketPath = "/tmp/signal private/a#b.sock";
const socketUrl = "unix:///tmp/signal%20private/a%23b.sock";
const baseUrl = "http://127.0.0.1:8080";
const native = (options: Native = {}): Transport => ({ kind: "managed-native", ...options });
const account = (options: Native = {}) => ({ account: phone, transport: native(options) });
const endpoint = (kind: "container" | "external-native", url: string): Transport => ({ kind, url });
const config = (signal: Signal): OpenClawConfig => ({ channels: { signal } });
const accounts = (entries: NonNullable<Signal["accounts"]>): Signal => ({ accounts: entries });
const http = (url: string, host: string, port: number, id?: string): Check => [
  { kind: "managed-native", baseUrl: url, httpHost: host, httpPort: port },
  id,
];
const defaults: ResolvedSignalTransport = {
  kind: "managed-native",
  baseUrl,
  cliPath: "signal-cli",
  httpHost: "127.0.0.1",
  httpPort: 8080,
  startupTimeoutMs: 30_000,
};
const port = (httpPort: number, id = "work"): Check => [{ kind: "managed-native", httpPort }, id];

it.each<Case>([
  [
    "socket encoding leaves HTTP port free",
    { transport: native({ socketPath }), accounts: { http: { transport: native() } } },
    [{ socketPath, baseUrl: socketUrl }],
    [{ baseUrl }, "http"],
  ],
  [
    "disabled socket sibling",
    {
      transport: native({ socketPath }),
      accounts: { work: { enabled: false, transport: native({ socketPath }) } },
    },
    [{ baseUrl: socketUrl }],
  ],
  ["omitted transport defaults", {}, [defaults, undefined, true]],
  [
    "independent connection URL",
    { transport: native({ url: "http://127.0.0.1:8181", httpHost: "0.0.0.0", httpPort: 8181 }) },
    http("http://127.0.0.1:8181", "0.0.0.0", 8181),
  ],
  [
    "bracketed IPv6 bind",
    { transport: native({ httpHost: "[::1]", httpPort: 8181 }) },
    http("http://[::1]:8181", "::1", 8181),
  ],
  [
    "independent bind address",
    { transport: native({ url: baseUrl, httpHost: "127.0.0.2" }) },
    http(baseUrl, "127.0.0.2", 8081),
  ],
  [
    "root transport is not inherited",
    {
      transport: endpoint("container", "http://default-container:8080"),
      accounts: { work: { account: phone } },
    },
    [{ kind: "container", baseUrl: "http://default-container:8080" }, undefined, true],
    [{ kind: "managed-native", baseUrl }, "work"],
  ],
  [
    "root transport overrides accounts.default",
    {
      transport: endpoint("external-native", "http://canonical-native:8181"),
      accounts: {
        default: {
          account: phone,
          transport: endpoint("container", "http://stale-container:8080"),
        },
      },
    },
    [{ kind: "external-native", baseUrl: "http://canonical-native:8181" }, "default", true],
  ],
  [
    "distinct implicit ports",
    accounts({ personal: account(), work: account() }),
    port(8080, "personal"),
    port(8081),
  ],
  [
    "case-preserving key",
    accounts({ alpha: account({ httpPort: 8080 }), Ops: account() }),
    port(8081, "Ops"),
  ],
  [
    "disabled explicit reservation",
    accounts({
      dormant: { ...account({ httpPort: 8181 }), enabled: false },
      work: account({ httpPort: 8181 }),
    }),
    port(8181),
  ],
  [
    "unconfigured placeholder",
    accounts({ placeholder: { enabled: false }, work: account() }),
    port(8080),
  ],
  [
    "bind and connection reservations",
    accounts({
      proxy: account({ url: "http://localhost:8080", httpPort: 8181 }),
      work: account(),
    }),
    port(8081),
  ],
  [
    "connection URL follows allocated bind",
    {
      transport: native({ httpPort: 8080 }),
      accounts: { work: account({ url: baseUrl, httpHost: "0.0.0.0" }) },
    },
    http("http://127.0.0.1:8081", "0.0.0.0", 8081, "work"),
  ],
])("resolves %s", (_name, signal, ...checks) => {
  for (const [expected, accountId, exact] of checks) {
    const resolved = resolveSignalAccount({ cfg: config(signal), accountId });
    if (exact) {
      expect(resolved.transport).toEqual(expected);
    } else {
      expect(resolved.transport).toMatchObject(expected);
    }
    if (expected.baseUrl) {
      expect(resolved.baseUrl).toBe(expected.baseUrl);
    }
  }
});

it.each<[string, Signal, string, string?]>([
  [
    "duplicate enabled sockets",
    {
      transport: native({ socketPath }),
      accounts: { work: { transport: native({ socketPath }) } },
    },
    "distinct socket path",
  ],
  [
    "socket with HTTP options",
    { transport: native({ socketPath, httpPort: 8080 }) },
    "cannot be combined",
  ],
  [
    "duplicate explicit ports",
    accounts({
      personal: account({ httpPort: 8181 }),
      work: account({ httpPort: 8181 }),
    }),
    'Signal managed native accounts "work" and "personal" both bind port 8181.',
    "work",
  ],
  [
    "local external endpoint collision",
    accounts({
      proxy: { account: phone, transport: endpoint("container", "http://localhost:8181") },
      work: account({ httpPort: 8181 }),
    }),
    'Signal managed native account "work" binds port 8181, which conflicts with account "proxy" local transport endpoint.',
    "work",
  ],
  [
    "own independent local endpoint collision",
    {
      account: phone,
      transport: native({ url: "https://127.0.0.1:8181", httpPort: 8181 }),
    },
    'Signal managed native account "default" binds port 8181, which conflicts with its local transport endpoint.',
  ],
])("rejects %s", (_name, signal, message, accountId) => {
  expect(() => resolveSignalAccount({ cfg: config(signal), accountId })).toThrow(message);
});

it.each<[string, Signal, string[], string, string?, boolean?]>([
  [
    "top-level account",
    { account: phone, accounts: { work: { enabled: false } } },
    ["default", "work"],
    "default",
    phone,
  ],
  [
    "case-preserving default",
    {
      transport: endpoint("container", "http://signal-container:8080"),
      accounts: { Default: { account: phone } },
    },
    ["default"],
    "default",
    phone,
  ],
  [
    "UUID with a named account",
    {
      accountUuid: "123e4567-e89b-12d3-a456-426614174000",
      accounts: { work: { account: phone } },
    },
    ["work"],
    "work",
    undefined,
    false,
  ],
])("selects the %s", (_name, signal, ids, accountId, expectedAccount, defaultConfigured) => {
  const cfg = config(signal);
  const resolved = resolveSignalAccount({ cfg });
  expect(listSignalAccountIds(cfg)).toEqual(ids);
  expect(resolveDefaultSignalAccountId(cfg)).toBe(accountId);
  expect(resolved).toMatchObject({ accountId, configured: true });
  if (expectedAccount) {
    expect(resolved.config.account).toBe(expectedAccount);
  }
  if (defaultConfigured !== undefined) {
    expect(resolveSignalAccount({ cfg, accountId: "default" }).configured).toBe(defaultConfigured);
  }
});

it("uses configured defaultAccount when accountId is omitted", () => {
  const work = {
    name: "Work",
    account: phone,
    transport: endpoint("external-native", "http://127.0.0.1:9999"),
  };
  const resolved = resolveSignalAccount({
    cfg: config({ defaultAccount: "work", accounts: { work } }),
  });
  expect(resolved).toMatchObject({
    accountId: "work",
    name: "Work",
    baseUrl: "http://127.0.0.1:9999",
    configured: true,
    config: { account: phone },
  });
  expect(resolved.transport).toEqual({
    kind: "external-native",
    baseUrl: "http://127.0.0.1:9999",
  });
});

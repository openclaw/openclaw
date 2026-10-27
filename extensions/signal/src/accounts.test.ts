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
type Case = [signal: Signal, ...checks: Check[]];
const phone = "+15555550123";
const socketPath = "/tmp/signal private/a#b.sock";
const socketUrl = "unix:///tmp/signal%20private/a%23b.sock";
const baseUrl = "http://127.0.0.1:8080";
const native = (options: Native = {}): Transport => ({ kind: "managed-native", ...options });
const account = (options: Native = {}) => ({ account: phone, transport: native(options) });
const endpoint = <Kind extends "container" | "external-native">(kind: Kind, url: string) => ({
  transport: { kind, url },
});
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
const root = (options: Native, extra: Signal = {}) => ({ transport: native(options), ...extra });
const socket = { transport: native({ socketPath }) };
const dormant = { enabled: false };
const explicit = account({ httpPort: 8181 });
const containerUrl = "http://default-container:8080";
const externalUrl = "http://canonical-native:8181";
const container = endpoint("container", containerUrl);
const external = endpoint("external-native", externalUrl);
const uuid = "123e4567-e89b-12d3-a456-426614174000";
const namedAccount = accounts({ work: { account: phone } });

it.each<Case>([
  [
    { ...socket, accounts: { http: { transport: native() } } },
    [{ socketPath, baseUrl: socketUrl }],
    [{ baseUrl }, "http"],
  ],
  [{ ...socket, accounts: { work: { ...dormant, ...socket } } }, [{ baseUrl: socketUrl }]],
  [{}, [defaults, undefined, true]],
  [
    root({ url: "http://127.0.0.1:8181", httpHost: "0.0.0.0", httpPort: 8181 }),
    http("http://127.0.0.1:8181", "0.0.0.0", 8181),
  ],
  [root({ httpHost: "[::1]", httpPort: 8181 }), http("http://[::1]:8181", "::1", 8181)],
  [root({ url: baseUrl, httpHost: "127.0.0.2" }), http(baseUrl, "127.0.0.2", 8081)],
  [
    { ...container, ...namedAccount },
    [{ kind: "container", baseUrl: containerUrl }, undefined, true],
    [{ kind: "managed-native", baseUrl }, "work"],
  ],
  [
    { ...external, ...accounts({ default: { account: phone, ...container } }) },
    [{ kind: "external-native", baseUrl: externalUrl }, "default", true],
  ],
  [accounts({ personal: account(), work: account() }), port(8080, "personal"), port(8081)],
  [accounts({ alpha: account({ httpPort: 8080 }), Ops: account() }), port(8081, "Ops")],
  [accounts({ dormant: { ...explicit, ...dormant }, work: explicit }), port(8181)],
  [accounts({ placeholder: dormant, work: account() }), port(8080)],
  [
    accounts({ proxy: account({ url: "http://localhost:8080", httpPort: 8181 }), work: account() }),
    port(8081),
  ],
  [
    root({ httpPort: 8080 }, accounts({ work: account({ url: baseUrl, httpHost: "0.0.0.0" }) })),
    http("http://127.0.0.1:8081", "0.0.0.0", 8081, "work"),
  ],
])("resolves transport %j", (signal, ...checks) => {
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

it.each<[Signal, string, string?]>([
  [{ ...socket, accounts: { work: socket } }, "distinct socket path"],
  [root({ socketPath, httpPort: 8080 }), "cannot be combined"],
  [
    accounts({ personal: explicit, work: explicit }),
    'Signal managed native accounts "work" and "personal" both bind port 8181.',
    "work",
  ],
  [
    accounts({
      proxy: { account: phone, ...endpoint("container", "http://localhost:8181") },
      work: explicit,
    }),
    'Signal managed native account "work" binds port 8181, which conflicts with account "proxy" local transport endpoint.',
    "work",
  ],
  [
    { account: phone, ...root({ url: "https://127.0.0.1:8181", httpPort: 8181 }) },
    'Signal managed native account "default" binds port 8181, which conflicts with its local transport endpoint.',
  ],
])("rejects %j: %s", (signal, message, accountId) => {
  expect(() => resolveSignalAccount({ cfg: config(signal), accountId })).toThrow(message);
});

it.each<[Signal, string[], string, string?, boolean?]>([
  [{ account: phone, ...accounts({ work: dormant }) }, ["default", "work"], "default", phone],
  [{ ...container, ...accounts({ Default: { account: phone } }) }, ["default"], "default", phone],
  [{ accountUuid: uuid, ...namedAccount }, ["work"], "work", undefined, false],
])("selects an account from %j", (signal, ids, accountId, expectedAccount, defaultConfigured) => {
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
  const workUrl = "http://127.0.0.1:9999";
  const work = { name: "Work", account: phone, ...endpoint("external-native", workUrl) };
  const cfg = config({ defaultAccount: "work", accounts: { work } });
  const resolved = resolveSignalAccount({ cfg });
  expect(resolved).toMatchObject({
    accountId: "work",
    name: "Work",
    baseUrl: workUrl,
    configured: true,
    config: { account: phone },
  });
  expect(resolved.transport).toEqual({ kind: "external-native", baseUrl: workUrl });
});

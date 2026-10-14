import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  type ResolvedSignalTransport,
} from "./accounts.js";

type SignalConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;
type NativeTransport = Extract<NonNullable<SignalConfig["transport"]>, { kind: "managed-native" }>;
const phone = "+15555550123";
const socketPath = "/tmp/signal private/a#b.sock";
const native = (options: Omit<NativeTransport, "kind"> = {}): NativeTransport => ({
  kind: "managed-native",
  ...options,
});
const account = (transport = native()) => ({ account: phone, transport });
const config = (signal: SignalConfig): OpenClawConfig => ({ channels: { signal } });
type TransportCase = {
  name: string;
  signal: SignalConfig;
  checks: Array<{
    accountId?: string;
    expected: Partial<ResolvedSignalTransport>;
    exact?: boolean;
  }>;
};

function portCase(
  name: string,
  accounts: NonNullable<SignalConfig["accounts"]>,
  accountId: string,
  httpPort: number,
): TransportCase {
  return {
    name,
    signal: { accounts },
    checks: [{ accountId, expected: { kind: "managed-native", httpPort } }],
  };
}

describe("resolveSignalAccount", () => {
  it.each<TransportCase>([
    {
      name: "socket URL encoding without reserving an HTTP port",
      signal: { transport: native({ socketPath }), accounts: { http: { transport: native() } } },
      checks: [
        { expected: { socketPath, baseUrl: "unix:///tmp/signal%20private/a%23b.sock" } },
        { accountId: "http", expected: { baseUrl: "http://127.0.0.1:8080" } },
      ],
    },
    {
      name: "disabled socket sibling",
      signal: {
        transport: native({ socketPath }),
        accounts: { work: { enabled: false, transport: native({ socketPath }) } },
      },
      checks: [{ expected: { baseUrl: "unix:///tmp/signal%20private/a%23b.sock" } }],
    },
    {
      name: "omitted transport defaults",
      signal: {},
      checks: [
        {
          exact: true,
          expected: {
            kind: "managed-native",
            baseUrl: "http://127.0.0.1:8080",
            cliPath: "signal-cli",
            httpHost: "127.0.0.1",
            httpPort: 8080,
            startupTimeoutMs: 30_000,
          },
        },
      ],
    },
    ...[
      {
        name: "independent connection URL",
        options: { url: "http://127.0.0.1:8181", httpHost: "0.0.0.0", httpPort: 8181 },
        expected: { baseUrl: "http://127.0.0.1:8181", httpHost: "0.0.0.0", httpPort: 8181 },
      },

      {
        name: "bracketed IPv6 bind",
        options: { httpHost: "[::1]", httpPort: 8181 },
        expected: { baseUrl: "http://[::1]:8181", httpHost: "::1", httpPort: 8181 },
      },

      {
        name: "independent bind address",
        options: { url: "http://127.0.0.1:8080", httpHost: "127.0.0.2" },
        expected: { baseUrl: "http://127.0.0.1:8080", httpHost: "127.0.0.2", httpPort: 8081 },
      },
    ].map(({ name, options, expected }): TransportCase => ({
      name,
      signal: { transport: native(options) },
      checks: [{ expected: { kind: "managed-native", ...expected } }],
    })),
    {
      name: "root transport is not inherited by named accounts",
      signal: {
        transport: { kind: "container", url: "http://default-container:8080" },
        accounts: { work: { account: phone } },
      },
      checks: [
        { exact: true, expected: { kind: "container", baseUrl: "http://default-container:8080" } },
        {
          accountId: "work",
          expected: { kind: "managed-native", baseUrl: "http://127.0.0.1:8080" },
        },
      ],
    },
    {
      name: "root transport overrides accounts.default",
      signal: {
        transport: { kind: "external-native", url: "http://canonical-native:8181" },
        accounts: {
          default: {
            account: phone,
            transport: { kind: "container", url: "http://stale-container:8080" },
          },
        },
      },
      checks: [
        {
          accountId: "default",
          exact: true,
          expected: { kind: "external-native", baseUrl: "http://canonical-native:8181" },
        },
      ],
    },
    {
      name: "distinct implicit ports",
      signal: { accounts: { personal: account(), work: account() } },
      checks: [
        { accountId: "personal", expected: { kind: "managed-native", httpPort: 8080 } },
        { accountId: "work", expected: { kind: "managed-native", httpPort: 8081 } },
      ],
    },
    portCase(
      "case-preserving key",
      {
        alpha: account(native({ httpPort: 8080 })),
        Ops: account(),
      },
      "Ops",
      8081,
    ),
    portCase(
      "disabled explicit reservation",
      {
        dormant: { ...account(native({ httpPort: 8181 })), enabled: false },
        work: account(native({ httpPort: 8181 })),
      },
      "work",
      8181,
    ),
    portCase(
      "unconfigured placeholder",
      { placeholder: { enabled: false }, work: account() },
      "work",
      8080,
    ),
    portCase(
      "bind and connection reservations",
      {
        proxy: account(native({ url: "http://localhost:8080", httpPort: 8181 })),
        work: account(),
      },
      "work",
      8081,
    ),
    {
      name: "connection URL follows allocated bind",
      signal: {
        transport: native({ httpPort: 8080 }),
        accounts: { work: account(native({ url: "http://127.0.0.1:8080", httpHost: "0.0.0.0" })) },
      },
      checks: [
        {
          accountId: "work",
          expected: {
            kind: "managed-native",
            baseUrl: "http://127.0.0.1:8081",
            httpHost: "0.0.0.0",
            httpPort: 8081,
          },
        },
      ],
    },
  ])("resolves $name", ({ signal, checks }) => {
    for (const { accountId, expected, exact } of checks) {
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

  it.each<{ name: string; signal: SignalConfig; accountId?: string; message: string }>([
    {
      name: "duplicate enabled sockets",
      signal: {
        transport: native({ socketPath }),
        accounts: { work: { transport: native({ socketPath }) } },
      },
      message: "distinct socket path",
    },
    {
      name: "socket with HTTP options",
      signal: { transport: native({ socketPath, httpPort: 8080 }) },
      message: "cannot be combined",
    },
    {
      name: "duplicate explicit ports",
      signal: {
        accounts: {
          personal: account(native({ httpPort: 8181 })),
          work: account(native({ httpPort: 8181 })),
        },
      },
      accountId: "work",
      message: 'Signal managed native accounts "work" and "personal" both bind port 8181.',
    },
    {
      name: "local external endpoint collision",
      signal: {
        accounts: {
          proxy: { account: phone, transport: { kind: "container", url: "http://localhost:8181" } },
          work: account(native({ httpPort: 8181 })),
        },
      },
      accountId: "work",
      message:
        'Signal managed native account "work" binds port 8181, which conflicts with account "proxy" local transport endpoint.',
    },
    {
      name: "own independent local endpoint collision",
      signal: {
        account: phone,
        transport: native({ url: "https://127.0.0.1:8181", httpPort: 8181 }),
      },
      message:
        'Signal managed native account "default" binds port 8181, which conflicts with its local transport endpoint.',
    },
  ])("rejects $name", ({ signal, accountId, message }) => {
    expect(() => resolveSignalAccount({ cfg: config(signal), accountId })).toThrow(message);
  });

  it.each<{
    name: string;
    signal: SignalConfig;
    ids: string[];
    accountId: string;
    configured: boolean;
    expectedAccount?: string;
    explicitDefaultConfigured?: boolean;
  }>([
    {
      name: "top-level account",
      signal: { account: phone, accounts: { work: { enabled: false } } },
      ids: ["default", "work"],
      accountId: "default",
      configured: true,
      expectedAccount: phone,
    },
    {
      name: "case-preserving default",
      signal: {
        transport: { kind: "container", url: "http://signal-container:8080" },
        accounts: { Default: { account: phone } },
      },
      ids: ["default"],
      accountId: "default",
      configured: true,
      expectedAccount: phone,
    },
    {
      name: "UUID with a named account",
      signal: {
        accountUuid: "123e4567-e89b-12d3-a456-426614174000",
        accounts: { work: { account: phone } },
      },
      ids: ["work"],
      accountId: "work",
      configured: true,
      explicitDefaultConfigured: false,
    },
  ])(
    "selects the $name",
    ({ signal, ids, accountId, configured, expectedAccount, explicitDefaultConfigured }) => {
      const cfg = config(signal);
      expect(listSignalAccountIds(cfg)).toEqual(ids);
      expect(resolveDefaultSignalAccountId(cfg)).toBe(accountId);
      expect(resolveSignalAccount({ cfg })).toMatchObject({ accountId, configured });
      if (expectedAccount) {
        expect(resolveSignalAccount({ cfg }).config.account).toBe(expectedAccount);
      }
      if (explicitDefaultConfigured !== undefined) {
        expect(resolveSignalAccount({ cfg, accountId: "default" }).configured).toBe(
          explicitDefaultConfigured,
        );
      }
    },
  );

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSignalAccount({
      cfg: config({
        defaultAccount: "work",
        accounts: {
          work: {
            name: "Work",
            account: phone,
            transport: { kind: "external-native", url: "http://127.0.0.1:9999" },
          },
        },
      }),
    });
    expect(resolved).toMatchObject({
      accountId: "work",
      name: "Work",
      baseUrl: "http://127.0.0.1:9999",
      configured: true,
    });
    expect(resolved.transport).toEqual({
      kind: "external-native",
      baseUrl: "http://127.0.0.1:9999",
    });
    expect(resolved.config.account).toBe(phone);
  });
});

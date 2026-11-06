import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import { createSignalCliPathTextInput, signalSetupAdapter } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";
import {
  prepareSignalManagedNativeTransport,
  probeSignalTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";
import { detectSignalTransport as detectTransport } from "./transport-detection.js";

type Signal = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;
function signalConfig(signal: Signal): OpenClawConfig {
  return { channels: { signal } };
}

type SetupInput = Parameters<NonNullable<typeof signalSetupAdapter.applyAccountConfig>>[0]["input"];
function apply(input: SetupInput, cfg: OpenClawConfig = {}, accountId = "default") {
  return signalSetupAdapter.applyAccountConfig?.({ cfg, accountId, input })?.channels?.signal;
}
function validate(input: SetupInput, cfg: OpenClawConfig = {}, accountId = "work") {
  return signalSetupAdapter.validateInput?.({ cfg, accountId, input });
}

const phone = "+15555550123";
const url = "http://signal:8080";
const container = (endpoint: string) => ({ kind: "container", url: endpoint }) as const;
const externalConfig = (kind: "container" | "external-native" = "container") =>
  signalConfig({ account: "+15555550124", transport: { kind, url } });
const invalidPhone =
  "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)";
function workTransport(transport?: Transport) {
  return named({ work: account(transport, workPhone) });
}

type Transport = Parameters<typeof writeSignalAccountTransport>[0]["transport"];
const native = (options: Omit<Extract<Transport, { kind: "managed-native" }>, "kind"> = {}) =>
  ({ kind: "managed-native", ...options }) as const;
const external = (endpoint: string) => ({ kind: "external-native", url: endpoint }) as const;
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
const workPhone = "+15555550124";
const bound = (httpPort: number) => account(native({ httpPort }));
const named = (accounts: Signal["accounts"]) => signalConfig({ accounts });
const root = (transport: Transport) => signalConfig({ transport });
const splitConfig = signalConfig({
  ...bound(8080),
  accounts: { work: account(undefined, workPhone) },
});
const local = (port = 8080) => `http://127.0.0.1:${port}`;
const prepared = (httpPort: number, httpHost = "127.0.0.1", endpoint = local(httpPort)) =>
  native({ url: endpoint, httpHost, httpPort });
const updateWork = (input: SetupInput, transport?: Transport) =>
  apply(input, transport ? workTransport(transport) : {}, "work")?.accounts?.work?.transport;

const detectSignalTransportMock = vi.hoisted(() => vi.fn());

vi.mock("./setup-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-transport.js")>();
  return { ...actual, detectSignalTransport: detectSignalTransportMock };
});

async function prepareInput(input: SetupInput, cfg: OpenClawConfig = {}) {
  const inputWithTransport = await signalSetupAdapter.prepareAccountConfigInput?.({
    cfg,
    accountId: "default",
    input,
    runtime: {} as never,
  });
  if (!inputWithTransport) {
    throw new Error("expected prepared Signal setup input");
  }
  return inputWithTransport;
}

beforeEach(() => {
  detectSignalTransportMock.mockReset();
});

it("uses setup-time container detection for a bare HTTP URL", async () => {
  detectSignalTransportMock.mockResolvedValue(container(url));
  const input = await prepareInput({ signalNumber: " +1 (555) 555-0123 ", httpUrl: url });
  const next = apply(input);
  expect(detectSignalTransportMock).toHaveBeenCalledWith({ url, account: phone });
  expect(next?.account).toBe(phone);
  expect(next?.transport).toEqual(container(url));
});

it("requires an explicit kind when bare HTTP URL detection is unreachable", async () => {
  detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
  await expect(prepareInput({ httpUrl: "http://signal:8080" })).rejects.toThrow(
    "Signal could not detect the HTTP transport; start the endpoint or pass --signal-transport external-native|container.",
  );
});

it("preserves an existing container account when detection is unreachable", async () => {
  detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
  const cfg = signalConfig({ account: phone, transport: container("http://signal-old:8080") });
  const input = await prepareInput({ httpUrl: "http://signal-new:8080" }, cfg);
  const next = apply(input, cfg);
  expect(input.signalTransport).toBeUndefined();
  expect(next?.transport).toEqual(container("http://signal-new:8080"));
});

it("skips setup-time detection for an explicit transport kind", async () => {
  const input = await prepareInput({
    signalNumber: "+15555550123",
    signalTransport: "container",
    httpUrl: "http://signal:8080",
  });
  expect(input.signalTransport).toBe("container");
  expect(detectSignalTransportMock).not.toHaveBeenCalled();
});

const managed = native({
  cliPath: "/old",
  configPath: "/state",
  httpHost: "127.0.0.2",
  httpPort: 8181,
  receiveMode: "manual",
  ignoreStories: true,
});
it.each<[SetupInput, Transport | undefined, Transport]>([
  [
    { httpHost: "::1", httpPort: "8282" },
    prepared(8181),
    prepared(8282, "::1", "http://[::1]:8282"),
  ],
  [{ cliPath: "/new" }, managed, { ...managed, cliPath: "/new" }],
  [
    { signalNumber: workPhone, httpUrl: "signal-native:8080" },
    undefined,
    external("http://signal-native:8080"),
  ],
])("applies transport update %j", (input, previous, expected) => {
  expect(updateWork(input, previous)).toEqual(expected);
});

it("makes a new default transport update authoritative over accounts.default", () => {
  const cfg = named({ default: account(external("http://old-signal:8080"), workPhone) });
  const next = apply({ cliPath: "/opt/new-signal-cli" }, cfg);
  expect(next?.transport).toEqual(
    native({ cliPath: "/opt/new-signal-cli", httpHost: "127.0.0.1", httpPort: 8080 }),
  );
  expect(next?.accounts?.default).not.toHaveProperty("transport");
});

it.each([
  [{ signalNumber: "+1+2345" }, invalidPhone],
  [{ signalNumber: "+1234567890123456" }, invalidPhone],
  [{ httpPort: "65536" }, "Signal --http-port must be an integer between 1 and 65535."],
  [{ httpHost: "[::1" }, "Signal --http-host must be a hostname or IP address."],
  [{ signalTransport: "container" }, "Signal --signal-transport requires --http-url."],
  [
    { httpUrl: "http://signal-container:8080", signalTransport: "container" },
    "Signal container transport requires --signal-number or an existing account.",
  ],
] as const)("rejects invalid setup input %j", (input, error) => {
  expect(validate(input)).toBe(error);
});

it("rejects an invalid replacement without overwriting an existing container account", () => {
  const cfg = signalConfig(account(container(url)));
  const input = { signalNumber: "abc", signalTransport: "container" as const, httpUrl: url };
  expect(validate(input, cfg, "default")).toBe(invalidPhone);
  expect(apply(input, cfg)?.account).toBe(phone);
});

it("allows a container transport to reuse the configured Signal account", () => {
  expect(validate({ httpUrl: url, signalTransport: "container" }, workTransport())).toBeNull();
});

it("does not materialize a CLI path for an external transport", async () => {
  const input = createSignalCliPathTextInput(async () => false);
  const context = { cfg: externalConfig(), accountId: "default", credentialValues: {} };
  expect(await input.currentValue?.(context)).toBeUndefined();
  const wizardInput = signalSetupWizard.textInputs?.find((entry) => entry.inputKey === "cliPath");
  expect(await wizardInput?.shouldPrompt?.(context)).toBe(false);
});

it("reports an external transport as configured without checking signal-cli", async () => {
  const cfg = externalConfig("external-native");
  const { status } = signalSetupWizard;
  const configured = await status.resolveConfigured({ cfg, accountId: "default" });
  const params = { cfg, accountId: "default", configured };
  await expect(status.resolveStatusLines?.(params)).resolves.toEqual(["Signal: configured"]);
  await expect(status.resolveSelectionHint?.(params)).resolves.toBe("configured");
  await expect(status.resolveQuickstartScore?.(params)).resolves.toBe(1);
});

it("preserves sockets and does not reserve HTTP ports during setup", () => {
  const transport = native({ socketPath: "/tmp/signal-private/daemon.sock" });
  const cfg = root(transport);
  expect(prepare(cfg, "default")).toEqual(transport);
  expect(prepare(cfg).httpPort).toBe(8080);
  expect(write(cfg, external(local()), "http").channels?.signal?.accounts?.http?.transport).toEqual(
    external(local()),
  );
});

it.each([
  [true, true, external(url)],
  [false, true, container(url)],
  [false, false, undefined],
] as const)("detects native=%s container=%s", async (nativeOk, containerOk, expected) => {
  const probeNative = vi.fn().mockResolvedValue({ ok: nativeOk });
  const probeContainer = vi.fn().mockResolvedValue({ ok: containerOk });
  const result = detectTransport({ url: `${url}/`, account: phone, probeNative, probeContainer });
  if (expected) {
    await expect(result).resolves.toEqual(expected);
  } else {
    await expect(result).rejects.toThrow("Signal transport not reachable at http://signal:8080");
  }
  expect(probeContainer).toHaveBeenCalledWith(url, 10_000, phone);
});

it("rejects an explicitly requested port owned by another account", () => {
  expect(() => prepare(splitConfig, "work", { httpPort: 8080 })).toThrow(
    "Signal managed native port 8080 is already reserved",
  );
});

it("keeps sibling implicit allocation stable while updating an existing target", () => {
  const cfg = named({ a: bound(8080), b: account(native(), workPhone) });
  const transport = prepare(cfg, "a", { cliPath: "/opt/signal-cli" });
  const next = write(cfg, transport, "a");

  expect(transport.httpPort).toBe(8080);
  expect(resolveSignalAccount({ cfg: next, accountId: "b" }).transport).toMatchObject({
    httpPort: 8081,
  });
});

it.each([
  [
    "aligned connection",
    signalConfig({
      ...bound(8080),
      accounts: {
        work: account(native({ url: local(), httpHost: "0.0.0.0" }), workPhone),
      },
    }),
    "work",
    undefined,
    prepared(8081, "0.0.0.0"),
  ],
  [
    "independent HTTPS proxy",
    root(native({ url: "https://127.0.0.1:8080" })),
    "default",
    undefined,
    prepared(8081, "127.0.0.1", "https://127.0.0.1:8080"),
  ],
  [
    "IPv6 wildcard",
    root(prepared(8080)),
    "default",
    { httpHost: "::" },
    prepared(8080, "::", "http://[::1]:8080"),
  ],
] as const)("prepares %s", (_name, cfg, id, overrides, expected) => {
  expect(prepare(cfg, id, overrides)).toEqual(expected);
});
it.each([
  ["loopback alias", external("http://localhost.:8080")],
  ["bind and connection ports", native({ url: "http://localhost:8080", httpPort: 8181 })],
] as const)("reserves %s", (_name, transport) => {
  expect(
    prepare(named({ proxy: account(transport), work: account(undefined, workPhone) })).httpPort,
  ).toBe(8081);
});

it("rejects invalid preferred ports", () => {
  expect(() => prepare({}, "work", { httpPort: 65_536 })).toThrow(
    "Signal managed native port must be an integer between 1 and 65535.",
  );
});

it("probes only the configured concrete transport", async () => {
  const probeNative = vi.fn().mockResolvedValue({ ok: true });
  const probeContainer = vi.fn().mockResolvedValue({ ok: true });

  await expect(
    probeSignalTransport({
      cfg: {},
      accountId: "default",
      transport: container(url),
      account: phone,
      probeNative,
      probeContainer,
    }),
  ).resolves.toEqual({ ok: true });
  expect(probeNative).not.toHaveBeenCalled();
  expect(probeContainer).toHaveBeenCalledWith(url, 10_000, phone);
});

it("probes the allocated port for an implicit managed account transport", async () => {
  const probeNative = vi.fn().mockResolvedValue({ ok: true });
  await expect(
    probeSignalTransport({
      cfg: splitConfig,
      accountId: "work",
      transport: native(),
      probeNative,
    }),
  ).resolves.toEqual({ ok: true });
  expect(probeNative).toHaveBeenCalledWith("http://127.0.0.1:8081", 10_000);
});

it("ignores the unconfigured implicit default account during endpoint collision checks", () => {
  const next = write({}, external("http://localhost:8080"));

  expect(next.channels?.signal?.accounts?.work?.transport).toEqual(
    external("http://localhost:8080"),
  );
});

it.each<[Transport, string, OpenClawConfig?, string?]>([
  [external("ftp://signal.example"), "Signal transport URL unsupported protocol: ftp:"],
  [external("http:/localhost:8080"), "Signal transport URL has a malformed HTTP scheme"],
  [native({ httpHost: "bad host" }), "Signal transport host must be a hostname or IP address"],
  [
    native({ httpHost: "localhost:8181" }),
    "Signal transport host must be a hostname or IP address",
  ],
  [
    external("http://localhost:8181"),
    'Signal external-native account "work" uses local port 8181, which conflicts with managed native account "default".',
    signalConfig({ enabled: false, ...account(native({ httpPort: 8181 })) }),
    "work",
  ],
  [
    container("http://container:8080"),
    "Signal container transport requires an account number for an enabled account.",
    {},
    "work",
  ],
  [
    native({ httpPort: 8181 }),
    'Signal managed native account "managed" binds port 8181, which conflicts with account "external" local transport endpoint.',
    signalConfig({
      account: phone,
      accounts: { external: { transport: external("http://localhost:8181") } },
    }),
    "managed",
  ],
])("rejects invalid transport %j", (transport, error, cfg = {}, id = "default") => {
  expect(() => write(cfg, transport, id)).toThrow(error);
});

it("allows a local external endpoint on a disabled sibling managed bind", () => {
  const cfg = signalConfig({
    account: workPhone,
    accounts: { dormant: { enabled: false, ...bound(8181) } },
  });
  const transport = container("http://localhost:8181");
  expect(write(cfg, transport).channels?.signal?.accounts?.work?.transport).toEqual(transport);
});

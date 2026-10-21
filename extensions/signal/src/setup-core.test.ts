import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalCliPathTextInput, signalSetupAdapter } from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

function signalConfig(signal: NonNullable<OpenClawConfig["channels"]>["signal"]): OpenClawConfig {
  return { channels: { signal } };
}

type SetupInput = Parameters<NonNullable<typeof signalSetupAdapter.applyAccountConfig>>[0]["input"];
function apply(input: SetupInput, cfg: OpenClawConfig = {}, accountId = "default") {
  return signalSetupAdapter.applyAccountConfig?.({ cfg, accountId, input })?.channels?.signal;
}
function validate(input: SetupInput, cfg: OpenClawConfig = {}, accountId = "work") {
  return signalSetupAdapter.validateInput?.({ cfg, accountId, input });
}

type SignalConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["signal"]>;
function workTransport(transport: SignalConfig["transport"]) {
  return signalConfig({ accounts: { work: { account: "+15555550124", transport } } });
}

const detectSignalTransportMock = vi.hoisted(() => vi.fn());

vi.mock("./setup-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-transport.js")>();
  return { ...actual, detectSignalTransport: detectSignalTransportMock };
});

async function prepareInput(input: SetupInput, cfg: OpenClawConfig = {}) {
  const prepared = await signalSetupAdapter.prepareAccountConfigInput?.({
    cfg,
    accountId: "default",
    input,
    runtime: {} as never,
  });
  if (!prepared) {
    throw new Error("expected prepared Signal setup input");
  }
  return prepared;
}

describe("signalSetupAdapter", () => {
  beforeEach(() => {
    detectSignalTransportMock.mockReset();
  });

  it("uses setup-time container detection for a bare HTTP URL", async () => {
    detectSignalTransportMock.mockResolvedValue({ kind: "container", url: "http://signal:8080" });
    const input = await prepareInput({
      signalNumber: "+15555550123",
      httpUrl: "http://signal:8080",
    });
    const next = apply(input);
    expect(detectSignalTransportMock).toHaveBeenCalledWith({
      url: "http://signal:8080",
      account: "+15555550123",
    });
    expect(next?.transport).toEqual({ kind: "container", url: "http://signal:8080" });
  });

  it("requires an explicit kind when bare HTTP URL detection is unreachable", async () => {
    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
    await expect(prepareInput({ httpUrl: "http://signal:8080" })).rejects.toThrow(
      "Signal could not detect the HTTP transport; start the endpoint or pass --signal-transport external-native|container.",
    );
  });

  it("preserves an existing container account when detection is unreachable", async () => {
    detectSignalTransportMock.mockRejectedValue(new Error("unreachable"));
    const cfg: OpenClawConfig = signalConfig({
      account: "+15555550123",
      transport: { kind: "container", url: "http://signal-old:8080" },
    });
    const input = await prepareInput({ httpUrl: "http://signal-new:8080" }, cfg);
    const next = apply(input, cfg);
    expect(input.signalTransport).toBeUndefined();
    expect(next?.transport).toEqual({ kind: "container", url: "http://signal-new:8080" });
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

  it("stores the canonical Signal number for the default account", () => {
    expect(apply({ signalNumber: " +1 (555) 555-0123 " })?.account).toBe("+15555550123");
  });

  it("keeps promoted default-account policy scoped to that account", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: signalConfig({
        dmPolicy: "pairing",
        transport: { kind: "managed-native", httpPort: 8080 },
        accounts: {
          default: { account: "+15555550123", dmPolicy: "disabled", allowFrom: ["+15555550125"] },
        },
      }),
      accountId: "work",
      input: { signalNumber: "+15555550124" },
    })?.channels?.signal;
    expect(next).toMatchObject({ account: "+15555550123", dmPolicy: "pairing" });
    expect(next?.allowFrom).toBeUndefined();
    expect(next?.accounts?.default).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: ["+15555550125"],
    });
    expect(next?.accounts?.default).not.toHaveProperty("account");
  });

  it("realigns an existing managed connection URL after a partial bind update", () => {
    const cfg = workTransport({
      kind: "managed-native",
      url: "http://127.0.0.1:8181",
      httpHost: "127.0.0.1",
      httpPort: 8181,
    });
    const next = apply({ httpHost: "127.0.0.2", httpPort: "8282" }, cfg, "work");
    expect(next?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.2:8282",
      httpHost: "127.0.0.2",
      httpPort: 8282,
    });
  });

  it("preserves managed transport options during a partial setup update", () => {
    const transport = {
      kind: "managed-native",
      cliPath: "/opt/old-signal-cli",
      configPath: "/var/lib/signal-work",
      httpHost: "127.0.0.2",
      httpPort: 8181,
      receiveMode: "manual",
      ignoreStories: true,
    } satisfies SignalConfig["transport"];
    const cfg = workTransport(transport);
    const next = apply({ cliPath: "/opt/new-signal-cli" }, cfg, "work");
    expect(next?.accounts?.work?.transport).toEqual({
      ...transport,
      cliPath: "/opt/new-signal-cli",
    });
  });

  it("makes a new default transport update authoritative over accounts.default", () => {
    const cfg: OpenClawConfig = signalConfig({
      accounts: {
        default: {
          account: "+15555550124",
          transport: { kind: "external-native", url: "http://old-signal:8080" },
        },
      },
    });
    const next = apply({ cliPath: "/opt/new-signal-cli" }, cfg);
    expect(next?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    expect(next?.accounts?.default).not.toHaveProperty("transport");
  });

  it("keeps bare HTTP URLs on the historical external-native transport", () => {
    const next = apply({ signalNumber: "+15555550124", httpUrl: "signal-native:8080" }, {}, "work");
    expect(next?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-native:8080",
    });
  });

  it.each([
    [
      { signalNumber: "+1+2345" },
      "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)",
    ],
    [
      { signalNumber: "+1234567890123456" },
      "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)",
    ],
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
    const cfg: OpenClawConfig = signalConfig({
      account: "+15555550123",
      transport: { kind: "container", url: "http://signal-container:8080" },
    });
    const input = {
      signalNumber: "abc",
      signalTransport: "container" as const,
      httpUrl: "http://signal-container:8080",
    };
    expect(validate(input, cfg, "default")).toBe(
      "Invalid E.164 phone number (must start with + and country code, e.g. +15555550123)",
    );
    expect(apply(input, cfg)?.account).toBe("+15555550123");
  });

  it("allows a container transport to reuse the configured Signal account", () => {
    expect(
      validate(
        { httpUrl: "http://signal-container:8080", signalTransport: "container" },
        signalConfig({ accounts: { work: { account: "+15555550124" } } }),
      ),
    ).toBeNull();
  });

  it("does not materialize a CLI path for an external transport", async () => {
    const input = createSignalCliPathTextInput(async () => false);
    const cfg: OpenClawConfig = signalConfig({
      account: "+15555550124",
      transport: { kind: "container", url: "http://signal:8080" },
    });
    const context = { cfg, accountId: "default", credentialValues: {} };
    expect(await input.currentValue?.(context)).toBeUndefined();
    const wizardInput = signalSetupWizard.textInputs?.find((entry) => entry.inputKey === "cliPath");
    expect(await wizardInput?.shouldPrompt?.(context)).toBe(false);
  });

  it("reports an external transport as configured without checking signal-cli", async () => {
    const cfg: OpenClawConfig = signalConfig({
      account: "+15555550124",
      transport: { kind: "external-native", url: "http://signal:8080" },
    });
    const { status } = signalSetupWizard;
    const configured = await status.resolveConfigured({ cfg, accountId: "default" });
    const params = { cfg, accountId: "default", configured };
    await expect(status.resolveStatusLines?.(params)).resolves.toEqual(["Signal: configured"]);
    await expect(status.resolveSelectionHint?.(params)).resolves.toBe("configured");
    await expect(status.resolveQuickstartScore?.(params)).resolves.toBe(1);
  });
});

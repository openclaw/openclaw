// Signal tests cover config schema plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalConfigSchema } from "../config-api.js";

function expectValidSignalConfig(config: unknown) {
  const res = SignalConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectInvalidSignalConfig(config: unknown) {
  const res = SignalConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected Signal config to be invalid");
  }
  return res.error.issues;
}

describe("signal groups schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidSignalConfig({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    const issues = expectInvalidSignalConfig({ dmPolicy: "allowlist" });
    expect(issues.some((issue) => issue.path.includes("allowFrom"))).toBe(true);
  });

  it("rejects a named container transport without an inherited or owned account", () => {
    const issues = expectInvalidSignalConfig({
      accounts: {
        work: {
          transport: {
            kind: "container",
            url: "http://signal-container:8080",
          },
        },
      },
    });

    expect(issues.map((issue) => issue.path.join("."))).toContain("accounts.work.account");
  });

  it("allows disabled account-less container transports", () => {
    expectValidSignalConfig({
      enabled: false,
      transport: {
        kind: "container",
        url: "http://signal-container:8080",
      },
    });
    expectValidSignalConfig({
      accounts: {
        work: {
          enabled: false,
          transport: {
            kind: "container",
            url: "http://signal-container:8080",
          },
        },
      },
    });
  });

  it("accepts a default-account number stored beside a root container transport", () => {
    expectValidSignalConfig({
      transport: {
        kind: "container",
        url: "http://signal-container:8080",
      },
      accounts: {
        Default: {
          account: "+15555550123",
        },
      },
    });
  });

  it.each([
    { socketPath: "/tmp/../signal.sock" },
    { socketPath: `/tmp/${"a".repeat(100)}.sock` },
    { socketPath: "/tmp/signal.sock", url: "http://127.0.0.1:8080" },
    { socketPath: "/tmp/signal.sock", httpHost: "127.0.0.1" },
    { socketPath: "/tmp/signal.sock", httpPort: 8080 },
    { socketPath: "/tmp/signal.sock", receiveMode: "on-start" },
  ])("rejects invalid or ambiguous socket transport %j", (options) => {
    expectInvalidSignalConfig({ transport: { kind: "managed-native", ...options } });
  });

  it.each(["external-native", "container"])("rejects socketPath on %s transport", (kind) => {
    expectInvalidSignalConfig({
      account: "+15555550123",
      transport: { kind, url: "http://127.0.0.1:8080", socketPath: "/tmp/signal.sock" },
    });
  });

  it("rejects managed transport ports outside the TCP range", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "managed-native",
        httpPort: 65_536,
      },
    });
  });

  it("rejects non-HTTP transport URLs", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "external-native",
        url: "ftp://signal-native:8080",
      },
    });
  });

  it("rejects transport URLs containing credentials", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "container",
        url: "http://user@signal-container:8080",
      },
    });
  });
});

describe("Signal post-core update schema", () => {
  const legacyConfig = {
    account: "+15555550123",
    apiMode: "container",
    httpUrl: "http://signal-container:8080",
    autoStart: false,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("closes the temporary schema window without reloading modules", () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    expect(SignalConfigSchema.safeParse(legacyConfig).success).toBe(true);

    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
    expect(SignalConfigSchema.safeParse(legacyConfig).success).toBe(false);
  });
});

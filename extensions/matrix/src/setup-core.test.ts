import type { ChannelSetupWizardAdapter } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import type { MatrixSetupInput } from "./setup-config.js";
import { createMatrixSetupWizardProxy, matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const opsInput = {
  name: "Ops",
  homeserver: "https://matrix.example.org",
  accessToken: "ops-token",
} satisfies MatrixSetupInput;

function applyOpsAccountConfig(cfg: CoreConfig, input: Partial<MatrixSetupInput> = {}): CoreConfig {
  return matrixSetupAdapter.applyAccountConfig({
    cfg,
    accountId: "ops",
    input: { ...opsInput, ...input },
  }) as CoreConfig;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toEqual(expect.objectContaining(expected));
}

const credentials = {
  homeserver: "https://matrix.example.org",
  userId: "@default:example.org",
  accessToken: "tok-default",
};
const withMatrix = (matrix: NonNullable<CoreConfig["channels"]>["matrix"]): CoreConfig => ({
  channels: { matrix },
});
const withDm = (dm: { policy?: "open"; allowFrom: string[] }) =>
  withMatrix({ accounts: { ops: { dm } } });

function setupProxy(overrides: Partial<ChannelSetupWizardAdapter> = {}) {
  const matrixSetupWizard: ChannelSetupWizardAdapter = {
    channel: "matrix",
    getStatus: vi.fn(async () => ({
      channel: "matrix",
      configured: false,
      statusLines: [],
    })),
    configure: vi.fn(async ({ cfg }) => ({ cfg })),
    ...overrides,
  };
  const loader = vi.fn(async () => ({ matrixSetupWizard }));
  return { loader, proxy: createMatrixSetupWizardProxy(loader) };
}

describe("createMatrixSetupWizardProxy", () => {
  it("loads the setup surface when setup status is requested", async () => {
    const status = {
      channel: "matrix" as const,
      configured: true,
      statusLines: ["Matrix: configured"],
    };
    const getStatus = vi.fn(async () => status);
    const configure = vi.fn(async ({ cfg }) => ({ cfg }));
    const { loader, proxy } = setupProxy({ configure, getStatus });
    const cfg = { channels: { matrix: {} } } as CoreConfig;

    const result = await proxy.getStatus({ cfg, accountOverrides: {} });
    const configured = await proxy.configure({
      cfg,
      runtime: {} as never,
      prompter: {} as never,
      forceAllowFrom: false,
      accountOverrides: {},
      shouldPromptAccountIds: false,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith({ cfg, accountOverrides: {} });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(result).toBe(status);
    expect(configured).toEqual({ cfg });
  });

  it("keeps sync dmPolicy helpers local and lazy-loads only promptAllowFrom", async () => {
    const promptAllowFrom = vi.fn(async ({ cfg }) => cfg);
    const { loader, proxy } = setupProxy({
      dmPolicy: {
        label: "Matrix",
        channel: "matrix",
        policyKey: "unused",
        allowFromKey: "unused",
        getCurrent: () => "pairing",
        setPolicy: (cfg) => cfg,
        promptAllowFrom,
      },
    });
    const cfg = withDm({ allowFrom: ["  @ops:example.org  ", "", "*"] });

    expect(proxy.dmPolicy?.getCurrent(cfg, "ops")).toBe("pairing");
    const next = proxy.dmPolicy?.setPolicy(cfg, "open", "ops") as CoreConfig;

    expectFields(next.channels?.matrix?.accounts?.ops?.dm, {
      policy: "open",
      allowFrom: ["@ops:example.org", "*"],
    });
    expect(loader).not.toHaveBeenCalled();

    await proxy.dmPolicy?.promptAllowFrom?.({
      cfg,
      prompter: {} as never,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(promptAllowFrom).toHaveBeenCalledTimes(1);
  });

  it("removes wildcard allowFrom when switching from open to a restrictive policy", () => {
    const { loader, proxy } = setupProxy();
    const cfg = withDm({ policy: "open", allowFrom: ["*", "  @ops:example.org  "] });

    const next = proxy.dmPolicy?.setPolicy(cfg, "allowlist", "ops") as CoreConfig;

    expectFields(next.channels?.matrix?.accounts?.ops?.dm, {
      policy: "allowlist",
      allowFrom: ["@ops:example.org"],
    });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("matrixSetupAdapter", () => {
  it("reuses an existing raw default-account key during promotion", () => {
    const cfg = withMatrix({
      ...credentials,
      defaultAccount: "default",
      avatarUrl: "mxc://example.org/default-avatar",
      accounts: { Default: { enabled: true, deviceName: "Legacy raw key" } },
    });

    const next = applyOpsAccountConfig(cfg);

    expect(next.channels?.matrix?.accounts).toMatchObject({
      Default: {
        ...credentials,
        enabled: true,
        deviceName: "Legacy raw key",
        avatarUrl: "mxc://example.org/default-avatar",
      },
      ops: { ...opsInput, enabled: true },
    });
    expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
  });

  it("rejects unsupported avatar URL schemes during setup validation", () => {
    const validationError = matrixSetupAdapter.validateInput?.({
      cfg: {} as CoreConfig,
      accountId: "ops",
      input: {
        homeserver: "https://matrix.example.org",
        accessToken: "ops-token",
        avatarUrl: "file:///tmp/avatar.png",
      } as MatrixSetupInput,
    });

    expect(validationError).toBe("Matrix avatar URL must be an mxc:// URI or an http(s) URL.");
  });

  it("stores canonical dangerous private-network opt-in from setup input", () => {
    const input: MatrixSetupInput = {
      homeserver: "http://matrix.internal:8008",
      accessToken: "ops-token",
      dangerouslyAllowPrivateNetwork: true,
    };
    const next = matrixSetupAdapter.applyAccountConfig({
      cfg: {},
      accountId: "ops",
      input,
    }) as CoreConfig;

    expectFields(next.channels?.matrix?.accounts?.ops, {
      enabled: true,
      homeserver: "http://matrix.internal:8008",
      accessToken: "ops-token",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
  });

  it("keeps top-level block streaming as a shared default when named accounts already exist", () => {
    const cfg = withMatrix({
      ...credentials,
      streaming: { block: { enabled: true } },
      accounts: {
        support: { ...credentials, userId: "@support:example.org", accessToken: "tok-support" },
      },
    });
    const next = applyOpsAccountConfig(cfg, { userId: "@ops:example.org" });

    expect(next.channels?.matrix?.streaming).toEqual({ block: { enabled: true } });
    expectFields(next.channels?.matrix?.accounts?.ops, {
      ...opsInput,
      enabled: true,
      userId: "@ops:example.org",
    });
    expect(next.channels?.matrix?.accounts?.ops?.streaming).toBeUndefined();
  });
});

import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  createClient: vi.fn(),
  me: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>();
  return { ...actual, callGatewayFromCli: mocks.callGatewayFromCli };
});

// mock-isolation: Exercise setup diagnostics without creating a real HTTP client.
vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    mocks.createClient(options);
    return { me: mocks.me, workspaces: mocks.workspaces };
  },
}));

import { verifyClickClackAccountAfterSetup } from "./setup-verify.js";
import type { ClickClackAccountConfig } from "./types.js";

const configuredAccount: ClickClackAccountConfig = {
  baseUrl: "https://clickclack.example",
  apiBaseUrl: "http://127.0.0.1:8484",
  token: "ccb_test",
  workspace: "default",
};
const runningMessage = "OpenClaw is running — ClickClack will connect automatically.";
const workspace = { id: "wsp_default", name: "clickclack", slug: "default" };
function expectLogs(runtime: ReturnType<typeof createNonExitingRuntimeEnv>, message: string) {
  expect(vi.mocked(runtime.log).mock.calls).toEqual([[message], [runningMessage]]);
}

async function verify(
  account: ClickClackAccountConfig = configuredAccount,
  runtime = createNonExitingRuntimeEnv(),
) {
  await verifyClickClackAccountAfterSetup({
    cfg: { channels: { clickclack: account } },
    accountId: "default",
    runtime,
  });
  return runtime;
}

describe("ClickClack post-write setup verification", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mocks.callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
    mocks.createClient.mockReset();
    mocks.me.mockReset().mockResolvedValue({ id: "usr_bot", handle: "openclaw" });
    mocks.workspaces.mockReset().mockResolvedValue([workspace]);
  });

  it.each(["default", "wsp_default", "clickclack"])(
    "prints the resolved bot and workspace for selector %s without blocking setup",
    async (selector) => {
      const runtime = await verify({ ...configuredAccount, workspace: selector });

      expect(mocks.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "http://127.0.0.1:8484" }),
      );

      expectLogs(runtime, "Connected as @openclaw — workspace clickclack resolved.");
    },
  );

  it.each([
    [
      () => mocks.me.mockRejectedValue({ status: 401 }),
      "ClickClack rejected the bot token (401). Copy a current token and rerun setup.",
    ],
    [
      () => mocks.workspaces.mockResolvedValue([]),
      'Workspace "default" was not found. Check the id, slug, or name, list available workspaces, and rerun setup.',
    ],
    [
      () => mocks.me.mockRejectedValue(new Error("network unavailable")),
      "Connection check failed: network unavailable. Setup was saved; fix the connection and rerun setup.",
    ],
  ] as const)("logs a warning and continues (%#)", async (arrange, expected) => {
    arrange();
    const runtime = createNonExitingRuntimeEnv();

    await expect(verify(configuredAccount, runtime)).resolves.toBe(runtime);
    expectLogs(runtime, expected);
  });

  it("skips client verification when the implicit env token is unavailable", async () => {
    vi.stubEnv("CLICKCLACK_BOT_TOKEN", "");
    const runtime = await verify({ ...configuredAccount, token: undefined, apiBaseUrl: undefined });

    expect(mocks.createClient).not.toHaveBeenCalled();
    expectLogs(runtime, "Token comes from CLICKCLACK_BOT_TOKEN; verification skipped.");
  });

  it.each([
    [
      "not running",
      Object.assign(new Error("gateway closed (1006): no listener"), {
        name: "GatewayTransportError",
        kind: "closed",
        code: 1006,
        connectionDetails: { url: "ws://127.0.0.1:18789", message: "Local Gateway" },
      }),
      "Start OpenClaw to connect: openclaw gateway",
    ],
    [
      "unavailable",
      new Error("probe failed"),
      "If OpenClaw is running it connects automatically; otherwise start it with: openclaw gateway",
    ],
  ] as const)("prints the gateway next step when status is %s", async (_name, error, expected) => {
    mocks.callGatewayFromCli.mockRejectedValue(error);
    const runtime = await verify();

    expect(runtime.log).toHaveBeenNthCalledWith(2, expected);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
      "health",
      { timeout: "1000", json: true },
      undefined,
      { expectFinal: false, progress: false },
    );
  });
});

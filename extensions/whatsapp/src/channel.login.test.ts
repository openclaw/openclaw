import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  loginWeb: vi.fn<typeof import("./login.js").loginWeb>(),
}));

vi.mock("./channel-runtime-loader.js", () => ({
  loadWhatsAppChannelRuntime: vi.fn(async () => runtimeMocks),
}));

import { whatsappPlugin } from "./channel.js";

function createRuntime() {
  const log = vi.fn();
  return { log, runtime: { log, error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv };
}

async function login(cfg: OpenClawConfig, accountId?: string) {
  const { log, runtime } = createRuntime();
  await whatsappPlugin.auth!.login!({ cfg, accountId, runtime, verbose: false });
  return log.mock.calls.map(([line]) => String(line)).join("\n");
}

describe("WhatsApp CLI login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.loginWeb.mockResolvedValue(undefined);
  });

  it("explains the pairing default and how to restrict a personal number", async () => {
    const output = await login({});

    expect(runtimeMocks.loginWeb).toHaveBeenCalledWith(
      false,
      undefined,
      expect.anything(),
      "default",
    );
    expect(output).toContain("default pairing policy");
    expect(output).toContain("openclaw channels add --channel whatsapp`");
  });

  it("names the account in the setup command for non-default accounts", async () => {
    const output = await login({ channels: { whatsapp: { accounts: { work: {} } } } }, "work");

    expect(output).toContain("openclaw channels add --channel whatsapp --account work");
  });

  it("stays quiet when a DM policy is configured", async () => {
    const output = await login({
      channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+15555550100"] } },
    });

    expect(output).toBe("");
  });

  it("does not print the notice when linking fails", async () => {
    runtimeMocks.loginWeb.mockRejectedValue(new Error("Session logged out"));

    await expect(login({})).rejects.toThrow("Session logged out");
  });
});

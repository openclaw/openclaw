import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
// Whatsapp plugin module tests logSelfId unhandled rejection safety.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadWhatsAppChannelRuntime = vi.hoisted(() => vi.fn());

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadWhatsAppChannelRuntime: mockLoadWhatsAppChannelRuntime,
  };
});

import { whatsappPlugin } from "./channel.js";

type LogSelfIdFn = (params: {
  account: { authDir: string; isLegacyAuthDir: boolean; name: string };
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  includeChannelPrefix?: boolean;
}) => void;

function getLogSelfId(): LogSelfIdFn | undefined {
  return (whatsappPlugin as unknown as { status?: { logSelfId?: LogSelfIdFn } })?.status?.logSelfId;
}

beforeEach(() => {
  const registry = createTestRegistry();
  setActivePluginRegistry(registry);
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("logSelfId rejects safely", () => {
  it("does not reject when loadWhatsAppChannelRuntime fails", async () => {
    const logSelfId = getLogSelfId();
    expect(logSelfId).toBeDefined();

    mockLoadWhatsAppChannelRuntime.mockRejectedValueOnce(new Error("simulated import error"));

    logSelfId!({
      account: { authDir: "/tmp/test", isLegacyAuthDir: false, name: "test" },
      runtime: { log: () => {}, error: () => {}, exit: () => {} } as RuntimeEnv,
      cfg: {} as OpenClawConfig,
      includeChannelPrefix: false,
    });

    // Flush microtasks so the .catch() processes the rejection.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Assert the mock was actually called so the test is meaningful.
    // Passing means no unhandled rejection was reported by the runner.
    expect(mockLoadWhatsAppChannelRuntime).toHaveBeenCalled();
  });
});

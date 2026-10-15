import { describe, expect, it, vi } from "vitest";
import { runQaTelegramSuite } from "./src/live-transports/telegram/cli.runtime.js";

const qaChannelLoads = vi.hoisted(() => vi.fn());
const qaChannelProtocolLoads = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/qa-channel", () => {
  qaChannelLoads();
  throw new Error("QA Lab entrypoint loaded the private QA channel");
});

vi.mock("openclaw/plugin-sdk/qa-channel-protocol", () => {
  qaChannelProtocolLoads();
  throw new Error("QA Lab entrypoint loaded the private QA channel protocol");
});

describe("QA Lab plugin entrypoint", () => {
  it.each([
    ["normal", () => import("./index.js")],
    ["Gateway fixture", () => import("./gateway-entry.js")],
  ] as const)("loads the %s entry without private QA transports", async (_name, load) => {
    const { default: plugin } = await load();

    expect(plugin.id).toBe("qa-lab");
    expect(qaChannelLoads).not.toHaveBeenCalled();
    expect(qaChannelProtocolLoads).not.toHaveBeenCalled();
  });

  it("loads the package Telegram harness without the private QA transport runtime", () => {
    expect(runQaTelegramSuite).toBeTypeOf("function");
    expect(qaChannelLoads).not.toHaveBeenCalled();
    expect(qaChannelProtocolLoads).not.toHaveBeenCalled();
  });
});

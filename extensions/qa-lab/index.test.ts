import { describe, expect, it, vi } from "vitest";

const qaChannelLoads = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/qa-channel", () => {
  qaChannelLoads();
  throw new Error("QA Lab entrypoint loaded the private QA channel");
});

describe("QA Lab plugin entrypoint", () => {
  it("loads without the private QA transport runtime", async () => {
    const { default: plugin } = await import("./index.js");

    expect(plugin.id).toBe("qa-lab");
    expect(qaChannelLoads).not.toHaveBeenCalled();
  });
});

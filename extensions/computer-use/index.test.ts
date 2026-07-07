import { describe, expect, it, vi } from "vitest";
import pluginEntry from "./index.js";

describe("computer-use plugin entry", () => {
  it("registers two node policies, the computer tool, and the computer command", () => {
    const registerNodeInvokePolicy = vi.fn();
    const registerTool = vi.fn();
    const registerCommand = vi.fn();
    const openKeyedStore = vi.fn(() => ({
      register: vi.fn(),
      lookup: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
    }));

    pluginEntry.register({
      pluginConfig: {},
      runtime: { state: { openKeyedStore } },
      registerNodeInvokePolicy,
      registerTool,
      registerCommand,
    } as never);

    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "armed", maxEntries: 256 });
    expect(registerNodeInvokePolicy).toHaveBeenCalledTimes(2);
    expect(registerNodeInvokePolicy.mock.calls.map(([policy]) => policy.commands)).toEqual([
      ["computer.status"],
      ["computer.input"],
    ]);
    expect(registerNodeInvokePolicy.mock.calls[0]?.[0]).toMatchObject({
      defaultPlatforms: ["macos"],
    });
    expect(registerNodeInvokePolicy.mock.calls[1]?.[0]).toMatchObject({ dangerous: true });
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "computer" }));
    expect(registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "computer" }));
  });
});

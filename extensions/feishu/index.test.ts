import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi } from "vitest";

const registerFeishuDocToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuChatToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuWikiToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuDriveToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuPermToolsMock = vi.hoisted(() => vi.fn());
const registerFeishuBitableToolsMock = vi.hoisted(() => vi.fn());
const setFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const registerFeishuSubagentHooksMock = vi.hoisted(() => vi.fn());

vi.mock("./src/docx.js", () => ({
  registerFeishuDocTools: registerFeishuDocToolsMock,
}));

vi.mock("./src/chat.js", () => ({
  registerFeishuChatTools: registerFeishuChatToolsMock,
}));

vi.mock("./src/wiki.js", () => ({
  registerFeishuWikiTools: registerFeishuWikiToolsMock,
}));

vi.mock("./src/drive.js", () => ({
  registerFeishuDriveTools: registerFeishuDriveToolsMock,
}));

vi.mock("./src/perm.js", () => ({
  registerFeishuPermTools: registerFeishuPermToolsMock,
}));

vi.mock("./src/bitable.js", () => ({
  registerFeishuBitableTools: registerFeishuBitableToolsMock,
}));

vi.mock("./src/runtime.js", () => ({
  setFeishuRuntime: setFeishuRuntimeMock,
}));

vi.mock("./src/subagent-hooks.js", () => ({
  registerFeishuSubagentHooks: registerFeishuSubagentHooksMock,
}));

describe("feishu plugin register", () => {
  it("registers the Feishu channel, tools, and subagent hooks", async () => {
    const { default: plugin } = await import("./index.js");
    const registerChannel = vi.fn();
    const api = {
      runtime: { log: vi.fn() },
      registerChannel,
      on: vi.fn(),
      config: {},
      registrationMode: "full",
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    expect(setFeishuRuntimeMock).toHaveBeenCalledWith(api.runtime);
    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerFeishuSubagentHooksMock).toHaveBeenCalledWith(api);
    expect(registerFeishuDocToolsMock).toHaveBeenCalledWith(api);
    expect(registerFeishuChatToolsMock).toHaveBeenCalledWith(api);
    expect(registerFeishuWikiToolsMock).toHaveBeenCalledWith(api);
    expect(registerFeishuDriveToolsMock).toHaveBeenCalledWith(api);
    expect(registerFeishuPermToolsMock).toHaveBeenCalledWith(api);
    expect(registerFeishuBitableToolsMock).toHaveBeenCalledWith(api);
  });
});

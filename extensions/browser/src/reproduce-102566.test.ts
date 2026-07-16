/**
 * 验证 #102566 的修复：browser tool 的 description 现在根据 defaultProfile
 * 配置动态决定是否建议 profile="user"。
 *
 * 运行: pnpm test extensions/browser/src/reproduce-102566.test.ts
 */
import { vi, describe, it, expect, afterEach } from "vitest";
import { createBrowserTool } from "./browser-tool.js";

// 使用与 browser-tool.test.ts 相同的 mock 方案
const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn<
    () => {
      browser: Record<string, unknown>;
    }
  >(() => ({ browser: {} })),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: configMocks.loadConfig,
  };
});

describe("Issue #102566 — 修复验证", () => {
  afterEach(() => {
    configMocks.loadConfig.mockImplementation(() => ({ browser: {} }));
  });

  it("默认配置下仍建议 profile=user（向后兼容）", () => {
    // 默认 mock 返回 { browser: {} }，没有 defaultProfile
    const tool = createBrowserTool();
    expect(tool.description).toContain('profile="user"');
  });

  it("CDP attach-only 配置后不再建议 profile=user", () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 9222, attachOnly: true },
        },
      },
    });

    const tool = createBrowserTool();
    expect(tool.description).toContain("default profile");
    expect(tool.description).not.toContain('profile="user"');
  });

  it("CDP attach-only 配置后 description 包含动态条件文本", () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "openclaw",
        profiles: {
          openclaw: { cdpPort: 9222, attachOnly: true },
        },
      },
    });

    const tool = createBrowserTool();
    expect(tool.description).toContain("configured default profile");
    expect(tool.description).toContain("CDP direct attach");
  });

  it("attachOnly=false 时仍建议 profile=user", () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {
        defaultProfile: "my-profile",
        profiles: {
          "my-profile": { cdpPort: 9222, attachOnly: false },
        },
      },
    });

    const tool = createBrowserTool();
    expect(tool.description).toContain('profile="user"');
  });
});

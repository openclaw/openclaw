import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";

describe("registerFeishuDocTools registration logging", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("logs registration only once per module load while still registering tools", async () => {
    const { registerFeishuDocTools } = await import("./docx.js");
    const registerTool = vi.fn();
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const api = {
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: {
              doc: true,
              chat: false,
              wiki: false,
              drive: false,
              perm: false,
              scopes: true,
            },
          },
        },
      },
      logger,
      registerTool,
    } as unknown as OpenClawPluginApi;

    registerFeishuDocTools(api);
    registerFeishuDocTools(api);

    expect(registerTool).toHaveBeenCalledTimes(4);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "feishu_doc: Registered feishu_doc, feishu_app_scopes",
    );
  });
});

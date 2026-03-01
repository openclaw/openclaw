import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../src/test-utils/mock-http-response.js";
import plugin from "./index.js";

describe("diffs plugin registration", () => {
  it("registers the tool, http handler, and prompt guidance hook", () => {
    const registerTool = vi.fn();
    const registerHttpHandler = vi.fn();
    const on = vi.fn();

    plugin.register?.({
      id: "diffs",
      name: "Diffs",
      description: "Diffs",
      source: "test",
      config: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool,
      registerHook() {},
      registerHttpHandler,
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      resolvePath(input: string) {
        return input;
      },
      on,
    });

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerHttpHandler).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");
  });

  it("applies plugin-config defaults through registered tool and viewer handler", async () => {
    let registeredTool:
      | { execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    let registeredHttpHandler:
      | ((
          req: IncomingMessage,
          res: ReturnType<typeof createMockServerResponse>,
        ) => Promise<boolean>)
      | undefined;

    plugin.register?.({
      id: "diffs",
      name: "Diffs",
      description: "Diffs",
      source: "test",
      config: {
        gateway: {
          port: 18789,
          bind: "loopback",
        },
      },
      pluginConfig: {
        defaults: {
          theme: "light",
          background: false,
          layout: "split",
        },
      },
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool(tool) {
        registeredTool = typeof tool === "function" ? undefined : tool;
      },
      registerHook() {},
      registerHttpHandler(handler) {
        registeredHttpHandler = handler as typeof registeredHttpHandler;
      },
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      resolvePath(input: string) {
        return input;
      },
      on() {},
    });

    const result = await registeredTool?.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
    });
    const viewerPath = String(
      (result as { details?: Record<string, unknown> } | undefined)?.details?.viewerPath,
    );
    const res = createMockServerResponse();
    const handled = await registeredHttpHandler?.(
      {
        method: "GET",
        url: viewerPath,
      } as IncomingMessage,
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('body data-theme="light"');
    expect(String(res.body)).toContain('"backgroundEnabled":false');
    expect(String(res.body)).toContain('"diffStyle":"split"');
  });
});

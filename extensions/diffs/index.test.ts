import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../test/helpers/extensions/mock-http-response.js";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

describe("diffs plugin registration", () => {
  it("registers the tool, http route, and system-prompt guidance hook", async () => {
    const registerTool = vi.fn();
    const registerHttpRoute = vi.fn();
    const on = vi.fn();

    plugin.register?.(
      createTestPluginApi({
        id: "diffs",
        name: "Diffs",
        description: "Diffs",
        source: "test",
        config: {},
        runtime: {} as never,
        registerTool,
        registerHttpRoute,
        on,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0]?.[0]).toMatchObject({
      path: "/plugins/diffs",
      auth: "plugin",
      match: "prefix",
    });
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("before_prompt_build");
    const beforePromptBuild = on.mock.calls[0]?.[1];
    const result = await beforePromptBuild?.({}, {});
    expect(result).toMatchObject({
      prependSystemContext: expect.stringContaining("prefer the `diffs` tool"),
    });
    expect(result?.prependContext).toBeUndefined();
  });

  it("applies plugin-config defaults through registered tool and viewer handler", async () => {
    type RegisteredTool = {
      execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    type RegisteredHttpRouteParams = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

    let registeredTool: RegisteredTool | undefined;
    let registeredHttpRouteHandler: RegisteredHttpRouteParams["handler"] | undefined;

    const api = createTestPluginApi({
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
          mode: "view",
          theme: "light",
          background: false,
          layout: "split",
          showLineNumbers: false,
          diffIndicators: "classic",
          lineSpacing: 2,
        },
      },
      runtime: {} as never,
      registerTool(tool: Parameters<OpenClawPluginApi["registerTool"]>[0]) {
        registeredTool = typeof tool === "function" ? undefined : tool;
      },
      registerHttpRoute(params: RegisteredHttpRouteParams) {
        registeredHttpRouteHandler = params.handler;
      },
    });

    plugin.register?.(api as unknown as OpenClawPluginApi);

    const result = await registeredTool?.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
    });
    const viewerPath = String(
      (result as { details?: Record<string, unknown> } | undefined)?.details?.viewerPath,
    );
    const res = createMockServerResponse();
    const handled = await registeredHttpRouteHandler?.(
      localReq({
        method: "GET",
        url: viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('body data-theme="light"');
    expect(String(res.body)).toContain('"backgroundEnabled":false');
    expect(String(res.body)).toContain('"diffStyle":"split"');
    expect(String(res.body)).toContain('"disableLineNumbers":true');
    expect(String(res.body)).toContain('"diffIndicators":"classic"');
    expect(String(res.body)).toContain("--diffs-line-height: 30px;");
  });
});

function localReq(input: {
  method: string;
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

// Tokenjuice tests cover index plugin behavior.
import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tokenjuiceFactory, createTokenjuiceOpenClawEmbeddedExtension } = vi.hoisted(() => {
  const tokenjuiceFactoryLocal = vi.fn();
  const createTokenjuiceOpenClawEmbeddedExtensionLocal = vi.fn(() => tokenjuiceFactoryLocal);
  return {
    tokenjuiceFactory: tokenjuiceFactoryLocal,
    createTokenjuiceOpenClawEmbeddedExtension: createTokenjuiceOpenClawEmbeddedExtensionLocal,
  };
});

vi.mock("./runtime-api.js", () => ({
  createTokenjuiceOpenClawEmbeddedExtension,
}));

import plugin from "./index.js";
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

describe("tokenjuice plugin", () => {
  beforeEach(() => {
    createTokenjuiceOpenClawEmbeddedExtension.mockClear();
    tokenjuiceFactory.mockClear();
  });

  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers tokenjuice tool result middleware for OpenClaw and Codex runtimes", () => {
    const registerAgentToolResultMiddleware = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "tokenjuice",
        name: "tokenjuice",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentToolResultMiddleware,
      }),
    );

    expect(createTokenjuiceOpenClawEmbeddedExtension).toHaveBeenCalledTimes(1);
    expect(tokenjuiceFactory).toHaveBeenCalledTimes(1);
    const registration = registerAgentToolResultMiddleware.mock.calls[0];
    expect(typeof registration?.[0]).toBe("function");
    expect(registration?.[1]).toEqual({ runtimes: ["openclaw", "codex"] });
  });

  it("normalises bash results without details before passing them to tokenjuice", async () => {
    let received:
      | {
          toolName: string;
          input: Record<string, unknown>;
          content: unknown;
          details: unknown;
          isError?: boolean;
        }
      | undefined;
    tokenjuiceFactory.mockImplementationOnce(
      (api: { on: (event: string, handler: unknown) => void }) => {
        api.on("tool_result", async (event: typeof received) => {
          received = event;
          return { content: [{ type: "text", text: "compacted" }] };
        });
      },
    );

    const middleware = createTokenjuiceAgentToolResultMiddleware();
    const result = await middleware(
      {
        toolCallId: "tool-call-tokenjuice-bash",
        toolName: "bash",
        args: { command: "printf 'hello\\n'", workdir: "/tmp/openclaw-tokenjuice-test" },
        result: { content: [{ type: "text", text: "hello\n" }], details: undefined },
        isError: false,
      },
      { runtime: "openclaw" },
    );

    expect(received?.toolName).toBe("bash");
    expect(received?.details).toMatchObject({
      status: "completed",
      aggregated: "hello\n",
      exitCode: 0,
      cwd: "/tmp/openclaw-tokenjuice-test",
    });
    expect(result?.result.content).toEqual([{ type: "text", text: "compacted" }]);
  });
});

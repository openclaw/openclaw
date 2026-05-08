import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("agentkit plugin", () => {
  it("is opt-in by default and declares the runtime slash alias", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      commandAliases?: Array<Record<string, unknown>>;
      enabledByDefault?: unknown;
    };

    expect(manifest.enabledByDefault).toBeUndefined();
    expect(manifest.commandAliases).toEqual([
      expect.objectContaining({
        name: "agentkit",
        kind: "runtime-slash",
        cliCommand: "agentkit",
      }),
    ]);
  });

  it("registers the agentkit command and CLI descriptor", () => {
    const registerCli = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "agentkit",
        name: "AgentKit",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerCli,
        registerCommand,
        on,
      }),
    );

    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "agentkit",
      description: "Inspect World AgentKit readiness, registration, and verifier flows.",
    });
    expect(on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      descriptors: [
        {
          name: "agentkit",
          description: "Inspect World AgentKit readiness, registration, and verifier flows",
          hasSubcommands: true,
        },
      ],
    });
  });
});

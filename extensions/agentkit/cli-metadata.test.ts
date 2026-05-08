import { Command } from "commander";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./cli-metadata.js";

describe("agentkit cli metadata entry", () => {
  it("registers the root agentkit CLI surface without runtime enablement", async () => {
    const registerCli = vi.fn();
    const api = createTestPluginApi({
      id: "agentkit",
      name: "AgentKit",
      registerCli,
    });
    const program = new Command();

    plugin.register(api);

    const register = registerCli.mock.calls[0]?.[0];

    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      descriptors: [
        {
          name: "agentkit",
          description: "Inspect World AgentKit readiness, registration, and verifier flows",
          hasSubcommands: true,
        },
      ],
    });
    expect(typeof register).toBe("function");

    await register({
      program,
      config: {},
      workspaceDir: "/tmp/openclaw",
      logger: api.logger,
    });

    const agentkitCommand = program.commands.find((command) => command.name() === "agentkit");
    expect(agentkitCommand).toBeDefined();
    expect(agentkitCommand?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "status",
        "register",
        "verify-header",
        "verifier-server",
        "verifier-request",
        "request",
      ]),
    );
  });
});

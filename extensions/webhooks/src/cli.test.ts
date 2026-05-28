import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWebhooksCli, testing } from "./cli.js";

function createProgram(): Command {
  return new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
}

describe("webhooks CLI", () => {
  afterEach(() => {
    testing.setCallGatewayFromCliForTests();
    vi.restoreAllMocks();
  });

  it("registers subscription commands on the provided parent command", async () => {
    const callGateway = vi.fn(async () => ({ subscriptions: [] }));
    testing.setCallGatewayFromCliForTests(callGateway as never);
    const program = createProgram();
    const webhooks = program.command("webhooks");

    registerWebhooksCli({ program: webhooks });

    expect(webhooks.commands.map((command) => command.name())).toEqual([
      "subscribe",
      "list",
      "remove",
      "test",
    ]);

    await program.parseAsync(["node", "openclaw", "webhooks", "list"]);

    expect(callGateway).toHaveBeenCalledWith(
      "webhooks.list",
      { json: true, timeout: "10000" },
      undefined,
      { progress: false },
    );
  });
});

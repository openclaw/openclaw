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

  it("prints Hermes-style subscription setup output by default", async () => {
    const callGateway = vi.fn(async () => ({
      subscription: {
        name: "github-pr-review",
        path: "/plugins/webhooks/github-pr-review",
        events: ["pull_request"],
        dispatch: {
          mode: "agent",
          agent: {
            agentId: "webhook-reviewer",
            messageTemplate: "Review GitHub PR {{body.pull_request.html_url}}.",
          },
        },
      },
      secret: "generated-secret",
      webhookUrl: "https://gateway.example.com/plugins/webhooks/github-pr-review",
    }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    testing.setCallGatewayFromCliForTests(callGateway as never);
    const program = createProgram();
    const webhooks = program.command("webhooks");
    registerWebhooksCli({ program: webhooks });

    await program.parseAsync([
      "node",
      "openclaw",
      "webhooks",
      "subscribe",
      "github-pr-review",
      "--events",
      "pull_request",
      "--agent-id",
      "webhook-reviewer",
    ]);

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("Webhook subscription: github-pr-review");
    expect(output).toContain(
      "URL:    https://gateway.example.com/plugins/webhooks/github-pr-review",
    );
    expect(output).toContain("Secret: generated-secret");
    expect(output).toContain("Events: pull_request");
    expect(output).toContain("Dispatch: agent (webhook-reviewer)");
    expect(output).toContain("Configure your service to POST to the URL above.");
  });

  it("keeps raw JSON output for scripts", async () => {
    const result = {
      subscription: {
        name: "github-pr-review",
        path: "/plugins/webhooks/github-pr-review",
      },
      secret: "generated-secret",
    };
    const callGateway = vi.fn(async () => result);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    testing.setCallGatewayFromCliForTests(callGateway as never);
    const program = createProgram();
    const webhooks = program.command("webhooks");
    registerWebhooksCli({ program: webhooks });

    await program.parseAsync([
      "node",
      "openclaw",
      "webhooks",
      "subscribe",
      "github-pr-review",
      "--json",
    ]);

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(JSON.parse(output)).toEqual(result);
  });
});

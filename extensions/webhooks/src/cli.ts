import { format } from "node:util";
import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";

type WebhookGatewayMethod =
  | "webhooks.subscribe"
  | "webhooks.list"
  | "webhooks.remove"
  | "webhooks.test";

const cliDeps = {
  callGatewayFromCli,
};

export const testing = {
  setCallGatewayFromCliForTests(next?: typeof callGatewayFromCli): void {
    cliDeps.callGatewayFromCli = next ?? callGatewayFromCli;
  },
};

function writeLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function callWebhookGateway(
  method: WebhookGatewayMethod,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return await cliDeps.callGatewayFromCli(method, { json: true, timeout: "10000" }, params, {
    progress: false,
  });
}

function splitCsv(value: string | undefined): string[] | undefined {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
}

export function registerWebhooksCli(params: { program: Command }): void {
  const command = params.program
    .command("webhook")
    .alias("webhooks")
    .description("Manage webhook subscriptions through the OpenClaw Gateway.");

  command
    .command("subscribe")
    .alias("add")
    .argument("<name>", "subscription name")
    .option("--path <path>", "webhook path")
    .option("--session-key <key>", "OpenClaw session key")
    .option("--agent-id <id>", "agent id for agent dispatch")
    .option("--dispatch-mode <mode>", "agent or ack")
    .option("--delivery-mode <mode>", "none or announce", "none")
    .option("--prompt <template>", "message template")
    .option("--message-template <template>", "message template")
    .option("--events <csv>", "allowed events")
    .option("--event-header <header>", "event type header")
    .option("--event-payload-path <path>", "event type payload path")
    .option("--idempotency-header <header>", "delivery id header")
    .option("--idempotency-payload-path <path>", "delivery id payload path")
    .option("--idempotency-ttl-hours <hours>", "idempotency TTL in hours")
    .option("--skills <csv>", "skills to include in dispatch context")
    .option("--description <text>", "subscription description")
    .option("--secret <secret>", "explicit HMAC secret")
    .action(async (name: string, opts: Record<string, string | undefined>) => {
      const result = await callWebhookGateway("webhooks.subscribe", {
        name,
        path: opts.path,
        sessionKey: opts.sessionKey,
        agentId: opts.agentId,
        dispatchMode: opts.dispatchMode,
        deliveryMode: opts.deliveryMode,
        prompt: opts.prompt,
        messageTemplate: opts.messageTemplate,
        events: splitCsv(opts.events),
        eventHeader: opts.eventHeader,
        eventPayloadPath: opts.eventPayloadPath,
        idempotencyHeader: opts.idempotencyHeader,
        idempotencyPayloadPath: opts.idempotencyPayloadPath,
        idempotencyTtlHours: opts.idempotencyTtlHours,
        skills: splitCsv(opts.skills),
        description: opts.description,
        secret: opts.secret,
      });
      writeJson(result);
    });

  command
    .command("list")
    .alias("ls")
    .description("List dynamic webhook subscriptions.")
    .action(async () => {
      writeJson(await callWebhookGateway("webhooks.list"));
    });

  command
    .command("remove")
    .alias("rm")
    .argument("<name>", "subscription name")
    .action(async (name: string) => {
      writeJson(await callWebhookGateway("webhooks.remove", { name }));
    });

  command
    .command("test")
    .argument("<name>", "subscription name")
    .option("--payload <json>", "JSON payload", "{}")
    .option("--event-type <type>", "event type header value")
    .option("--idempotency-key <key>", "delivery id header value")
    .action(async (name: string, opts: Record<string, string | undefined>) => {
      const payload = opts.payload?.trim() ? JSON.parse(opts.payload) : {};
      writeJson(
        await callWebhookGateway("webhooks.test", {
          name,
          payload,
          eventType: opts.eventType,
          idempotencyKey: opts.idempotencyKey,
        }),
      );
    });

  command.action(() => {
    writeLine(command.helpInformation());
  });
}

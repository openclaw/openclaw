import { format } from "node:util";
import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";

type WebhookGatewayMethod =
  | "webhooks.subscribe"
  | "webhooks.list"
  | "webhooks.remove"
  | "webhooks.test";

type PublicSubscription = {
  name?: unknown;
  path?: unknown;
  events?: unknown;
  dispatch?: unknown;
  prompt?: unknown;
  description?: unknown;
  auth?: unknown;
};

type SubscribeResult = {
  subscription?: PublicSubscription;
  secret?: unknown;
  webhookUrl?: unknown;
};

type ListResult = {
  subscriptions?: unknown;
};

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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatSubscriptionDispatch(subscription: PublicSubscription): string {
  const dispatch = readRecord(subscription.dispatch);
  const mode = readString(dispatch?.mode) ?? "(unknown)";
  if (mode !== "agent") {
    return mode;
  }
  const agent = readRecord(dispatch?.agent);
  const agentId = readString(agent?.agentId);
  return agentId ? `${mode} (${agentId})` : mode;
}

function formatPromptPreview(subscription: PublicSubscription): string | undefined {
  const prompt = readString(subscription.prompt);
  if (prompt) {
    return prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
  }
  const dispatch = readRecord(subscription.dispatch);
  const agent = readRecord(dispatch?.agent);
  const messageTemplate = readString(agent?.messageTemplate);
  if (!messageTemplate) {
    return undefined;
  }
  return messageTemplate.length > 80 ? `${messageTemplate.slice(0, 80)}...` : messageTemplate;
}

function writeSubscribeResult(result: SubscribeResult): void {
  const subscription = result.subscription ?? {};
  const name = readString(subscription.name) ?? "(unknown)";
  const url = readString(result.webhookUrl) ?? readString(subscription.path) ?? "(unknown)";
  const events = readStringArray(subscription.events);
  const prompt = formatPromptPreview(subscription);

  writeLine("");
  writeLine("  Webhook subscription: %s", name);
  writeLine("  URL:    %s", url);
  writeLine("  Secret: %s", readString(result.secret) ?? "(not returned)");
  writeLine("  Events: %s", events.length ? events.join(", ") : "(all)");
  writeLine("  Dispatch: %s", formatSubscriptionDispatch(subscription));
  if (prompt) {
    writeLine("  Prompt: %s", prompt);
  }
  writeLine("");
  writeLine("  Configure your service to POST to the URL above.");
  writeLine("  Use the secret for HMAC-SHA256 signature validation.");
  writeLine("  The Gateway must be running and reachable to receive provider events.");
  writeLine("");
}

function writeListResult(result: ListResult): void {
  const subscriptions = Array.isArray(result.subscriptions) ? result.subscriptions : [];
  if (!subscriptions.length) {
    writeLine("  No dynamic webhook subscriptions.");
    writeLine("  Create one with: openclaw webhooks subscribe <name>");
    return;
  }

  writeLine("");
  writeLine("  %d webhook subscription(s):", subscriptions.length);
  writeLine("");
  for (const entry of subscriptions) {
    const subscription = entry as PublicSubscription;
    const name = readString(subscription.name) ?? "(unknown)";
    const path = readString(subscription.path) ?? "(unknown)";
    const events = readStringArray(subscription.events);
    const description = readString(subscription.description);
    writeLine("  - %s", name);
    if (description) {
      writeLine("    %s", description);
    }
    writeLine("    Path:     %s", path);
    writeLine("    Events:   %s", events.length ? events.join(", ") : "(all)");
    writeLine("    Dispatch: %s", formatSubscriptionDispatch(subscription));
    writeLine("");
  }
}

function writeRemoveResult(name: string, result: unknown): void {
  const removed = readRecord(result)?.removed === true;
  if (removed) {
    writeLine("  Removed webhook subscription: %s", name);
    return;
  }
  writeLine("  No dynamic webhook subscription named '%s'.", name);
}

function writeTestResult(name: string, result: unknown): void {
  const routeResult = readRecord(result)?.result;
  const record = readRecord(routeResult);
  const statusCode = record?.statusCode;
  const body = readString(record?.body);
  writeLine("  Sent signed test delivery to webhook subscription: %s", name);
  if (typeof statusCode === "number") {
    writeLine("  Response: %d%s", statusCode, body ? ` ${body}` : "");
    return;
  }
  writeJson(result);
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
  const command = params.program;

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
    .option("--json", "print raw JSON")
    .action(async (name: string, opts: Record<string, string | boolean | undefined>) => {
      const result = await callWebhookGateway("webhooks.subscribe", {
        name,
        path: readString(opts.path),
        sessionKey: readString(opts.sessionKey),
        agentId: readString(opts.agentId),
        dispatchMode: readString(opts.dispatchMode),
        deliveryMode: readString(opts.deliveryMode),
        prompt: readString(opts.prompt),
        messageTemplate: readString(opts.messageTemplate),
        events: splitCsv(readString(opts.events)),
        eventHeader: readString(opts.eventHeader),
        eventPayloadPath: readString(opts.eventPayloadPath),
        idempotencyHeader: readString(opts.idempotencyHeader),
        idempotencyPayloadPath: readString(opts.idempotencyPayloadPath),
        idempotencyTtlHours: readString(opts.idempotencyTtlHours),
        skills: splitCsv(readString(opts.skills)),
        description: readString(opts.description),
        secret: readString(opts.secret),
      });
      if (opts.json) {
        writeJson(result);
        return;
      }
      writeSubscribeResult(result as SubscribeResult);
    });

  command
    .command("list")
    .alias("ls")
    .description("List dynamic webhook subscriptions.")
    .option("--json", "print raw JSON")
    .action(async (opts: Record<string, boolean | undefined>) => {
      const result = await callWebhookGateway("webhooks.list");
      if (opts.json) {
        writeJson(result);
        return;
      }
      writeListResult(result as ListResult);
    });

  command
    .command("remove")
    .alias("rm")
    .argument("<name>", "subscription name")
    .option("--json", "print raw JSON")
    .action(async (name: string, opts: Record<string, boolean | undefined>) => {
      const result = await callWebhookGateway("webhooks.remove", { name });
      if (opts.json) {
        writeJson(result);
        return;
      }
      writeRemoveResult(name, result);
    });

  command
    .command("test")
    .argument("<name>", "subscription name")
    .option("--payload <json>", "JSON payload", "{}")
    .option("--event-type <type>", "event type header value")
    .option("--idempotency-key <key>", "delivery id header value")
    .option("--json", "print raw JSON")
    .action(async (name: string, opts: Record<string, string | boolean | undefined>) => {
      const payloadText = readString(opts.payload);
      const payload = payloadText ? JSON.parse(payloadText) : {};
      const result = await callWebhookGateway("webhooks.test", {
        name,
        payload,
        eventType: readString(opts.eventType),
        idempotencyKey: readString(opts.idempotencyKey),
      });
      if (opts.json) {
        writeJson(result);
        return;
      }
      writeTestResult(name, result);
    });

  command.action(() => writeLine(command.helpInformation()));
}

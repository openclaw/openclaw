import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { normalizeWebhookPath } from "../runtime-api.js";
import {
  resolveWebhooksPluginConfig,
  type ConfiguredWebhookDeliveryConfig,
  type ConfiguredWebhookRouteConfig,
} from "./config.js";
import type { WebhookTarget } from "./http.js";
import { buildWebhookTargets } from "./targets.js";

type SubscriptionDispatchInput =
  | {
      mode: "ack";
    }
  | {
      mode: "agent";
      agentId?: string;
      deliveryMode?: "announce" | "none";
      messageTemplate?: string;
    }
  | {
      mode: "deliver";
      deliver: ConfiguredWebhookDeliveryConfig;
    };

export type WebhookSubscription = {
  name: string;
  path: string;
  sessionKey?: string;
  auth: {
    mode: "hmac-sha256";
    header: string;
    prefix: string;
    secret: string;
  };
  event?: {
    header?: string;
    payloadPath?: string;
  };
  events?: string[];
  idempotency?: {
    header?: string;
    payloadPath?: string;
    ttlHours?: number;
  };
  dispatch: SubscriptionDispatchInput;
  prompt?: string;
  skills?: string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
};

type SubscriptionFile = {
  version: 1;
  subscriptions: WebhookSubscription[];
};

type PublicSubscription = Omit<WebhookSubscription, "auth"> & {
  auth: Omit<WebhookSubscription["auth"], "secret"> & {
    secretConfigured: boolean;
  };
};

export type WebhookSubscriptionStore = {
  subscribe(input: SubscribeInput): Promise<{
    subscription: PublicSubscription;
    secret: string;
    webhookUrl?: string;
  }>;
  list(): Promise<PublicSubscription[]>;
  remove(name: string): Promise<boolean>;
  loadTargets(): Promise<Map<string, WebhookTarget[]>>;
  get(name: string): Promise<WebhookSubscription | undefined>;
};

export type SubscribeInput = {
  name: string;
  path?: string;
  sessionKey?: string;
  secret?: string;
  events?: string[];
  eventHeader?: string;
  eventPayloadPath?: string;
  idempotencyHeader?: string;
  idempotencyPayloadPath?: string;
  idempotencyTtlHours?: number;
  dispatchMode?: "ack" | "agent";
  agentId?: string;
  deliveryMode?: "announce" | "none";
  prompt?: string;
  messageTemplate?: string;
  skills?: string[];
  description?: string;
};

function resolveDefaultStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

function stateFilePath(stateDir?: string): string {
  return path.join(stateDir || resolveDefaultStateDir(), "webhooks", "subscriptions.json");
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)) {
    throw new Error("subscription name must contain only letters, numbers, '.', '_' or '-'");
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function toPublicSubscription(subscription: WebhookSubscription): PublicSubscription {
  const { auth, ...rest } = subscription;
  return {
    ...rest,
    auth: {
      mode: auth.mode,
      header: auth.header,
      prefix: auth.prefix,
      secretConfigured: true,
    },
  };
}

function parseFile(raw: string): SubscriptionFile {
  const parsed = JSON.parse(raw) as Partial<SubscriptionFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.subscriptions)) {
    return { version: 1, subscriptions: [] };
  }
  return {
    version: 1,
    subscriptions: parsed.subscriptions.filter((entry): entry is WebhookSubscription =>
      Boolean(entry && typeof entry === "object" && typeof entry.name === "string"),
    ),
  };
}

function toRouteConfig(subscription: WebhookSubscription): Record<string, unknown> {
  const dispatchMode = subscription.dispatch.mode;
  return {
    path: subscription.path,
    ...(subscription.sessionKey ? { sessionKey: subscription.sessionKey } : {}),
    auth: subscription.auth,
    ...(subscription.events ? { events: subscription.events } : {}),
    event: {
      ...(subscription.event?.header ? { header: subscription.event.header } : {}),
      ...(subscription.event?.payloadPath ? { payloadPath: subscription.event.payloadPath } : {}),
    },
    ...(subscription.idempotency
      ? {
          idempotency: {
            ...(subscription.idempotency.header ? { header: subscription.idempotency.header } : {}),
            ...(subscription.idempotency.payloadPath
              ? { payloadPath: subscription.idempotency.payloadPath }
              : {}),
            ...(subscription.idempotency.ttlHours
              ? { ttlHours: subscription.idempotency.ttlHours }
              : {}),
          },
        }
      : {}),
    dispatch:
      dispatchMode === "agent"
        ? {
            mode: "agent",
            agent: {
              deliveryMode: subscription.dispatch.deliveryMode ?? "none",
              ...(subscription.dispatch.agentId ? { agentId: subscription.dispatch.agentId } : {}),
              ...(subscription.dispatch.messageTemplate
                ? { messageTemplate: subscription.dispatch.messageTemplate }
                : subscription.prompt
                  ? { messageTemplate: subscription.prompt }
                  : {}),
            },
          }
        : dispatchMode === "deliver"
          ? { mode: "deliver" }
          : { mode: "ack" },
    ...(dispatchMode === "deliver" ? { deliver: subscription.dispatch.deliver } : {}),
    ...(subscription.prompt ? { prompt: subscription.prompt } : {}),
    ...(subscription.skills ? { skills: subscription.skills } : {}),
    ...(subscription.description ? { description: subscription.description } : {}),
  };
}

function buildDynamicRoutes(subscriptions: WebhookSubscription[]): ConfiguredWebhookRouteConfig[] {
  const routes = Object.fromEntries(
    subscriptions.map((subscription) => [subscription.name, toRouteConfig(subscription)]),
  );
  return resolveWebhooksPluginConfig({ pluginConfig: { routes } });
}

function formatWebhookUrl(publicUrl: string | undefined, webhookPath: string): string | undefined {
  if (!publicUrl) {
    return undefined;
  }
  const base = new URL(publicUrl);
  base.pathname = webhookPath;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function signWebhookTestPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function createWebhookSubscriptionStore(params: {
  api: OpenClawPluginApi;
  staticRoutes: ConfiguredWebhookRouteConfig[];
  stateDir?: string;
  publicUrl?: string;
}): WebhookSubscriptionStore {
  const filePath = stateFilePath(params.stateDir);
  const staticRouteIds = new Set(params.staticRoutes.map((route) => route.routeId));
  const staticRoutePaths = new Set(params.staticRoutes.map((route) => route.path));
  let cachedMtimeMs = -1;
  let cached: SubscriptionFile | undefined;

  async function read(): Promise<SubscriptionFile> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      cachedMtimeMs = -1;
      cached = { version: 1, subscriptions: [] };
      return cached;
    }
    if (cached && cachedMtimeMs === stat.mtimeMs) {
      return cached;
    }
    const raw = await fs.readFile(filePath, "utf8");
    cached = parseFile(raw);
    cachedMtimeMs = stat.mtimeMs;
    return cached;
  }

  async function write(next: SubscriptionFile): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    cached = next;
    try {
      cachedMtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      cachedMtimeMs = -1;
    }
  }

  function visibleSubscriptions(file: SubscriptionFile): WebhookSubscription[] {
    return file.subscriptions.filter((subscription) => !staticRouteIds.has(subscription.name));
  }

  return {
    async subscribe(input) {
      const name = normalizeName(input.name);
      if (staticRouteIds.has(name)) {
        throw new Error(`static webhook route already exists: ${name}`);
      }
      const now = new Date().toISOString();
      const file = await read();
      const existing = file.subscriptions.find((subscription) => subscription.name === name);
      const pathValue = normalizeWebhookPath(
        input.path ?? existing?.path ?? `/plugins/webhooks/${name}`,
      );
      if (staticRoutePaths.has(pathValue)) {
        throw new Error(`static webhook route already owns path: ${pathValue}`);
      }
      const dispatchMode = input.dispatchMode ?? "agent";
      const sessionKey =
        normalizeOptionalString(input.sessionKey) ??
        existing?.sessionKey ??
        (dispatchMode === "agent" ? `agent:${input.agentId ?? "main"}:webhook-${name}` : undefined);
      if (dispatchMode === "agent" && !sessionKey) {
        throw new Error("sessionKey is required for agent webhook subscriptions");
      }
      const secret =
        normalizeOptionalString(input.secret) ??
        existing?.auth.secret ??
        randomBytes(32).toString("hex");
      const eventHeader = normalizeOptionalString(input.eventHeader);
      const eventPayloadPath = normalizeOptionalString(input.eventPayloadPath);
      const events = normalizeStringArray(input.events);
      const idempotencyHeader = normalizeOptionalString(input.idempotencyHeader);
      const idempotencyPayloadPath = normalizeOptionalString(input.idempotencyPayloadPath);
      const agentId = normalizeOptionalString(input.agentId);
      const messageTemplate =
        normalizeOptionalString(input.messageTemplate) ?? normalizeOptionalString(input.prompt);
      const prompt = normalizeOptionalString(input.prompt);
      const skills = normalizeStringArray(input.skills);
      const description = normalizeOptionalString(input.description);
      const subscription: WebhookSubscription = {
        name,
        path: pathValue,
        ...(sessionKey ? { sessionKey } : {}),
        auth: {
          mode: "hmac-sha256",
          header: "x-openclaw-webhook-signature-256",
          prefix: "sha256=",
          secret,
        },
        event: {
          ...(eventHeader ? { header: eventHeader } : {}),
          ...(eventPayloadPath ? { payloadPath: eventPayloadPath } : {}),
        },
        ...(events ? { events } : {}),
        ...(input.idempotencyHeader || input.idempotencyPayloadPath || input.idempotencyTtlHours
          ? {
              idempotency: {
                ...(idempotencyHeader ? { header: idempotencyHeader } : {}),
                ...(idempotencyPayloadPath ? { payloadPath: idempotencyPayloadPath } : {}),
                ...(typeof input.idempotencyTtlHours === "number"
                  ? { ttlHours: input.idempotencyTtlHours }
                  : {}),
              },
            }
          : {}),
        dispatch:
          dispatchMode === "agent"
            ? {
                mode: "agent",
                ...(agentId ? { agentId } : {}),
                deliveryMode: input.deliveryMode ?? "none",
                ...(messageTemplate ? { messageTemplate } : {}),
              }
            : { mode: "ack" },
        ...(prompt ? { prompt } : {}),
        ...(skills ? { skills } : {}),
        ...(description ? { description } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const nextSubscriptions = [
        ...file.subscriptions.filter((entry) => entry.name !== name),
        subscription,
      ].sort((a, b) => a.name.localeCompare(b.name));
      await write({ version: 1, subscriptions: nextSubscriptions });
      params.api.logger.info?.(
        `[webhooks] subscribed dynamic route ${name} on ${subscription.path}`,
      );
      return {
        subscription: toPublicSubscription(subscription),
        secret,
        webhookUrl: formatWebhookUrl(params.publicUrl, subscription.path),
      };
    },

    async list() {
      const file = await read();
      return visibleSubscriptions(file).map(toPublicSubscription);
    },

    async remove(name) {
      const normalized = normalizeName(name);
      const file = await read();
      const nextSubscriptions = file.subscriptions.filter(
        (subscription) => subscription.name !== normalized,
      );
      if (nextSubscriptions.length === file.subscriptions.length) {
        return false;
      }
      await write({ version: 1, subscriptions: nextSubscriptions });
      params.api.logger.info?.(`[webhooks] removed dynamic route ${normalized}`);
      return true;
    },

    async loadTargets() {
      const file = await read();
      const dynamicRoutes = buildDynamicRoutes(visibleSubscriptions(file));
      return buildWebhookTargets({ api: params.api, routes: dynamicRoutes });
    },

    async get(name) {
      const normalized = normalizeName(name);
      const file = await read();
      return visibleSubscriptions(file).find((subscription) => subscription.name === normalized);
    },
  };
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { ErrorCodes, errorShape } from "../../src/gateway/protocol/index.js";
import { renderQrPngBase64 } from "../../src/web/qr-image.js";
import { resolveDefaultSimplexAccountId, resolveSimplexAccount } from "./src/accounts.js";
import { simplexPlugin } from "./src/channel.js";
import { setSimplexRuntime } from "./src/runtime.js";
import { SimplexWsClient, type SimplexWsResponse } from "./src/simplex-ws-client.js";

type SimplexInviteMode = "connect" | "address";

const INVITE_COMMANDS: Record<SimplexInviteMode, string> = {
  connect: "/c",
  address: "/ad",
};

const LINK_REGEX = /\b(simplex:\/\/[^\s"'<>]+|https?:\/\/[^\s"'<>]+)/gi;

function resolveInviteMode(value: unknown): SimplexInviteMode | null {
  if (value === "connect" || value === "address") {
    return value;
  }
  return null;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, out));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectStrings(entry, out));
  }
}

function extractSimplexLink(resp: SimplexWsResponse): string | null {
  const strings: string[] = [];
  collectStrings(resp, strings);
  const matches: string[] = [];
  for (const str of strings) {
    for (const match of str.matchAll(LINK_REGEX)) {
      const raw = match[0];
      const cleaned = raw.replace(/[),.\]]+$/g, "");
      matches.push(cleaned);
    }
  }
  const preferred = matches.find((entry) => /simplex/i.test(entry));
  return preferred ?? matches[0] ?? null;
}

function extractSimplexLinks(resp: SimplexWsResponse): string[] {
  const strings: string[] = [];
  collectStrings(resp, strings);
  const matches = new Set<string>();
  for (const str of strings) {
    for (const match of str.matchAll(LINK_REGEX)) {
      const raw = match[0];
      const cleaned = raw.replace(/[),.\]]+$/g, "");
      if (cleaned) {
        matches.add(cleaned);
      }
    }
  }
  return [...matches];
}

function extractSimplexPendingHints(resp: SimplexWsResponse): string[] {
  const strings: string[] = [];
  collectStrings(resp, strings);
  const hints = new Set<string>();
  for (const value of strings) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (lowered.includes("request") || lowered.includes("pending")) {
      hints.add(trimmed);
    }
  }
  return [...hints];
}

type SharedSimplexClientKey = `${string}|${number}`;
const sharedSimplexClients = new Map<SharedSimplexClientKey, SimplexWsClient>();

function getSharedSimplexClient(params: {
  account: ReturnType<typeof resolveSimplexAccount>;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): SimplexWsClient {
  const timeoutMs = params.account.config.connection?.connectTimeoutMs ?? 15_000;
  const key: SharedSimplexClientKey = `${params.account.wsUrl}|${timeoutMs}`;
  const existing = sharedSimplexClients.get(key);
  if (existing) {
    return existing;
  }
  const created = new SimplexWsClient({
    url: params.account.wsUrl,
    connectTimeoutMs: timeoutMs,
    logger: params.logger,
  });
  sharedSimplexClients.set(key, created);
  return created;
}

async function sendSimplexCommand(params: {
  account: ReturnType<typeof resolveSimplexAccount>;
  command: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<SimplexWsResponse> {
  const client = getSharedSimplexClient(params);
  await client.connect();
  return await client.sendCommand(params.command);
}

async function sendSimplexCommandWithRetry(params: {
  account: ReturnType<typeof resolveSimplexAccount>;
  command: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  startChannel?: () => Promise<void>;
  isRunning?: () => boolean;
}): Promise<SimplexWsResponse> {
  const maxAttempts = 6;
  let started = false;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await sendSimplexCommand(params);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const running = params.isRunning?.() ?? false;
      if (!started && !running && params.startChannel) {
        started = true;
        await params.startChannel();
      }
      await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 400));
    }
  }

  throw lastError ?? new Error("SimpleX command failed");
}

const plugin = {
  id: "simplex",
  name: "SimpleX",
  description: "SimpleX Chat channel plugin via CLI",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSimplexRuntime(api.runtime);
    api.registerChannel({ plugin: simplexPlugin });
    api.registerGatewayMethod("simplex.invite.create", async ({ params, respond, context }) => {
      const mode = resolveInviteMode(params?.mode);
      if (!mode) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, 'mode must be "connect" or "address"'),
        );
        return;
      }

      const cfg = api.config;
      const rawAccountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
      const accountId = rawAccountId || resolveDefaultSimplexAccountId(cfg);
      const account = resolveSimplexAccount({ cfg, accountId });

      if (!account.enabled) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `SimpleX account "${accountId}" is disabled`),
        );
        return;
      }
      if (!account.configured) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `SimpleX account "${accountId}" is not configured`,
          ),
        );
        return;
      }

      const command = INVITE_COMMANDS[mode];
      try {
        const response = await sendSimplexCommandWithRetry({
          account,
          command,
          logger: api.logger,
          startChannel: () => context.startChannel("simplex", accountId),
          isRunning: () => {
            const runtime = context.getRuntimeSnapshot();
            const accountRuntime = runtime.channelAccounts?.simplex?.[accountId];
            return Boolean(accountRuntime?.running ?? runtime.channels?.simplex?.running);
          },
        });
        const link = extractSimplexLink(response);
        const qrDataUrl = link ? `data:image/png;base64,${await renderQrPngBase64(link)}` : null;
        respond(true, { mode, accountId, command, link, qrDataUrl, response });
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `SimpleX invite failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
    api.registerGatewayMethod("simplex.invite.list", async ({ params, respond, context }) => {
      const cfg = api.config;
      const rawAccountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
      const accountId = rawAccountId || resolveDefaultSimplexAccountId(cfg);
      const account = resolveSimplexAccount({ cfg, accountId });

      if (!account.enabled) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `SimpleX account "${accountId}" is disabled`),
        );
        return;
      }
      if (!account.configured) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `SimpleX account "${accountId}" is not configured`,
          ),
        );
        return;
      }

      try {
        const [addressResponse, contactsResponse] = await Promise.all([
          sendSimplexCommandWithRetry({
            account,
            command: "/show_address",
            logger: api.logger,
            startChannel: () => context.startChannel("simplex", accountId),
            isRunning: () => {
              const runtime = context.getRuntimeSnapshot();
              const accountRuntime = runtime.channelAccounts?.simplex?.[accountId];
              return Boolean(accountRuntime?.running ?? runtime.channels?.simplex?.running);
            },
          }),
          sendSimplexCommandWithRetry({
            account,
            command: "/contacts",
            logger: api.logger,
            startChannel: () => context.startChannel("simplex", accountId),
            isRunning: () => {
              const runtime = context.getRuntimeSnapshot();
              const accountRuntime = runtime.channelAccounts?.simplex?.[accountId];
              return Boolean(accountRuntime?.running ?? runtime.channels?.simplex?.running);
            },
          }),
        ]);
        const addressLink = extractSimplexLink(addressResponse);
        const links = [
          ...new Set([
            ...extractSimplexLinks(addressResponse),
            ...extractSimplexLinks(contactsResponse),
          ]),
        ];
        const addressQrDataUrl = addressLink
          ? `data:image/png;base64,${await renderQrPngBase64(addressLink)}`
          : null;
        const pendingHints = extractSimplexPendingHints(contactsResponse);
        respond(true, {
          accountId,
          addressLink,
          addressQrDataUrl,
          links,
          pendingHints,
          addressResponse,
          contactsResponse,
        });
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `SimpleX invite list failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
    api.registerGatewayMethod("simplex.invite.revoke", async ({ params, respond, context }) => {
      const cfg = api.config;
      const rawAccountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
      const accountId = rawAccountId || resolveDefaultSimplexAccountId(cfg);
      const account = resolveSimplexAccount({ cfg, accountId });

      if (!account.enabled) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `SimpleX account "${accountId}" is disabled`),
        );
        return;
      }
      if (!account.configured) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `SimpleX account "${accountId}" is not configured`,
          ),
        );
        return;
      }

      try {
        const response = await sendSimplexCommandWithRetry({
          account,
          command: "/delete_address",
          logger: api.logger,
          startChannel: () => context.startChannel("simplex", accountId),
          isRunning: () => {
            const runtime = context.getRuntimeSnapshot();
            const accountRuntime = runtime.channelAccounts?.simplex?.[accountId];
            return Boolean(accountRuntime?.running ?? runtime.channels?.simplex?.running);
          },
        });
        respond(true, { accountId, response });
      } catch (err) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `SimpleX invite revoke failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  },
};

export default plugin;

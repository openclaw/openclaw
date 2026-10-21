import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  listNativeCommandSpecsForConfig,
  type NativeCommandSpec,
} from "openclaw/plugin-sdk/native-command-registry";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson, truncateCodePoints } from "openclaw/plugin-sdk/text-utility-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveClickClackInboundAccess } from "./access.js";
import { resolveClickClackAccount } from "./accounts.js";
import {
  ClickClackHttpError,
  createClickClackClient,
  normalizeClickClackCorrelationId,
} from "./http-client.js";
import { handleClickClackInbound } from "./inbound.js";
import { resolveWorkspaceId } from "./resolve.js";
import type { ClickClackEvent, ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

const CLICKCLACK_EVENT_PAGE_LIMIT = 500;

const CLICKCLACK_COMMAND_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const CLICKCLACK_MAX_COMMANDS = 100;
const CLICKCLACK_MAX_DESCRIPTION_LENGTH = 100;
const CLICKCLACK_MAX_ARGS_HINT_LENGTH = 100;

type ClickClackCommandMenuEntry = {
  command: string;
  description: string;
  args_hint: string;
};

function commandArgsHint(spec: NativeCommandSpec): string {
  if (spec.args?.length) {
    return truncateCodePoints(
      spec.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" "),
      CLICKCLACK_MAX_ARGS_HINT_LENGTH,
    );
  }
  return spec.acceptsArgs ? "[args]" : "";
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function mapNativeCommandSpecsToClickClackMenu(
  specs: NativeCommandSpec[],
  log?: ChannelGatewayContext<ResolvedClickClackAccount>["log"],
): ClickClackCommandMenuEntry[] {
  const commands: ClickClackCommandMenuEntry[] = [];
  const seen = new Set<string>();
  const invalidNames = new Set<string>();

  for (const spec of specs) {
    if (spec.isAlias) {
      continue;
    }
    const command = spec.name.trim().toLowerCase();
    if (!CLICKCLACK_COMMAND_PATTERN.test(command)) {
      invalidNames.add(spec.name.trim() || "<empty>");
      continue;
    }
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);

    const description = spec.description.trim() || command;
    commands.push({
      command,
      description: truncateCodePoints(description, CLICKCLACK_MAX_DESCRIPTION_LENGTH),
      args_hint: commandArgsHint(spec),
    });
  }

  if (invalidNames.size > 0) {
    log?.warn?.(
      `ClickClack command menu skipped invalid native command names: ${[...invalidNames]
        .map((name) => JSON.stringify(name))
        .join(", ")}`,
    );
  }

  return commands.slice(0, CLICKCLACK_MAX_COMMANDS);
}

function payloadString(event: ClickClackEvent, key: string): string {
  return readStringField(event.payload, key) ?? "";
}

async function resolveEventMessage(params: {
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
}): Promise<ClickClackMessage | null> {
  const messageId = payloadString(params.event, "message_id");
  if (!messageId) {
    return null;
  }
  try {
    return await params.client.message(messageId);
  } catch (error) {
    if (error instanceof ClickClackHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function startClickClackGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedClickClackAccount>,
) {
  const configuredAccount = resolveClickClackAccount({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
  });
  if (!configuredAccount.configured) {
    throw new Error(`ClickClack is not configured for account "${configuredAccount.accountId}"`);
  }
  const client = createClickClackClient({
    baseUrl: configuredAccount.apiEndpoint,
    token: configuredAccount.token,
  });
  const workspaceId = await resolveWorkspaceId(client, configuredAccount.workspace);
  const me = await client.me();
  const account = {
    ...configuredAccount,
    workspace: workspaceId,
    botUserId: configuredAccount.botUserId ?? me.id,
    botHandle: me.handle,
  };
  const processIncomingEvent = async (event: ClickClackEvent) => {
    const { abortSignal, cfg: config, log } = ctx;
    const botUserId = account.botUserId;
    const buildContext = (ctx.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound
      .buildContext;
    if (event.type !== "message.created" && event.type !== "thread.reply_created") {
      return;
    }
    if (abortSignal.aborted || payloadString(event, "author_id") === botUserId) {
      return;
    }
    const correlationId = normalizeClickClackCorrelationId(event.payload?.correlation_id);
    // The event body is only a routing hint. Re-fetch the authoritative message
    // under the same safe correlation id before dispatching any model work.
    const messageClient = correlationId
      ? createClickClackClient({
          baseUrl: account.apiEndpoint,
          token: account.token,
          correlationId,
        })
      : client;
    const message = await resolveEventMessage({ client: messageClient, event });
    if (!message) {
      log?.warn?.(
        `[${account.accountId}] skipped unreadable ClickClack message before agent dispatch: ` +
          `type=${event.type} messageId=${payloadString(event, "message_id") || "unknown"}`,
      );
      return;
    }
    if (abortSignal.aborted || message.author_id === botUserId) {
      return;
    }
    const access = await resolveClickClackInboundAccess({
      account,
      config,
      message,
    });
    // Account shutdown can race either awaited lookup; retired generations must never start a turn.
    if (abortSignal.aborted) {
      return;
    }
    if (!access.shouldDispatch) {
      log?.info(
        `[${account.accountId}] skipped ClickClack message before agent dispatch: ` +
          `kind=${message.direct_conversation_id ? "dm" : "group"} ` +
          `requireMention=${access.requireMention ?? "unknown"} ` +
          `wasMentioned=${access.mentionFacts.wasMentioned} ` +
          `hasAnyMention=${access.mentionFacts.hasAnyMention ?? "unknown"} ` +
          `commandAuthorized=${access.commandAuthorized}`,
      );
      return;
    }
    await handleClickClackInbound({
      account,
      config,
      message,
      access,
      buildContext,
      ...(correlationId ? { correlationId } : {}),
    });
  };
  if (account.commandMenu) {
    try {
      const specs = listNativeCommandSpecsForConfig(ctx.cfg, { provider: "clickclack" });
      const commands = mapNativeCommandSpecsToClickClackMenu(specs, ctx.log);
      await client.setBotCommands(commands);
    } catch (error) {
      const status = errorStatus(error);
      const messagePrefix = `[${account.accountId}] ClickClack command menu sync`;
      if (status === 403) {
        ctx.log?.warn?.(
          `${messagePrefix} skipped: ${formatErrorMessage(error)}; verify token/workspace command permissions or set commandMenu: false if menus are not needed`,
        );
      } else if (status === 404) {
        ctx.log?.debug?.(
          `${messagePrefix} skipped: server does not support /api/bots/self/commands`,
        );
      } else {
        ctx.log?.warn?.(`${messagePrefix} failed: ${formatErrorMessage(error)}`);
      }
    }
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let afterCursor = "";
  let initialized = false;
  try {
    while (!ctx.abortSignal.aborted) {
      if (!initialized) {
        const page = await client.eventPage(workspaceId, { includeTail: true });
        // Newer servers capture this cursor before listing the page, so events
        // created during startup remain eligible for websocket delivery.
        if (page.tailCursor !== undefined) {
          afterCursor = page.tailCursor;
        } else {
          // Older servers omit tail_cursor; preserve the shipped one-page
          // startup behavior instead of extending the history-skip window.
          for (const event of page.events) {
            afterCursor = event.cursor || afterCursor;
          }
        }
        initialized = true;
      } else {
        while (!ctx.abortSignal.aborted) {
          const page = await client.eventPage(workspaceId, {
            afterCursor,
            limit: CLICKCLACK_EVENT_PAGE_LIMIT,
          });
          for (const event of page.events) {
            if (ctx.abortSignal.aborted) {
              break;
            }
            if (!event.cursor || event.cursor === afterCursor) {
              throw new Error("ClickClack event backlog returned a non-advancing cursor");
            }
            await processIncomingEvent(event);
            afterCursor = event.cursor;
          }
          if (page.events.length === 0) {
            break;
          }
        }
      }
      if (ctx.abortSignal.aborted) {
        break;
      }
      const socket = client.websocket(workspaceId, afterCursor);
      await new Promise<void>((resolve) => {
        let settled = false;
        let closing = false;
        let loggedMessageFailure = false;
        let messageQueue = Promise.resolve();
        let removeAbortListener: (() => void) | undefined;
        const finishSocketCycle = () => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener?.();
          removeAbortListener = undefined;
          resolve();
        };
        const finishAfterQueuedMessages = () => {
          // The queue is scoped to this account/socket. Waiting here preserves
          // its contiguous cursor without blocking unrelated account streams.
          void messageQueue.then(
            () => finishSocketCycle(),
            () => finishSocketCycle(),
          );
        };
        const reconnectAfterMessageFailure = (error: unknown) => {
          if (settled || ctx.abortSignal.aborted) {
            return;
          }
          if (!loggedMessageFailure) {
            loggedMessageFailure = true;
            ctx.log?.warn?.(
              `[${account.accountId}] ClickClack event processing failed; reconnecting: ${
                error instanceof Error ? error.message : formatErrorMessage(error)
              }`,
            );
          }
          if (!closing) {
            // Keep the last successful cursor. Reconnect backlog will replay
            // this event; a repeated failure there remains a surfaced error.
            closing = true;
            socket.close();
          }
        };
        const abort = () => {
          socket.close();
          finishSocketCycle();
        };
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.abortSignal.removeEventListener("abort", abort);
        socket.on("open", () => {
          ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
        });
        socket.on("message", (data) => {
          if (closing || settled) {
            return;
          }
          // Preserve server event order and commit each cursor only after its
          // handler succeeds, so reconnect backlog can retry a failed event.
          messageQueue = messageQueue.then(async () => {
            if (ctx.abortSignal.aborted) {
              return;
            }
            const event = safeParseJson<ClickClackEvent>(rawDataToString(data));
            if (!event) {
              ctx.log?.warn?.(
                `[${account.accountId}] skipped malformed ClickClack websocket event`,
              );
              return;
            }
            await processIncomingEvent(event);
            afterCursor = event.cursor || afterCursor;
          });
          void messageQueue.catch(reconnectAfterMessageFailure);
        });
        socket.on("close", () => {
          closing = true;
          if (!ctx.abortSignal.aborted) {
            ctx.setStatus({
              accountId: account.accountId,
              connected: false,
              lifecycle: "recovering",
            });
          }
          finishAfterQueuedMessages();
        });
        socket.on("error", (error) => {
          if (settled || ctx.abortSignal.aborted) {
            finishSocketCycle();
            return;
          }
          if (closing) {
            return;
          }
          ctx.log?.warn?.(
            `[${account.accountId}] ClickClack websocket error; reconnecting: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          ctx.setStatus({
            accountId: account.accountId,
            connected: false,
            lifecycle: "recovering",
            lastError: error instanceof Error ? error.message : String(error),
          });
          closing = true;
          socket.close();
        });
      });
      if (!ctx.abortSignal.aborted) {
        try {
          // The gateway abort owns both the active socket and its reconnect delay;
          // otherwise shutdown can remain pending for the full configured backoff.
          await sleepWithAbort(account.reconnectMs, ctx.abortSignal);
        } catch (error) {
          if (!ctx.abortSignal.aborted) {
            throw error;
          }
        }
      }
    }
  } finally {
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}

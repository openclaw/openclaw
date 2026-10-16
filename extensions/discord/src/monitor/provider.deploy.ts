import { warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { Client, type RequestClient } from "../internal/discord.js";
import {
  attachDiscordDeployRestContext,
  attachDiscordDeployRequestBody,
  formatDiscordDeployErrorDetails,
  formatDiscordDeployErrorMessage,
  formatDiscordDeployRateLimitWarning,
  isDiscordDeployDailyCreateLimit,
} from "./provider.deploy-errors.js";

type RestMethodName = "get" | "post" | "put" | "patch" | "delete";
type RestMethod = RequestClient[RestMethodName];
type RestMethodMap = Record<RestMethodName, RestMethod>;

function readDeployRequestBody(data?: unknown): unknown {
  return data && typeof data === "object" && "body" in data
    ? (data as { body?: unknown }).body
    : undefined;
}

// deployCommands only touches application-command routes. The wrapper patches
// the shared client.rest, so unrelated concurrent startup traffic (voice-state
// probes, channel lookups) must pass through untouched or it gets mislabeled
// as slash-command deploy and double-logged next to its owner's handling.
function isDeployCommandsPath(path: string): boolean {
  return path.startsWith("/applications/") && path.includes("/commands");
}

function wrapDeployRestMethod(params: {
  method: RestMethodName;
  original: RestMethodMap;
  timeoutMs?: number;
}) {
  return async (path: string, data?: never, query?: never) => {
    if (!isDeployCommandsPath(path)) {
      return params.original[params.method](path, data, query);
    }
    const startedAt = Date.now();
    const body = readDeployRequestBody(data);
    try {
      return await params.original[params.method](path, data, query);
    } catch (err) {
      const requestMs = Date.now() - startedAt;
      attachDiscordDeployRequestBody(err, body);
      attachDiscordDeployRestContext(err, {
        method: params.method,
        path,
        requestMs,
        timeoutMs: params.timeoutMs,
      });
      throw err;
    }
  };
}

function installDeployRestErrorContext(params: { rest: RequestClient }): () => void {
  const original: RestMethodMap = {
    get: params.rest.get.bind(params.rest),
    post: params.rest.post.bind(params.rest),
    put: params.rest.put.bind(params.rest),
    patch: params.rest.patch.bind(params.rest),
    delete: params.rest.delete.bind(params.rest),
  };
  for (const method of Object.keys(original) as RestMethodName[]) {
    params.rest[method] = wrapDeployRestMethod({
      method,
      original,
      timeoutMs: params.rest.options.timeout,
    }) as RequestClient[typeof method];
  }
  return () => {
    Object.assign(params.rest, original);
  };
}

async function deployDiscordCommands(params: {
  client: Client;
  runtime: RuntimeEnv;
  accountId: string;
}) {
  const { accountId } = params;
  const restoreDeployRestErrorContext = installDeployRestErrorContext({
    rest: params.client.rest,
  });
  try {
    try {
      await params.client.deployCommands();
    } catch (err) {
      if (isDiscordDeployDailyCreateLimit(err)) {
        params.runtime.log?.(
          warn(
            `[${accountId}] slash command deploy skipped: daily application command create limit reached. Existing slash commands stay active until Discord resets the quota; message send/receive is unaffected.`,
          ),
        );
        return;
      }
      const rateLimitWarning = formatDiscordDeployRateLimitWarning(err, accountId);
      if (rateLimitWarning) {
        params.runtime.log?.(warn(rateLimitWarning));
        return;
      }
      throw err;
    }
  } catch (err) {
    params.runtime.log?.(
      warn(
        `[${accountId}] slash command deploy failed (message send/receive unaffected): ${formatDiscordDeployErrorMessage(err)}${formatDiscordDeployErrorDetails(err)}`,
      ),
    );
  } finally {
    restoreDeployRestErrorContext();
  }
}

export function runDiscordCommandDeployInBackground(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId: string;
}) {
  if (!params.enabled) {
    return;
  }
  void deployDiscordCommands(params).catch((err: unknown) => {
    params.runtime.log?.(
      warn(
        `[${params.accountId}] slash command deploy failed in background (message send/receive unaffected): ${formatErrorMessage(err)}`,
      ),
    );
  });
}

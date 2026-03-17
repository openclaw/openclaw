import { resolveSlashCommandConfig } from "./slash-commands.js";
import { createSlashCommandHttpHandler } from "./slash-http.js";
const accountStates = /* @__PURE__ */ new Map();
function resolveSlashHandlerForToken(token) {
  const matches = [];
  for (const [accountId, state] of accountStates) {
    if (state.commandTokens.has(token) && state.handler) {
      matches.push({ accountId, handler: state.handler });
    }
  }
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length === 1) {
    return { kind: "single", handler: matches[0].handler, accountIds: [matches[0].accountId] };
  }
  return {
    kind: "ambiguous",
    accountIds: matches.map((entry) => entry.accountId)
  };
}
function getSlashCommandState(accountId) {
  return accountStates.get(accountId) ?? null;
}
function getAllSlashCommandStates() {
  return accountStates;
}
function activateSlashCommands(params) {
  const { account, commandTokens, registeredCommands, triggerMap, api, log } = params;
  const accountId = account.accountId;
  const tokenSet = new Set(commandTokens);
  const handler = createSlashCommandHttpHandler({
    account,
    cfg: api.cfg,
    runtime: api.runtime,
    commandTokens: tokenSet,
    triggerMap,
    log
  });
  accountStates.set(accountId, {
    commandTokens: tokenSet,
    registeredCommands,
    handler,
    account,
    triggerMap: triggerMap ?? /* @__PURE__ */ new Map()
  });
  log?.(
    `mattermost: slash commands activated for account ${accountId} (${registeredCommands.length} commands)`
  );
}
function deactivateSlashCommands(accountId) {
  if (accountId) {
    const state = accountStates.get(accountId);
    if (state) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
      accountStates.delete(accountId);
    }
  } else {
    for (const [, state] of accountStates) {
      state.commandTokens.clear();
      state.registeredCommands = [];
      state.handler = null;
    }
    accountStates.clear();
  }
}
function registerSlashCommandRoute(api) {
  const mmConfig = api.config.channels?.mattermost;
  const callbackPaths = /* @__PURE__ */ new Set();
  const addCallbackPaths = (raw) => {
    const resolved = resolveSlashCommandConfig(raw);
    callbackPaths.add(resolved.callbackPath);
    if (resolved.callbackUrl) {
      try {
        const urlPath = new URL(resolved.callbackUrl).pathname;
        if (urlPath && urlPath !== resolved.callbackPath) {
          callbackPaths.add(urlPath);
        }
      } catch {
      }
    }
  };
  const commandsRaw = mmConfig?.commands;
  addCallbackPaths(commandsRaw);
  const accountsRaw = mmConfig?.accounts ?? {};
  for (const accountId of Object.keys(accountsRaw)) {
    const accountCfg = accountsRaw[accountId];
    const accountCommandsRaw = accountCfg?.commands;
    addCallbackPaths(accountCommandsRaw);
  }
  const routeHandler = async (req, res) => {
    if (accountStates.size === 0) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Slash commands are not yet initialized. Please try again in a moment."
        })
      );
      return;
    }
    if (accountStates.size === 1) {
      const [, state] = [...accountStates.entries()][0];
      if (!state.handler) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            response_type: "ephemeral",
            text: "Slash commands are not yet initialized. Please try again in a moment."
          })
        );
        return;
      }
      await state.handler(req, res);
      return;
    }
    const chunks = [];
    const MAX_BODY = 64 * 1024;
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      chunks.push(chunk);
    }
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    let token = null;
    const ct = req.headers["content-type"] ?? "";
    try {
      if (ct.includes("application/json")) {
        token = JSON.parse(bodyStr).token ?? null;
      } else {
        token = new URLSearchParams(bodyStr).get("token");
      }
    } catch {
    }
    const match = token ? resolveSlashHandlerForToken(token) : { kind: "none" };
    if (match.kind === "none") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Unauthorized: invalid command token."
        })
      );
      return;
    }
    if (match.kind === "ambiguous") {
      api.logger.warn?.(
        `mattermost: slash callback token matched multiple accounts (${match.accountIds?.join(", ")})`
      );
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          response_type: "ephemeral",
          text: "Conflict: command token is not unique across accounts."
        })
      );
      return;
    }
    const matchedHandler = match.handler;
    const { Readable } = await import("node:stream");
    const syntheticReq = new Readable({
      read() {
        this.push(Buffer.from(bodyStr, "utf8"));
        this.push(null);
      }
    });
    syntheticReq.method = req.method;
    syntheticReq.url = req.url;
    syntheticReq.headers = req.headers;
    await matchedHandler(syntheticReq, res);
  };
  for (const callbackPath of callbackPaths) {
    api.registerHttpRoute({
      path: callbackPath,
      auth: "plugin",
      handler: routeHandler
    });
    api.logger.info?.(`mattermost: registered slash command callback at ${callbackPath}`);
  }
}
export {
  activateSlashCommands,
  deactivateSlashCommands,
  getAllSlashCommandStates,
  getSlashCommandState,
  registerSlashCommandRoute,
  resolveSlashHandlerForToken
};

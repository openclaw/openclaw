/**
 * life-memory-scope — per-user identity hook for the `life` agent's Graphiti memory.
 *
 * Registers a `before_tool_call` hook that HARD-PINS the memory scope for every
 * `mcp__graphiti__*` tool call. The gateway merges this hook's returned params
 * OVER the model's params, so the model can never choose, widen, or omit the
 * scope — it is resolved server-side from the session identity.
 *
 * Canonical group id (RediSearch-safe: [A-Za-z0-9_] only):
 *   - app users     → app_<appUserId>     (appUserId from the session entry)
 *   - telegram DMs  → tg_<peerId>         (peer parsed from the sessionKey;
 *                                          requires session.dmScope = per-peer)
 *   - otherwise     → BLOCK the call (fail closed; no memory beats wrong memory)
 *
 * Pairs with graphiti-proxy.js, which reads `__group_id` and forces it onto
 * Graphiti's group_id/group_ids (and refuses calls without it).
 */

const UNSAFE = /[^A-Za-z0-9_]/g;
const sanitize = (s) => String(s).trim().toLowerCase().replace(UNSAFE, "_");

// Lazily import the gateway's loadSessionEntry (for app-user appUserId).
// Coupled to this gateway image; degrades gracefully (telegram still works).
let _loader; // undefined = not tried, false = unavailable, fn = ready
async function getLoader(logger) {
  if (_loader !== undefined) return _loader;
  for (const p of ["/app/src/gateway/session-utils.js", "/app/dist/gateway/session-utils.js"]) {
    try {
      const m = await import(p);
      if (m && typeof m.loadSessionEntry === "function") return (_loader = m.loadSessionEntry);
    } catch {
      /* try next */
    }
  }
  logger?.warn?.(
    "[life-memory-scope] loadSessionEntry unavailable — app-user memory disabled (telegram still works)",
  );
  return (_loader = false);
}

function telegramPeerFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  // agent:<id>:telegram:direct:<peer>  or  agent:<id>:direct:<peer>
  const m = sessionKey.match(/:direct:([^:]+)$/);
  return m ? m[1] : null;
}

async function resolveGroupId(sessionKey, logger) {
  // 1) app user (appUserId on the session entry)
  const loader = await getLoader(logger);
  if (loader && sessionKey) {
    try {
      const res = loader(sessionKey);
      const appUserId = res && res.entry ? res.entry.appUserId : undefined;
      if (typeof appUserId === "string" && appUserId.trim()) return "app_" + sanitize(appUserId);
    } catch {
      /* fall through */
    }
  }
  // 2) telegram per-user peer
  const peer = telegramPeerFromSessionKey(sessionKey);
  if (peer) return "tg_" + sanitize(peer);
  // 3) fail closed
  return null;
}

export default {
  id: "life-memory-scope",
  name: "Life Memory Scope",
  description:
    "Pins per-user Graphiti memory scope (__group_id) on every mcp__graphiti__* tool call.",
  version: "1.0.0",

  async activate(api) {
    const logger = api.logger;
    // IMPORTANT: use api.on() (typed hooks → registry.typedHooks), NOT
    // api.registerHook() (file-based internal hooks). The gateway tool-call path
    // (runBeforeToolCallHook → getGlobalHookRunner → hasHooks/getHooksForName)
    // only consults typedHooks, so only api.on() handlers actually fire on tools.
    const handler = async (event, ctx) => {
      const toolName = (event && event.toolName) || (ctx && ctx.toolName) || "";
      if (!toolName.startsWith("mcp__graphiti__")) return; // only scope memory tools
      const sessionKey = ctx && ctx.sessionKey;
      const groupId = await resolveGroupId(sessionKey, logger);
      if (!groupId) {
        logger?.warn?.(
          `[life-memory-scope] no per-user scope for session "${sessionKey}" — blocking ${toolName}`,
        );
        return {
          block: true,
          blockReason: "memory unavailable: no per-user scope for this session",
        };
      }
      logger?.debug?.(`[life-memory-scope] scoped ${toolName} -> ${groupId}`);
      return { params: { ...(event && event.params ? event.params : {}), __group_id: groupId } };
    };
    if (typeof api.on === "function") {
      api.on("before_tool_call", handler, { priority: 100 });
      logger.info(
        "[life-memory-scope] before_tool_call typed hook registered via api.on (pins __group_id)",
      );
    } else {
      api.registerHook("before_tool_call", handler, { name: "pin-graphiti-group", priority: 100 });
      logger.warn("[life-memory-scope] api.on unavailable — fell back to registerHook");
    }
  },
};

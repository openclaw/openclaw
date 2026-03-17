import { ApiClient } from "@twurple/api";
import { StaticAuthProvider } from "@twurple/auth";
import { normalizeToken } from "./utils/twitch.js";
function normalizeUsername(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) {
    return trimmed.slice(1).toLowerCase();
  }
  return trimmed.toLowerCase();
}
function createLogger(logger) {
  return {
    info: (msg) => logger?.info(msg),
    warn: (msg) => logger?.warn(msg),
    error: (msg) => logger?.error(msg),
    debug: (msg) => logger?.debug?.(msg) ?? (() => {
    })
  };
}
async function resolveTwitchTargets(inputs, account, kind, logger) {
  const log = createLogger(logger);
  if (!account.clientId || !account.accessToken) {
    log.error("Missing Twitch client ID or accessToken");
    return inputs.map((input) => ({
      input,
      resolved: false,
      note: "missing Twitch credentials"
    }));
  }
  const normalizedToken = normalizeToken(account.accessToken);
  const authProvider = new StaticAuthProvider(account.clientId, normalizedToken);
  const apiClient = new ApiClient({ authProvider });
  const results = [];
  for (const input of inputs) {
    const normalized = normalizeUsername(input);
    if (!normalized) {
      results.push({
        input,
        resolved: false,
        note: "empty input"
      });
      continue;
    }
    const looksLikeUserId = /^\d+$/.test(normalized);
    try {
      if (looksLikeUserId) {
        const user = await apiClient.users.getUserById(normalized);
        if (user) {
          results.push({
            input,
            resolved: true,
            id: user.id,
            name: user.name
          });
          log.debug?.(`Resolved user ID ${normalized} -> ${user.name}`);
        } else {
          results.push({
            input,
            resolved: false,
            note: "user ID not found"
          });
          log.warn(`User ID ${normalized} not found`);
        }
      } else {
        const user = await apiClient.users.getUserByName(normalized);
        if (user) {
          results.push({
            input,
            resolved: true,
            id: user.id,
            name: user.name,
            note: user.displayName !== user.name ? `display: ${user.displayName}` : void 0
          });
          log.debug?.(`Resolved username ${normalized} -> ${user.id} (${user.name})`);
        } else {
          results.push({
            input,
            resolved: false,
            note: "username not found"
          });
          log.warn(`Username ${normalized} not found`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        input,
        resolved: false,
        note: `API error: ${errorMessage}`
      });
      log.error(`Failed to resolve ${input}: ${errorMessage}`);
    }
  }
  return results;
}
export {
  resolveTwitchTargets
};

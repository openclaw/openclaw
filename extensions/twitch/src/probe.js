import { StaticAuthProvider } from "@twurple/auth";
import { ChatClient } from "@twurple/chat";
import { normalizeToken } from "./utils/twitch.js";
async function probeTwitch(account, timeoutMs) {
  const started = Date.now();
  if (!account.accessToken || !account.username) {
    return {
      ok: false,
      error: "missing credentials (accessToken, username)",
      username: account.username,
      elapsedMs: Date.now() - started
    };
  }
  const rawToken = normalizeToken(account.accessToken.trim());
  let client;
  try {
    const authProvider = new StaticAuthProvider(account.clientId ?? "", rawToken);
    client = new ChatClient({
      authProvider
    });
    const connectionPromise = new Promise((resolve, reject) => {
      let settled = false;
      let connectListener;
      let disconnectListener;
      let authFailListener;
      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        connectListener?.unbind();
        disconnectListener?.unbind();
        authFailListener?.unbind();
      };
      connectListener = client?.onConnect(() => {
        cleanup();
        resolve();
      });
      disconnectListener = client?.onDisconnect((_manually, reason) => {
        cleanup();
        reject(reason || new Error("Disconnected"));
      });
      authFailListener = client?.onAuthenticationFailure(() => {
        cleanup();
        reject(new Error("Authentication failed"));
      });
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    client.connect();
    await Promise.race([connectionPromise, timeout]);
    client.quit();
    client = void 0;
    return {
      ok: true,
      connected: true,
      username: account.username,
      channel: account.channel,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      username: account.username,
      channel: account.channel,
      elapsedMs: Date.now() - started
    };
  } finally {
    if (client) {
      try {
        client.quit();
      } catch {
      }
    }
  }
}
export {
  probeTwitch
};

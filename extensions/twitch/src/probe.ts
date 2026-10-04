import { StaticAuthProvider } from "@twurple/auth";
import { ChatClient } from "@twurple/chat";
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { TwitchAccountConfig } from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

type ProbeTwitchResult = BaseProbeResult<string> & {
  username?: string;
  elapsedMs: number;
  connected?: boolean;
  channel?: string;
};

export async function probeTwitch(
  account: TwitchAccountConfig,
  timeoutMs: number,
): Promise<ProbeTwitchResult> {
  let client: ChatClient | undefined;
  try {
    return await runChannelProbe(
      undefined,
      async () => {
        if (!account.accessToken || !account.username) {
          return {
            ok: false,
            error: "missing credentials (accessToken, username)",
            username: account.username,
          };
        }

        const rawToken = normalizeToken(account.accessToken.trim());
        const authProvider = new StaticAuthProvider(account.clientId ?? "", rawToken);

        const probeClient = new ChatClient({ authProvider });
        client = probeClient;

        const connectionPromise = new Promise<void>((resolve, reject) => {
          let settled = false;

          const cleanup = () => {
            if (settled) {
              return;
            }
            settled = true;
            connectListener?.unbind();
            disconnectListener?.unbind();
            authFailListener?.unbind();
          };

          const connectListener: ReturnType<ChatClient["onConnect"]> | undefined =
            client?.onConnect(() => {
              cleanup();
              resolve();
            });

          const disconnectListener: ReturnType<ChatClient["onDisconnect"]> | undefined =
            client?.onDisconnect((_manually, reason) => {
              cleanup();
              reject(reason || new Error("Disconnected"));
            });

          const authFailListener: ReturnType<ChatClient["onAuthenticationFailure"]> | undefined =
            client?.onAuthenticationFailure(() => {
              cleanup();
              reject(new Error("Authentication failed"));
            });
        });

        await raceWithTimeout(
          () => {
            probeClient.connect();
            return connectionPromise;
          },
          timeoutMs,
          () => {
            throw new Error(`timeout after ${timeoutMs}ms`);
          },
        );

        client.quit();
        client = undefined;

        return {
          ok: true,
          connected: true,
          username: account.username,
          channel: account.channel,
        };
      },
      (error) => ({
        ok: false,
        error: formatErrorMessage(error),
        username: account.username,
        channel: account.channel,
      }),
    );
  } finally {
    if (client) {
      try {
        client.quit();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

import { StaticAuthProvider, type AuthProvider } from "@twurple/auth";
import { ChatClient, LogLevel } from "@twurple/chat";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-resolution";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { TWITCH_CHAT_MESSAGE_LIMIT } from "./constants.js";
import { createManagedTwitchAuthProvider } from "./oauth-owner.js";
import { resolveTwitchToken } from "./token.js";
import type {
  ChannelAccountSnapshot,
  ChannelLogSink,
  TwitchAccountConfig,
  TwitchChatMessage,
} from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

export class TwitchClientManager {
  // The registry gives each account its own manager and transport lifetime.
  private client: ChatClient | undefined;
  private pendingClient: ChatClient | undefined;
  private connectionPromise: Promise<ChatClient> | undefined;
  private messageHandler: { handler: (message: TwitchChatMessage) => void } | undefined;

  constructor(
    private logger: ChannelLogSink,
    private statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void,
  ) {}

  setStatusSink(statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void): void {
    if (statusSink) {
      this.statusSink = statusSink;
    }
  }

  private publishReady(): void {
    this.statusSink?.(channelReadyPatch());
  }

  private publishRecovering(lastError: string): void {
    this.statusSink?.({ connected: false, lifecycle: "recovering", lastError });
  }

  async getClient(
    account: TwitchAccountConfig,
    cfg?: OpenClawConfig,
    accountId?: string,
  ): Promise<ChatClient> {
    if (this.client) {
      return this.client;
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    const connection: Promise<ChatClient> = this.createConnectedClient(
      account,
      () => this.connectionPromise === connection,
      cfg,
      accountId,
    );
    this.connectionPromise = connection;
    try {
      return await connection;
    } finally {
      if (this.connectionPromise === connection) {
        this.connectionPromise = undefined;
      }
    }
  }

  private async createConnectedClient(
    account: TwitchAccountConfig,
    ownsConnection: () => boolean,
    cfg?: OpenClawConfig,
    accountId?: string,
  ): Promise<ChatClient> {
    const tokenResolution = resolveTwitchToken(cfg, accountId);

    if (!tokenResolution.token) {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const tokenConfigPath = cfg?.channels?.twitch?.accounts
        ? `channels.twitch.accounts.${resolvedAccountId}.accessToken`
        : "channels.twitch.accessToken";
      throw new Error(
        `Missing Twitch token for account ${resolvedAccountId} (set ${tokenConfigPath} or OPENCLAW_TWITCH_ACCESS_TOKEN for default)`,
      );
    }

    if (!account.clientId) {
      throw new Error(`Missing Twitch client ID for account ${account.username}`);
    }

    const normalizedToken = normalizeToken(tokenResolution.token);

    const clientId = account.clientId;
    const authProvider: AuthProvider = await (account.clientSecret && account.refreshToken
      ? createManagedTwitchAuthProvider(account, normalizedToken, accountId)
      : new StaticAuthProvider(clientId, normalizedToken));
    if (!ownsConnection()) {
      throw new Error(`Twitch connection cancelled for ${account.username}`);
    }

    const client = new ChatClient({
      authProvider,
      channels: [account.channel],
      rejoinChannelsOnReconnect: true,
      requestMembershipEvents: true,
      logger: {
        minLevel: LogLevel.WARNING,
        custom: {
          log: (level, message) => {
            switch (level) {
              case LogLevel.CRITICAL:
              case LogLevel.ERROR:
                // ircv3 parser errors can quote the raw incoming line or parameter.
                this.logger.error(
                  message.startsWith("Error parsing message: ")
                    ? "Twitch IRC message parsing failed"
                    : message,
                );
                break;
              case LogLevel.WARNING:
                this.logger.warn(message);
                break;
              case LogLevel.INFO:
                this.logger.info(message);
                break;
              case LogLevel.DEBUG:
              case LogLevel.TRACE:
                this.logger.debug?.(message);
                break;
            }
          },
        },
      },
    });

    this.pendingClient = client;
    try {
      const connectTimeoutMs = 15000;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let authRetryPending = false;
        const listeners: Array<{ unbind: () => void }> = [];
        const finish = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          for (const listener of listeners) {
            listener.unbind();
          }
          if (error) {
            try {
              client.quit();
            } catch {
              // Best effort: connection setup already failed.
            }
            reject(error);
            return;
          }
          resolve();
        };
        listeners.push(
          client.onAuthenticationSuccess(() => {
            this.publishReady();
            finish();
          }),
          client.onAuthenticationFailure((text) => {
            authRetryPending = true;
            this.publishRecovering(text);
            this.logger.warn(
              `Twitch authentication failed for ${account.username}; waiting for retry, disconnect, or timeout: ${text}`,
            );
          }),
          client.onDisconnect((manual, reason) => {
            if (!manual) {
              this.publishRecovering(
                reason ? formatErrorMessage(reason) : "Twitch connection lost",
              );
            }
            if (authRetryPending && !manual) {
              return;
            }
            finish(
              reason ??
                new Error(
                  manual
                    ? `Twitch connection cancelled for ${account.username}`
                    : `Twitch disconnected before ready for ${account.username}`,
                ),
            );
          }),
        );
        const timeout = setTimeout(
          () => finish(new Error(`Timed out connecting to Twitch as ${account.username}`)),
          connectTimeoutMs,
        );
        timeout.unref?.();
        try {
          client.connect();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (this.pendingClient !== client) {
        client.quit();
        throw new Error(`Twitch connection cancelled for ${account.username}`);
      }
    } finally {
      if (this.pendingClient === client) {
        this.pendingClient = undefined;
      }
    }

    client.onMessage((channelName, _user, messageText, msg) => {
      const handler = this.messageHandler?.handler;
      if (handler) {
        handler({
          username: msg.userInfo.userName,
          displayName: msg.userInfo.displayName,
          userId: msg.userInfo.userId,
          message: messageText,
          // Preserve the raw callback channel; durable dispatch normalizes it.
          channel: channelName,
          id: msg.id,
          timestamp: Date.now(),
          isMod: msg.userInfo.isMod,
          isOwner: msg.userInfo.isBroadcaster,
          isVip: msg.userInfo.isVip,
          isSub: msg.userInfo.isSubscriber,
          chatType: "group",
        });
      }
    });
    client.onAuthenticationSuccess(() => this.publishReady());
    client.onAuthenticationFailure((text) => {
      this.publishRecovering(text);
    });
    client.onDisconnect((manual, reason) => {
      if (!manual) {
        this.publishRecovering(reason ? formatErrorMessage(reason) : "Twitch connection lost");
      }
    });
    this.client = client;
    this.logger.info(`Connected to Twitch as ${account.username}`);

    return client;
  }

  onMessage(handler: (message: TwitchChatMessage) => void): () => void {
    const registration = { handler };
    this.messageHandler = registration;
    return () => {
      // Only remove the exact registration this cleanup closure owns. A later
      // onMessage() may reuse the same callback function for the same account.
      if (this.messageHandler === registration) {
        this.messageHandler = undefined;
      }
    };
  }

  async disconnectAll(): Promise<void> {
    this.pendingClient?.quit();
    this.client?.quit();
    this.pendingClient = undefined;
    this.connectionPromise = undefined;
    this.client = undefined;
    this.messageHandler = undefined;
  }

  async sendMessage(
    account: TwitchAccountConfig,
    channel: string,
    message: string,
    cfg?: OpenClawConfig,
    accountId?: string,
  ): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
    const effect = captureEffectAuthority();
    let preparingUse = false;
    try {
      const client = await this.getClient(account, cfg, accountId);

      // Twurple say() does not return a provider message ID.
      const messageId = crypto.randomUUID();

      // Prechunk before Twurple's raw UTF-16 fallback can split surrogate pairs.
      const chunks = chunkTextForOutbound(message, TWITCH_CHAT_MESSAGE_LIMIT);
      preparingUse = true;
      const results = await effect.initiate(() => {
        preparingUse = false;
        // Admit the whole prechunked message before any SDK call. Twurple owns
        // rate limiting after these synchronous handoffs; responses do not hold authority.
        return Promise.allSettled(chunks.map(async (chunk) => client.say(channel, chunk)));
      });
      const failure = results.find((result) => result.status === "rejected");
      if (failure) {
        if (results.some((result) => result.status === "fulfilled")) {
          throw createChannelPartialDeliveryError(failure.reason, {
            messageIds: [messageId],
            visibleReplySent: true,
          });
        }
        throw failure.reason;
      }

      return { ok: true, messageId };
    } catch (error) {
      if (preparingUse || isChannelPartialDeliveryError(error)) {
        throw error;
      }
      const errorMessage = formatErrorMessage(error);
      return { ok: false, error: errorMessage };
    }
  }
}

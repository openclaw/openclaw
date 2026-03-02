/**
 * UserbotClient -- GramJS TelegramClient wrapper for the telegram-userbot channel.
 *
 * Provides typed methods for all Telegram user API operations needed by OpenClaw:
 * send, sendFile, edit, delete, forward, react, pin, getHistory, setTyping, etc.
 *
 * Error handling: every public method wraps GramJS exceptions via wrapGramJSError()
 * so callers always receive typed UserbotError instances.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { wrapGramJSError, UserbotDisconnectedError } from "./errors.js";
import { resolvePeer } from "./peer.js";
import type {
  UserbotClientConfig,
  InteractiveAuthParams,
  SendResult,
  SendMessageOptions,
  SendFileOptions,
  PeerResolvable,
  GramMessage,
} from "./types.js";

const DEFAULT_CONNECTION_RETRIES = 5;

export class UserbotClient {
  private readonly gramClient: TelegramClient;
  private connected = false;

  constructor(config: UserbotClientConfig) {
    const session = new StringSession(config.session ?? "");
    this.gramClient = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: config.connectionRetries ?? DEFAULT_CONNECTION_RETRIES,
    });
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect using an existing session string.
   * The session must already be authenticated (from a prior connectInteractive).
   */
  async connect(): Promise<void> {
    try {
      await this.gramClient.connect();
      this.connected = true;
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /**
   * Perform interactive authentication (first-time setup).
   *
   * Creates a fresh GramJS session and calls client.start() which prompts
   * for code and optional 2FA password via the provided callbacks.
   */
  async connectInteractive(params: InteractiveAuthParams): Promise<void> {
    try {
      await this.gramClient.start({
        phoneNumber: () => Promise.resolve(params.phone),
        phoneCode: params.codeCallback,
        password: params.passwordCallback ?? (() => Promise.resolve("")),
        onError: (err: Error) => {
          // GramJS calls onError for non-fatal auth issues; let it retry internally
          console.error("[telegram-userbot] auth error:", err.message);
        },
      });
      this.connected = true;
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Disconnect cleanly from Telegram. */
  async disconnect(): Promise<void> {
    try {
      await this.gramClient.disconnect();
    } catch (err) {
      throw wrapGramJSError(err);
    } finally {
      this.connected = false;
    }
  }

  /** Whether the client is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Session & user info
  // ---------------------------------------------------------------------------

  /** Get self-user info (id, firstName, username, etc.). */
  async getMe(): Promise<Api.User> {
    this.assertConnected();
    try {
      return (await this.gramClient.getMe()) as Api.User;
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /**
   * Export the current session as a string for persistence.
   * Save this value and pass it back as `config.session` to reconnect
   * without re-authenticating.
   */
  getSessionString(): string {
    const session = this.gramClient.session as StringSession;
    return session.save() as unknown as string;
  }

  /**
   * Access the underlying TelegramClient.
   * Used by TASK-07 (event handler) to attach NewMessage handlers.
   */
  getClient(): TelegramClient {
    return this.gramClient;
  }

  // ---------------------------------------------------------------------------
  // Message operations
  // ---------------------------------------------------------------------------

  /** Send a text message to a peer. */
  async sendMessage(
    peer: PeerResolvable,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<SendResult> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      const result = await this.gramClient.sendMessage(inputPeer, {
        message: text,
        replyTo: opts?.replyTo,
        parseMode: opts?.parseMode,
      });
      return toSendResult(result);
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Send a file (photo, document, voice note, etc.) to a peer. */
  async sendFile(
    peer: PeerResolvable,
    file: string | Buffer,
    opts?: SendFileOptions,
  ): Promise<SendResult> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      const result = await this.gramClient.sendFile(inputPeer, {
        file,
        caption: opts?.caption,
        forceDocument: opts?.forceDocument,
        voiceNote: opts?.voiceNote,
        replyTo: opts?.replyTo,
        parseMode: opts?.parseMode,
      });
      return toSendResult(result);
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Edit an existing message's text. */
  async editMessage(peer: PeerResolvable, messageId: number, text: string): Promise<void> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      await this.gramClient.editMessage(inputPeer, {
        message: messageId,
        text,
      });
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Delete messages in a chat. Revokes for all participants by default. */
  async deleteMessages(
    peer: PeerResolvable,
    messageIds: number[],
    revoke?: boolean,
  ): Promise<void> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      await this.gramClient.deleteMessages(inputPeer, messageIds, {
        revoke: revoke ?? true,
      });
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Forward messages from one peer to another. */
  async forwardMessages(
    fromPeer: PeerResolvable,
    toPeer: PeerResolvable,
    messageIds: number[],
  ): Promise<void> {
    this.assertConnected();
    try {
      const resolvedFrom = await resolvePeer(this.gramClient, fromPeer);
      const resolvedTo = await resolvePeer(this.gramClient, toPeer);
      await this.gramClient.forwardMessages(resolvedTo, {
        messages: messageIds,
        fromPeer: resolvedFrom,
      });
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** React to a message with an emoji. */
  async reactToMessage(peer: PeerResolvable, messageId: number, emoji: string): Promise<void> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      await this.gramClient.invoke(
        new Api.messages.SendReaction({
          peer: inputPeer,
          msgId: messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
        }),
      );
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Pin a message in a chat. */
  async pinMessage(peer: PeerResolvable, messageId: number): Promise<void> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      await this.gramClient.pinMessage(inputPeer, messageId);
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Fetch recent message history from a peer. */
  async getHistory(peer: PeerResolvable, limit?: number): Promise<GramMessage[]> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      const messages = await this.gramClient.getMessages(inputPeer, {
        limit: limit ?? 20,
      });
      return [...messages];
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  /** Set typing indicator in a peer chat. */
  async setTyping(peer: PeerResolvable, action?: Api.TypeSendMessageAction): Promise<void> {
    this.assertConnected();
    try {
      const inputPeer = await resolvePeer(this.gramClient, peer);
      await this.gramClient.invoke(
        new Api.messages.SetTyping({
          peer: inputPeer,
          action: action ?? new Api.SendMessageTypingAction(),
        }),
      );
    } catch (err) {
      throw wrapGramJSError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Throw if client is not connected. */
  private assertConnected(): void {
    if (!this.connected) {
      throw new UserbotDisconnectedError("Client is not connected");
    }
  }
}

/** Extract messageId and date from a GramJS Message. */
function toSendResult(msg: GramMessage): SendResult {
  return {
    messageId: msg.id,
    date: msg.date,
  };
}

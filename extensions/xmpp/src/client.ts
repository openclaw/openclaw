import { client, xml, type XMLElement } from "@xmpp/client";
import { jid as parseJid } from "@xmpp/jid";
import type { XmppAccountConfig } from "./types.js";
import type { DiscoInfoResult, DiscoItemsResult } from "./xep0030.js";
import type { HttpUploadSlot, HttpUploadSlotRequest } from "./xep0363.js";
import type { MessageReactions } from "./xep0444.js";
import { XEP0363_FEATURE } from "./xep0363.js";

/**
 * Default blocked media types (executable files, scripts, etc.)
 * Prevents uploading potentially dangerous file types that could be auto-executed
 */
export const DEFAULT_BLOCKED_MEDIA_TYPES = [
  "application/x-msdownload", // .exe
  "application/x-executable", // Linux executables
  "application/x-mach-binary", // macOS executables
  "application/x-sh", // Shell scripts
  "application/x-bash", // Bash scripts
  "application/x-csh", // C shell scripts
  "application/x-tcl", // Tcl scripts
  "application/x-perl", // Perl scripts
  "application/x-python-code", // Python bytecode
  "application/x-bat", // Windows batch files
  "application/x-dosexec", // DOS executables
  "text/x-shellscript", // Shell scripts
  "application/vnd.microsoft.portable-executable", // PE executables
];

export interface XmppMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: Date;
  type: "chat" | "groupchat";
  links?: Array<{ url?: string; description?: string }>;
  reactions?: MessageReactions;
  thread?: string;
  parentThread?: string;
}

export interface XmppRoomMessage extends XmppMessage {
  type: "groupchat";
  nick?: string;
  roomJid: string;
}

// Type definition for xmpp.js client
type XmppJsClient = ReturnType<typeof client> & {
  status?: string;
};

export class XmppClient {
  private xmpp: XmppJsClient;
  private connected = false;
  private messageHandlers: Array<(message: XmppMessage | XmppRoomMessage) => void> = [];
  private subscriptionRequestHandlers: Array<(jid: string) => void | Promise<void>> = [];
  private currentJid: string = "";
  private joinedRooms: Set<string> = new Set();
  private httpUploadService: string | null = null;

  constructor(private config: XmppAccountConfig) {
    // Determine service URL based on server format
    let service: string;
    if (config.server.startsWith("wss://") || config.server.startsWith("ws://")) {
      // WebSocket URL - use as-is
      service = config.server;
    } else if (config.server.startsWith("xmpp://") || config.server.startsWith("xmpps://")) {
      // TCP URL with explicit protocol - use as-is
      service = config.server;
    } else {
      // Plain hostname - assume TCP with STARTTLS (xmpp:// scheme, default port 5222)
      service = `xmpp://${config.server}`;
    }

    // Extract domain from JID (user@domain format)
    const domain = config.jid.split("@")[1];
    const username = config.jid.split("@")[0];

    this.xmpp = client({
      service,
      domain,
      username,
      password: config.password,
      resource: config.resource || "openclaw",
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // xmpp.js uses "online" event when session is established
    this.xmpp.on("online", async (address: unknown) => {
      this.connected = true;
      this.currentJid = (address as { toString(): string }).toString();
      console.log(`[XMPP] Session started for ${this.currentJid}`);

      // Send initial presence
      await this.xmpp.send(xml("presence"));
    });

    // xmpp.js uses "offline" event for disconnection
    this.xmpp.on("offline", () => {
      this.connected = false;
      // Clear joined rooms on disconnect (will need to rejoin on reconnect)
      this.joinedRooms.clear();
      this.currentJid = "";
      this.httpUploadService = null;
      console.log(`[XMPP] Disconnected from ${this.config.jid}`);
    });

    // xmpp.js uses "stanza" event for all incoming stanzas
    this.xmpp.on("stanza", (stanza) => {
      if (stanza.is("message")) {
        this.handleMessageStanza(stanza);
      } else if (stanza.is("presence")) {
        this.handlePresenceStanza(stanza);
      }
    });

    // Error handling
    this.xmpp.on("error", (error: Error) => {
      console.error(`[XMPP] Error:`, error);
    });
  }

  /**
   * Extract message body and Out of Band Data (XEP-0066) links
   */
  private extractMessageContent(stanza: XMLElement): {
    body: string;
    links: Array<{ url?: string; description?: string }>;
  } {
    const bodyElement = stanza.getChild("body");
    const body = bodyElement?.getText() || "";

    const oobElement = stanza.getChild("x", "jabber:x:oob");
    const links: Array<{ url?: string; description?: string }> = [];
    if (oobElement) {
      const urlElement = oobElement.getChild("url");
      const descElement = oobElement.getChild("desc");
      if (urlElement) {
        links.push({
          url: urlElement.getText(),
          description: descElement?.getText(),
        });
      }
    }

    return { body, links };
  }

  /**
   * Extract message reactions (XEP-0444)
   */
  private extractMessageReactions(stanza: XMLElement): MessageReactions | undefined {
    const reactionsElement = stanza.getChild("reactions", "urn:xmpp:reactions:0");
    if (!reactionsElement) {
      return undefined;
    }

    const reactionId = reactionsElement.attrs.id;
    const reactionElements = reactionsElement.getChildren("reaction");
    const reactionList = reactionElements
      .map((el) => el.getText())
      .filter((text): text is string => Boolean(text));

    if (reactionId && reactionList.length > 0) {
      return {
        id: reactionId,
        reactions: reactionList,
      };
    }

    return undefined;
  }

  /**
   * Extract thread information
   */
  private extractThreadInfo(stanza: XMLElement): {
    thread?: string;
    parentThread?: string;
  } {
    const threadElement = stanza.getChild("thread");
    return {
      thread: threadElement?.getText(),
      parentThread: threadElement?.attrs?.parent,
    };
  }

  /**
   * Build XMPP message object from extracted data
   */
  private buildXmppMessage(
    from: string,
    to: string,
    id: string,
    type: string,
    body: string,
    links: Array<{ url?: string; description?: string }>,
    reactions: MessageReactions | undefined,
    thread?: string,
    parentThread?: string,
  ): XmppMessage | XmppRoomMessage {
    const isGroupChat = type === "groupchat";
    const message: XmppMessage | XmppRoomMessage = {
      id,
      from,
      to,
      body,
      timestamp: new Date(),
      type: isGroupChat ? "groupchat" : "chat",
      links: links.length > 0 ? links : undefined,
      reactions,
      thread,
      parentThread,
    };

    if (isGroupChat) {
      const parsed = parseJid(from);
      (message as XmppRoomMessage).roomJid = parsed.bare().toString();
      (message as XmppRoomMessage).nick = parsed.resource;
    }

    return message;
  }

  private handleMessageStanza(stanza: XMLElement): void {
    const from = stanza.attrs.from;
    const to = stanza.attrs.to;
    const id = stanza.attrs.id || `${Date.now()}`;
    const type = stanza.attrs.type || "chat";

    const { body, links } = this.extractMessageContent(stanza);
    const reactions = this.extractMessageReactions(stanza);
    const { thread, parentThread } = this.extractThreadInfo(stanza);

    // Skip chat state notifications (typing indicators) and messages with no content
    if (!body && links.length === 0 && !reactions) {
      return;
    }
    if (!from) {
      return;
    }

    const message = this.buildXmppMessage(
      from,
      to || "",
      id,
      type,
      body,
      links,
      reactions,
      thread,
      parentThread,
    );

    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private handlePresenceStanza(stanza: XMLElement): void {
    const from = stanza.attrs.from;
    const type = stanza.attrs.type;

    // Handle presence subscription requests
    if (type === "subscribe" && from) {
      void this.handleSubscriptionRequest(from);
    }
  }

  async connect(): Promise<void> {
    await this.xmpp.start();
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      // Leave all MUC rooms gracefully (XEP-0045)
      const roomsToLeave = Array.from(this.joinedRooms);
      for (const roomJid of roomsToLeave) {
        try {
          await this.leaveRoom(roomJid);
          console.log(`[XMPP] Left room: ${roomJid}`);
        } catch (error) {
          // Best effort - continue with other rooms
          console.error(`[XMPP] Failed to leave room ${roomJid}:`, error);
        }
      }

      // Send unavailable presence (RFC 6121)
      try {
        await this.xmpp.send(xml("presence", { type: "unavailable" }));
      } catch (error) {
        // Best effort - presence may fail if connection is already closing
        console.error(`[XMPP] Failed to send unavailable presence:`, error);
      }

      // Give a brief moment for stanzas to be sent
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop the connection and close the stream
      // xmpp.stop() handles proper stream closure (</stream:stream>)
      await this.xmpp.stop();
    } catch (error) {
      // Handle edge cases where parser or socket is already null
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[XMPP] Error during disconnect: ${errorMsg}`);
    } finally {
      // Always mark as disconnected and clear state
      this.connected = false;
      this.joinedRooms.clear();
      this.currentJid = "";
      this.httpUploadService = null;
    }
  }

  async sendMessage(
    to: string,
    body: string,
    type: "chat" | "groupchat" = "chat",
    options?: {
      mediaUrl?: string;
      threadId?: string;
    },
  ): Promise<string> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    const messageId = `msg-${Date.now()}`;
    const message = xml("message", { to, type, id: messageId }, xml("body", {}, body));

    // Add XEP-0066 Out of Band Data for media URL
    if (options?.mediaUrl) {
      message.append(xml("x", { xmlns: "jabber:x:oob" }, xml("url", {}, options.mediaUrl)));
    }

    // Add thread ID if provided
    if (options?.threadId) {
      message.append(xml("thread", {}, options.threadId));
    }

    await this.xmpp.send(message);
    return messageId;
  }

  async sendReaction(
    to: string,
    messageId: string,
    emojis: string[],
    type: "chat" | "groupchat" = "chat",
  ): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    // Build XEP-0444 Message Reactions stanza
    const reactions = xml(
      "reactions",
      { xmlns: "urn:xmpp:reactions:0", id: messageId },
      ...emojis.map((emoji) => xml("reaction", {}, emoji)),
    );

    const message = xml("message", { to, type, id: `reaction-${Date.now()}` }, reactions);

    await this.xmpp.send(message);
  }

  async joinRoom(roomJid: string, nick?: string): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    const nickname = nick || this.config.jid.split("@")[0] || "openclaw";
    const roomJidWithNick = `${roomJid}/${nickname}`;

    // Send presence with XEP-0045 MUC namespace to join room
    try {
      const presence = xml(
        "presence",
        { to: roomJidWithNick },
        xml("x", { xmlns: "http://jabber.org/protocol/muc" }),
      );
      await this.xmpp.send(presence);
      // Track joined rooms
      this.joinedRooms.add(roomJid);
    } catch (error) {
      throw new Error(`Failed to join room ${roomJid}`, { cause: error });
    }
  }

  async leaveRoom(roomJid: string): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    const nickname = this.config.jid.split("@")[0] || "openclaw";
    const roomJidWithNick = `${roomJid}/${nickname}`;

    const presence = xml("presence", { to: roomJidWithNick, type: "unavailable" });
    await this.xmpp.send(presence);
    // Remove from tracked rooms
    this.joinedRooms.delete(roomJid);
  }

  onMessage(handler: (message: XmppMessage | XmppRoomMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onSubscriptionRequest(handler: (jid: string) => void | Promise<void>): void {
    this.subscriptionRequestHandlers.push(handler);
  }

  private async handleSubscriptionRequest(jid: string): Promise<void> {
    for (const handler of this.subscriptionRequestHandlers) {
      await handler(jid);
    }
  }

  async acceptSubscription(jid: string): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }
    // Accept presence subscription
    await this.xmpp.send(xml("presence", { to: jid, type: "subscribed" }));
    // Also subscribe back
    await this.xmpp.send(xml("presence", { to: jid, type: "subscribe" }));
  }

  async rejectSubscription(jid: string): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }
    await this.xmpp.send(xml("presence", { to: jid, type: "unsubscribed" }));
  }

  async requestSubscription(jid: string): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }
    // Request presence subscription from user
    await this.xmpp.send(xml("presence", { to: jid, type: "subscribe" }));
  }

  async sendChatState(
    to: string,
    state: "composing" | "active",
    type: "chat" | "groupchat" = "chat",
  ): Promise<void> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    // Check if xmpp.js client is actually online (not just our flag)
    if (this.xmpp.status !== "online") {
      // Silently skip if not online - chat states are best-effort
      return;
    }

    try {
      // Send XEP-0085 chat state notification
      const message = xml(
        "message",
        { to, type, id: `chatstate-${Date.now()}` },
        xml(state, { xmlns: "http://jabber.org/protocol/chatstates" }),
      );
      await this.xmpp.send(message);
    } catch (error) {
      // Chat states are optional/best-effort, log but don't throw
      // This can fail if connection is being replaced or temporarily unavailable
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[XMPP] Failed to send chat state '${state}' to ${to}: ${errorMsg}`);
    }
  }

  /**
   * XEP-0030: Service Discovery - Query disco#items
   */
  async discoverItems(jid: string): Promise<DiscoItemsResult> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    const iq = xml(
      "iq",
      { type: "get", to: jid, id: `disco-items-${Date.now()}` },
      xml("query", { xmlns: "http://jabber.org/protocol/disco#items" }),
    );

    const response = await this.xmpp.iqCaller.request(iq);
    const query = response.getChild("query", "http://jabber.org/protocol/disco#items");
    if (!query) {
      return { items: [] };
    }

    const itemElements = query.getChildren("item");
    const items = itemElements.map((item) => ({
      jid: item.attrs.jid || "",
      node: item.attrs.node,
      name: item.attrs.name,
    }));

    return { items };
  }

  /**
   * XEP-0030: Service Discovery - Query disco#info
   */
  async discoverInfo(jid: string): Promise<DiscoInfoResult> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    const iq = xml(
      "iq",
      { type: "get", to: jid, id: `disco-info-${Date.now()}` },
      xml("query", { xmlns: "http://jabber.org/protocol/disco#info" }),
    );

    const response = await this.xmpp.iqCaller.request(iq);
    const query = response.getChild("query", "http://jabber.org/protocol/disco#info");
    if (!query) {
      return { identities: [], features: [] };
    }

    const identityElements = query.getChildren("identity");
    const identities = identityElements.map((identity) => ({
      category: identity.attrs.category || "",
      type: identity.attrs.type || "",
      name: identity.attrs.name,
    }));

    const featureElements = query.getChildren("feature");
    const features = featureElements.map((feature) => ({
      var: feature.attrs.var || "",
    }));

    return { identities, features };
  }

  /**
   * Discover HTTP File Upload service (XEP-0363)
   * Returns the JID of the upload service, or null if not found
   */
  async discoverHttpUploadService(): Promise<string | null> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    try {
      // Get domain from JID
      const domain = this.config.jid.split("@")[1];

      // First, query server for items
      const itemsResult = await this.discoverItems(domain);

      // Check each item for HTTP upload feature
      for (const item of itemsResult.items) {
        try {
          const info = await this.discoverInfo(item.jid);
          const hasUploadFeature = info.features.some((f) => f.var === XEP0363_FEATURE);
          if (hasUploadFeature) {
            console.log(`[XMPP] Found HTTP upload service: ${item.jid}`);
            return item.jid;
          }
        } catch {
          // Skip items that don't respond to disco#info
          continue;
        }
      }

      console.log(`[XMPP] No HTTP upload service found on ${domain}`);
      return null;
    } catch (error) {
      console.error(`[XMPP] Failed to discover HTTP upload service:`, error);
      return null;
    }
  }

  /**
   * Validate content type to prevent uploading dangerous files
   */
  private validateContentType(contentType: string | undefined, blockedTypes?: string[]): void {
    if (!contentType) {
      return; // No content type provided, allow
    }

    const blocked = blockedTypes ?? DEFAULT_BLOCKED_MEDIA_TYPES;
    const normalizedType = contentType.toLowerCase().trim();

    // Check exact match
    if (blocked.includes(normalizedType)) {
      throw new Error(`Blocked media type: ${contentType}`);
    }

    // Check pattern match (e.g., "application/x-*")
    for (const pattern of blocked) {
      if (pattern.includes("*")) {
        const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`, "i");
        if (regex.test(normalizedType)) {
          throw new Error(`Blocked media type: ${contentType} (matches pattern: ${pattern})`);
        }
      }
    }
  }

  /**
   * Validate upload URL to prevent SSRF attacks
   */
  private validateUploadUrl(url: string): void {
    try {
      const parsed = new URL(url);

      // Only allow HTTPS and HTTP protocols
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Invalid protocol: ${parsed.protocol}`);
      }

      // Block private/internal IP ranges to prevent SSRF
      const hostname = parsed.hostname.toLowerCase();

      // Localhost checks (IPv4 and IPv6)
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        throw new Error(`Private/internal URL not allowed: ${hostname}`);
      }

      // IPv6 localhost (URL parser returns with brackets)
      if (hostname === "[::1]" || hostname === "[0:0:0:0:0:0:0:1]") {
        throw new Error(`Private/internal URL not allowed: ${hostname}`);
      }

      // Private IPv4 ranges
      if (
        hostname.startsWith("10.") || // 10.0.0.0/8
        hostname.startsWith("192.168.") || // 192.168.0.0/16
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) // 172.16.0.0/12
      ) {
        throw new Error(`Private IPv4 address not allowed: ${hostname}`);
      }

      // Link-local and special-use addresses (IPv4)
      if (hostname.startsWith("169.254.")) {
        // 169.254.0.0/16 (AWS metadata, link-local)
        throw new Error(`Private/link-local address not allowed: ${hostname}`);
      }

      // IPv6 private/link-local ranges (URL parser returns with brackets)
      if (
        hostname.startsWith("[fc00:") || // IPv6 unique local (private)
        hostname.startsWith("[fd00:") || // IPv6 unique local (private)
        hostname.startsWith("[fe80:") || // IPv6 link-local
        hostname.startsWith("[ff0") // IPv6 multicast
      ) {
        throw new Error(`Private/link-local address not allowed: ${hostname}`);
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Invalid URL format: ${url}`, { cause: error });
      }
      throw error;
    }
  }

  /**
   * XEP-0363: Request an HTTP upload slot
   */
  async requestUploadSlot(
    request: HttpUploadSlotRequest,
    blockedMediaTypes?: string[],
  ): Promise<HttpUploadSlot> {
    if (!this.connected) {
      throw new Error("XMPP client not connected");
    }

    // Validate content type to prevent uploading dangerous files
    this.validateContentType(request.contentType, blockedMediaTypes);

    // Discover upload service if not cached
    if (!this.httpUploadService) {
      this.httpUploadService = await this.discoverHttpUploadService();
      if (!this.httpUploadService) {
        throw new Error("HTTP upload service not available on this server");
      }
    }

    // Build slot request
    const requestElement = xml("request", { xmlns: "urn:xmpp:http:upload:0" }, [
      xml("filename", {}, request.filename),
      xml("size", {}, request.size.toString()),
    ]);

    if (request.contentType) {
      requestElement.append(xml("content-type", {}, request.contentType));
    }

    const iq = xml(
      "iq",
      { type: "get", to: this.httpUploadService, id: `upload-slot-${Date.now()}` },
      requestElement,
    );

    try {
      const response = await this.xmpp.iqCaller.request(iq);
      const slot = response.getChild("slot", "urn:xmpp:http:upload:0");
      if (!slot) {
        throw new Error("Invalid upload slot response: missing <slot> element");
      }

      // Extract PUT URL
      const putElement = slot.getChild("put");
      if (!putElement?.attrs?.url) {
        throw new Error("Invalid upload slot response: missing PUT URL");
      }
      const putUrl = putElement.attrs.url;

      // Validate PUT URL to prevent SSRF
      this.validateUploadUrl(putUrl);

      // Extract PUT headers (optional)
      const headers: Record<string, string> = {};
      const headerElements = putElement.getChildren("header");
      for (const headerEl of headerElements) {
        const name = headerEl.attrs.name;
        const value = headerEl.getText();
        if (name && value) {
          headers[name] = value;
        }
      }

      // Extract GET URL
      const getElement = slot.getChild("get");
      if (!getElement?.attrs?.url) {
        throw new Error("Invalid upload slot response: missing GET URL");
      }
      const getUrl = getElement.attrs.url;

      // Validate GET URL to prevent SSRF
      this.validateUploadUrl(getUrl);

      return {
        putUrl,
        getUrl,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    } catch (error) {
      // If the cached service JID fails, try rediscovering
      this.httpUploadService = null;
      throw new Error(
        `Failed to request upload slot: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getJid(): string {
    return this.currentJid || this.config.jid;
  }
}

export function getBareJid(jid: string): string {
  const parsed = parseJid(jid);
  return parsed.bare().toString();
}

export function isGroupJid(jid: string): boolean {
  const bare = getBareJid(jid);
  const parsed = parseJid(bare);
  const domain = parsed.domain;
  const mucPatterns = [
    /^muc\./i,
    /^conference\./i,
    /^rooms?\./i,
    /^groupchat\./i,
    /\.muc\./i,
    /\.conference\./i,
  ];
  return mucPatterns.some((p) => p.test(domain));
}

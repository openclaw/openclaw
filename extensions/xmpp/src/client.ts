import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { client, xml } from "@xmpp/client";
import type { ResolvedXmppAccount } from "./accounts.js";
import { getXmppRuntime } from "./runtime.js";
import type { XmppChatState, XmppInboundMessage } from "./types.js";

type XmppClientEventMap = {
  message: XmppInboundMessage;
  error: Error;
};

type XmppClientEventName = keyof XmppClientEventMap;

type XmppClientListener<E extends XmppClientEventName> = (payload: XmppClientEventMap[E]) => void;

export type XmppSendOptions = {
  type?: "chat" | "groupchat";
  chatState?: XmppChatState;
  requestReceipt?: boolean;
  oobUrls?: { url: string; desc?: string }[];
};

type XmppAnyListener = (payload: XmppClientEventMap[XmppClientEventName]) => void;

export class XmppClient {
  private xmpp: ReturnType<typeof client> | null = null;
  private listeners = new Map<XmppClientEventName, Set<XmppAnyListener>>();
  private pendingIq = new Map<
    string,
    { resolve: (stanza: any) => void; reject: (err: Error) => void }
  >();
  private httpUploadJid: string | null = null;
  private httpUploadMaxBytes: number | null = null;

  constructor(private readonly account: ResolvedXmppAccount) {}

  on<E extends XmppClientEventName>(event: E, handler: XmppClientListener<E>): () => void {
    const listener = handler as unknown as XmppAnyListener;
    const existing = this.listeners.get(event);
    if (existing) {
      existing.add(listener);
    } else {
      this.listeners.set(event, new Set<XmppAnyListener>([listener]));
    }
    return () => {
      const set = this.listeners.get(event);
      set?.delete(listener);
    };
  }

  private emit<E extends XmppClientEventName>(event: E, payload: XmppClientEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const handler of set) {
      try {
        handler(payload);
      } catch {
        // Swallow listener errors to avoid breaking client.
      }
    }
  }

  async connect(): Promise<void> {
    if (this.xmpp) {
      return;
    }

    const runtime = getXmppRuntime();
    const jid = this.account.jid;
    const [localPart, domain] = jid.split("@");
    const serviceDomain = this.account.domain ?? domain;
    const useDirectTls = this.account.tlsMode === "tls";
    const service = `${useDirectTls ? "xmpps" : "xmpp"}://${this.account.server}:${
      this.account.port
    }`;

    const xmppClient = client({
      service,
      domain: serviceDomain,
      resource: this.account.resource,
      username: localPart,
      password: this.account.password,
    });

    runtime.log?.(
      `[${this.account.accountId}] xmpp: connecting as ${jid} to ${service} (domain=${serviceDomain})`,
    );

    xmppClient.on("online", (address: any) => {
      runtime.log?.(
        `[${this.account.accountId}] xmpp: online as ${String(address)}; sending initial presence`,
      );
      void xmppClient.send(xml("presence"));
    });

    xmppClient.on("stanza", (stanza: any) => {
      this.handleStanza(stanza);
    });

    xmppClient.on("error", (err: Error) => {
      runtime.error?.(
        `[${this.account.accountId}] xmpp: client error: ${
          (err as { message?: string })?.message ?? String(err)
        }`,
      );
      this.emit("error", err);
    });

    this.xmpp = xmppClient;
    try {
      await xmppClient.start();
      runtime.log?.(
        `[${this.account.accountId}] xmpp: connected as ${jid} to ${service} (resource=${this.account.resource})`,
      );
    } catch (err) {
      runtime.error?.(
        `[${this.account.accountId}] xmpp: failed to connect as ${jid} to ${service}: ${
          (err as { message?: string })?.message ?? String(err)
        }`,
      );
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.xmpp) {
      return;
    }
    const current = this.xmpp;
    this.xmpp = null;
    try {
      await current.stop();
    } catch {
      // Ignore disconnect errors.
    }
  }

  async sendMessage(to: string, body: string, options?: XmppSendOptions): Promise<string> {
    if (!this.xmpp) {
      await this.connect();
    }
    if (!this.xmpp) {
      throw new Error("XMPP client not connected");
    }
    const runtime = getXmppRuntime();
    const messageId = this.generateMessageId();
    const children: any[] = [xml("body", {}, body)];

    if (options?.requestReceipt) {
      children.push(xml("request", { xmlns: "urn:xmpp:receipts" }));
    }

    if (options?.chatState) {
      children.push(xml(options.chatState, { xmlns: "http://jabber.org/protocol/chatstates" }));
    }

    if (options?.oobUrls && options.oobUrls.length > 0) {
      for (const entry of options.oobUrls) {
        const url = entry.url;
        if (!url) {
          continue;
        }
        const desc = entry.desc;
        const oobChildren: any[] = [xml("url", {}, url)];
        if (desc && desc.trim()) {
          oobChildren.push(xml("desc", {}, desc));
        }
        children.push(
          xml(
            "x",
            {
              xmlns: "jabber:x:oob",
            },
            ...oobChildren,
          ),
        );
      }
    }

    const stanza = xml(
      "message",
      {
        type: options?.type ?? "chat",
        to,
        id: messageId,
      },
      ...children,
    );

    await this.xmpp.send(stanza);
    runtime.log?.(
      `[${this.account.accountId}] xmpp: sent message id=${messageId} to=${to} type=${
        options?.type ?? "chat"
      } body=${body.slice(0, 120)}`,
    );
    return messageId;
  }

  async sendChatState(
    to: string,
    state: XmppChatState,
    type: "chat" | "groupchat" = "chat",
  ): Promise<void> {
    if (!this.xmpp) {
      await this.connect();
    }
    if (!this.xmpp) {
      throw new Error("XMPP client not connected");
    }
    const runtime = getXmppRuntime();
    const stanza = xml(
      "message",
      {
        type,
        to,
      },
      xml(state, { xmlns: "http://jabber.org/protocol/chatstates" }),
    );
    await this.xmpp.send(stanza);
    runtime.log?.(
      `[${this.account.accountId}] xmpp: sent chat state state=${state} to=${to} type=${type}`,
    );
  }

  private handleStanza(stanza: any): void {
    if (!stanza || typeof stanza.is !== "function") {
      return;
    }
    if (stanza.is("iq")) {
      const id = String(stanza.attrs?.id ?? "");
      if (id) {
        const pending = this.pendingIq.get(id);
        if (pending) {
          this.pendingIq.delete(id);
          pending.resolve(stanza);
        }
      }
      return;
    }
    if (!stanza.is("message")) {
      return;
    }
    const bodyText = typeof stanza.getChildText === "function" ? stanza.getChildText("body") : null;
    const oobUrls = this.readOobUrls(stanza);

    if ((!bodyText || typeof bodyText !== "string") && oobUrls.length === 0) {
      return;
    }

    const fromJid = String(stanza.attrs?.from ?? "");
    const toJid = String(stanza.attrs?.to ?? "");
    const messageId = String(stanza.attrs?.id ?? this.generateMessageId());
    const isGroup = String(stanza.attrs?.type ?? "") === "groupchat";
    const chatState = this.readChatState(stanza);
    const receiptForId = this.readReceiptId(stanza);

    const hasReceiptRequest =
      typeof stanza.getChild === "function"
        ? Boolean(stanza.getChild("request", "urn:xmpp:receipts"))
        : false;
    if (hasReceiptRequest && this.xmpp && fromJid) {
      const receiptStanza = xml(
        "message",
        {
          to: fromJid,
          id: messageId,
        },
        xml("received", { xmlns: "urn:xmpp:receipts", id: messageId }),
      );
      void this.xmpp.send(receiptStanza);
    }

    const msg: XmppInboundMessage = {
      messageId,
      fromJid,
      toJid,
      body: bodyText ?? "",
      isGroup,
      chatState,
      receiptForId,
      timestamp: Date.now(),
      oobUrls: oobUrls.length > 0 ? oobUrls : undefined,
    };

    const runtime = getXmppRuntime();
    runtime.log?.(
      `[${this.account.accountId}] xmpp: inbound message id=${messageId} from=${fromJid} to=${toJid} type=${
        isGroup ? "group" : "direct"
      } body=${(bodyText ?? "").slice(0, 120)} oob=${oobUrls.length}`,
    );

    this.emit("message", msg);
  }

  private readOobUrls(stanza: any): string[] {
    const urls: string[] = [];
    if (typeof stanza.getChildren === "function") {
      const children = stanza.getChildren("x", "jabber:x:oob");
      for (const child of children) {
        const url = child.getChildText("url");
        if (url) {
          urls.push(String(url).trim());
        }
      }
    }
    return urls;
  }

  private readChatState(stanza: any): XmppChatState | undefined {
    const states: XmppChatState[] = ["active", "composing", "paused", "inactive", "gone"];
    for (const state of states) {
      const child =
        typeof stanza.getChild === "function"
          ? stanza.getChild(state, "http://jabber.org/protocol/chatstates")
          : null;
      if (child) {
        return state;
      }
    }
    return undefined;
  }

  private readReceiptId(stanza: any): string | undefined {
    const received =
      typeof stanza.getChild === "function"
        ? stanza.getChild("received", "urn:xmpp:receipts")
        : null;
    if (!received) {
      return undefined;
    }
    const id = received.attrs?.id;
    return id ? String(id) : undefined;
  }

  private async sendIq(stanza: any): Promise<any> {
    if (!this.xmpp) {
      await this.connect();
    }
    if (!this.xmpp) {
      throw new Error("XMPP client not connected");
    }
    const id = String(stanza.attrs?.id ?? this.generateMessageId());
    stanza.attrs.id = id;
    return await new Promise<any>((resolve, reject) => {
      this.pendingIq.set(id, { resolve, reject });
      void this.xmpp.send(stanza).catch((err: Error) => {
        this.pendingIq.delete(id);
        reject(err);
      });
    });
  }

  private async discoverHttpUploadService(): Promise<string | null> {
    if (this.httpUploadJid) {
      return this.httpUploadJid;
    }
    const runtime = getXmppRuntime();
    const [, domainPart] = this.account.jid.split("@");
    const baseDomain = this.account.domain ?? domainPart ?? this.account.server;
    const candidates: string[] = [];
    if (baseDomain) {
      candidates.push(`upload.${baseDomain}`);
      candidates.push(baseDomain);
    }
    for (const jid of candidates) {
      try {
        const iq = xml(
          "iq",
          {
            type: "get",
            to: jid,
          },
          xml("query", { xmlns: "http://jabber.org/protocol/disco#info" }),
        );
        const result = await this.sendIq(iq);
        const query =
          typeof result.getChild === "function"
            ? result.getChild("query", "http://jabber.org/protocol/disco#info")
            : null;
        const features =
          query && typeof query.getChildren === "function" ? query.getChildren("feature") : [];
        const hasUploadFeature = (features as any[]).some((f) => {
          const v = f.attrs?.var;
          return v === "urn:xmpp:http:upload:0";
        });
        if (hasUploadFeature) {
          let maxBytes: number | null = null;
          const xData =
            query && typeof query.getChildren === "function"
              ? query.getChildren("x", "jabber:x:data")
              : [];
          for (const x of xData as any[]) {
            if (!x || typeof x.getChildren !== "function") {
              continue;
            }
            const fields = x.getChildren("field") as any[];
            for (const field of fields) {
              const varName = field.attrs?.var;
              if (varName !== "max-file-size") {
                continue;
              }
              const valueEl = typeof field.getChild === "function" ? field.getChild("value") : null;
              const text =
                valueEl && typeof valueEl.getText === "function"
                  ? String(valueEl.getText() ?? "")
                  : "";
              const parsed = Number(text);
              if (Number.isFinite(parsed) && parsed > 0) {
                maxBytes = parsed;
              }
            }
          }
          this.httpUploadJid = jid;
          if (maxBytes !== null) {
            this.httpUploadMaxBytes = maxBytes;
            runtime.log?.(
              `[${this.account.accountId}] xmpp: discovered HTTP upload service at ${jid} maxBytes=${maxBytes}`,
            );
          } else {
            runtime.log?.(
              `[${this.account.accountId}] xmpp: discovered HTTP upload service at ${jid} (no max-file-size advertised)`,
            );
          }
          return jid;
        }
      } catch {}
    }
    runtime.log?.(`[${this.account.accountId}] xmpp: no HTTP upload service discovered`);
    return null;
  }

  private async requestHttpUploadSlot(params: {
    filename: string;
    size: number;
    contentType: string;
  }): Promise<{ putUrl: string; getUrl: string }> {
    const jid = await this.discoverHttpUploadService();
    if (!jid) {
      throw new Error("HTTP upload service not available");
    }
    const iq = xml(
      "iq",
      {
        type: "get",
        to: jid,
      },
      xml("request", {
        xmlns: "urn:xmpp:http:upload:0",
        filename: params.filename,
        size: String(params.size),
        "content-type": params.contentType,
      }),
    );
    const result = await this.sendIq(iq);
    const slot =
      typeof result.getChild === "function"
        ? result.getChild("slot", "urn:xmpp:http:upload:0")
        : null;
    if (!slot) {
      throw new Error("HTTP upload slot missing in response");
    }
    const putEl = typeof slot.getChild === "function" ? slot.getChild("put") : null;
    const getEl = typeof slot.getChild === "function" ? slot.getChild("get") : null;
    const putUrlAttr = putEl?.attrs?.url;
    const getUrlAttr = getEl?.attrs?.url;
    const putUrlText = typeof putEl?.getText === "function" ? String(putEl.getText() ?? "") : "";
    const getUrlText = typeof getEl?.getText === "function" ? String(getEl.getText() ?? "") : "";
    const putUrl = String(putUrlAttr ?? putUrlText ?? "").trim();
    const getUrl = String(getUrlAttr ?? getUrlText ?? "").trim();
    if (!putUrl || !getUrl) {
      throw new Error("HTTP upload slot did not include put/get URLs");
    }
    return { putUrl, getUrl };
  }

  private resolveHttpModule(url: URL): typeof http | typeof https {
    if (url.protocol === "http:") {
      return http;
    }
    if (url.protocol === "https:") {
      return https;
    }
    throw new Error(`Unsupported upload URL protocol: ${url.protocol}`);
  }

  private async putWithDnsFallback(urlString: string, body: Buffer, contentType: string) {
    const url = new URL(urlString);
    const attempt = (targetUrl: URL): Promise<void> => {
      const transport = this.resolveHttpModule(targetUrl);
      const options: http.RequestOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: "PUT",
        headers: {
          "Content-Length": String(body.length),
          "Content-Type": contentType,
        },
      };
      return new Promise<void>((resolve, reject) => {
        const req = transport.request(options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              const combined = Buffer.concat(chunks).toString("utf8").slice(0, 1024);
              reject(
                new Error(`HTTP upload failed with status ${res.statusCode ?? 0}: ${combined}`),
              );
            }
          });
        });
        req.on("error", (err) => {
          reject(err);
        });
        req.write(body);
        req.end();
      });
    };
    try {
      await attempt(url);
      return;
    } catch (err) {
      const asAny = err as { code?: string };
      const code = asAny.code;
      if (code !== "ENOTFOUND") {
        throw err;
      }
      const host = url.hostname;
      const firstDot = host.indexOf(".");
      if (firstDot <= 0) {
        throw err;
      }
      const parentHost = host.slice(firstDot + 1);
      if (!parentHost) {
        throw err;
      }
      const fallbackUrl = new URL(url.toString());
      fallbackUrl.hostname = parentHost;
      await attempt(fallbackUrl);
    }
  }

  async uploadMediaFromUrl(params: {
    mediaUrl: string;
    maxBytes?: number;
    description?: string;
  }): Promise<{ url: string }> {
    const runtime = getXmppRuntime();
    let effectiveMaxBytes = params.maxBytes;
    if (typeof this.httpUploadMaxBytes === "number" && this.httpUploadMaxBytes > 0) {
      if (typeof effectiveMaxBytes === "number" && effectiveMaxBytes > 0) {
        effectiveMaxBytes = Math.min(effectiveMaxBytes, this.httpUploadMaxBytes);
      } else {
        effectiveMaxBytes = this.httpUploadMaxBytes;
      }
    }
    const headResponse = await fetch(params.mediaUrl, { method: "HEAD" }).catch(() => null);
    if (headResponse && headResponse.ok) {
      const len = headResponse.headers.get("content-length");
      if (len) {
        const size = Number(len);
        if (Number.isFinite(size) && effectiveMaxBytes && size > effectiveMaxBytes) {
          throw new Error("Media exceeds maximum configured size");
        }
      }
    }
    const response = await fetch(params.mediaUrl);
    if (!response.ok) {
      throw new Error(`Failed to download media: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (effectiveMaxBytes && buffer.length > effectiveMaxBytes) {
      throw new Error("Downloaded media exceeds maximum configured size");
    }
    let contentType = response.headers.get("content-type") ?? "";
    contentType = contentType.trim().toLowerCase();
    if (!contentType) {
      contentType = "application/octet-stream";
    }
    const urlObj = new URL(params.mediaUrl);
    const filename = urlObj.pathname.split("/").filter(Boolean).at(-1) ?? "file";
    const slot = await this.requestHttpUploadSlot({
      filename,
      size: buffer.length,
      contentType,
    });
    await this.putWithDnsFallback(slot.putUrl, buffer, contentType);
    runtime.log?.(
      `[${this.account.accountId}] xmpp: uploaded media to HTTP upload service put=${slot.putUrl} get=${slot.getUrl}`,
    );
    return { url: slot.getUrl };
  }

  async uploadMediaFromLocalPath(params: {
    filePath: string;
    maxBytes?: number;
    description?: string;
  }): Promise<{ url: string }> {
    const runtime = getXmppRuntime();
    let effectiveMaxBytes = params.maxBytes;
    if (typeof this.httpUploadMaxBytes === "number" && this.httpUploadMaxBytes > 0) {
      if (typeof effectiveMaxBytes === "number" && effectiveMaxBytes > 0) {
        effectiveMaxBytes = Math.min(effectiveMaxBytes, this.httpUploadMaxBytes);
      } else {
        effectiveMaxBytes = this.httpUploadMaxBytes;
      }
    }
    const stat = await fs.stat(params.filePath);
    if (!stat.isFile()) {
      throw new Error("Media path is not a regular file");
    }
    if (effectiveMaxBytes && stat.size > effectiveMaxBytes) {
      throw new Error("Media exceeds maximum configured size");
    }
    const buffer = await fs.readFile(params.filePath);
    if (effectiveMaxBytes && buffer.length > effectiveMaxBytes) {
      throw new Error("Media exceeds maximum configured size");
    }
    const ext = path.extname(params.filePath).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".gif") contentType = "image/gif";
    else if (ext === ".webp") contentType = "image/webp";
    else if (ext === ".mp3") contentType = "audio/mpeg";
    else if (ext === ".wav") contentType = "audio/wav";
    else if (ext === ".mp4") contentType = "video/mp4";
    else if (ext === ".pdf") contentType = "application/pdf";
    else if (ext === ".txt") contentType = "text/plain; charset=utf-8";
    else if (ext === ".json") contentType = "application/json";
    else if (ext === ".csv") contentType = "text/csv";
    else if (ext === ".zip") contentType = "application/zip";
    const filename = path.basename(params.filePath) || "file";
    const slot = await this.requestHttpUploadSlot({
      filename,
      size: buffer.length,
      contentType,
    });
    await this.putWithDnsFallback(slot.putUrl, buffer, contentType);
    runtime.log?.(
      `[${this.account.accountId}] xmpp: uploaded local media to HTTP upload service put=${slot.putUrl} get=${slot.getUrl}`,
    );
    return { url: slot.getUrl };
  }

  private generateMessageId(): string {
    return `xmpp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

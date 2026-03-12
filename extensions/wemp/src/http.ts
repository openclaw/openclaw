import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_SIZE = 1_048_576; // 1 MB

export type RequestBodyReadErrorCode = "payload_too_large" | "timeout" | "aborted";

export class RequestBodyReadError extends Error {
  constructor(
    public readonly code: RequestBodyReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyReadError";
  }
}

export interface ReadRequestBodyOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export async function readRequestBody(
  req: IncomingMessage,
  options: ReadRequestBodyOptions = {},
): Promise<string> {
  const maxBytes =
    Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : MAX_BODY_SIZE;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : 0;
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      if (timer) clearTimeout(timer);
    };

    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };

    const finish = (value: string) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        fail(new RequestBodyReadError("payload_too_large", "Request body too large"));
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));

    const onAborted = () => {
      fail(new RequestBodyReadError("aborted", "Request body aborted"));
    };

    const onError = (error: Error) => {
      fail(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new RequestBodyReadError("timeout", "Request body read timed out"));
      }, timeoutMs);
    }
  });
}

export function getPathname(url: string | undefined): string {
  return new URL(url || "/", "http://localhost").pathname || "/";
}

export function getSearchParams(url: string | undefined): URLSearchParams {
  return new URL(url || "/", "http://localhost").searchParams;
}

export function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.end(body);
}

export function xmlEscape(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeCdata(value: string): string {
  return String(value || "").replace(/\]\]>/g, "]]]]><![CDATA[>");
}

export function buildPassiveTextReply(
  toUser: string,
  fromUser: string,
  content: string,
  createTime = Math.floor(Date.now() / 1000),
): string {
  return `<xml>\n<ToUserName><![CDATA[${escapeCdata(toUser)}]]></ToUserName>\n<FromUserName><![CDATA[${escapeCdata(fromUser)}]]></FromUserName>\n<CreateTime>${createTime}</CreateTime>\n<MsgType><![CDATA[text]]></MsgType>\n<Content><![CDATA[${escapeCdata(content)}]]></Content>\n</xml>`;
}

export interface PassiveNewsItem {
  title: string;
  description: string;
  picUrl: string;
  url: string;
}

export function buildPassiveNewsReply(
  toUser: string,
  fromUser: string,
  articles: PassiveNewsItem[],
  createTime = Math.floor(Date.now() / 1000),
): string {
  const items = articles
    .slice(0, 8)
    .map(
      (article) =>
        `<item>\n<Title><![CDATA[${escapeCdata(article.title)}]]></Title>\n<Description><![CDATA[${escapeCdata(article.description)}]]></Description>\n<PicUrl><![CDATA[${escapeCdata(article.picUrl)}]]></PicUrl>\n<Url><![CDATA[${escapeCdata(article.url)}]]></Url>\n</item>`,
    )
    .join("\n");
  return `<xml>\n<ToUserName><![CDATA[${escapeCdata(toUser)}]]></ToUserName>\n<FromUserName><![CDATA[${escapeCdata(fromUser)}]]></FromUserName>\n<CreateTime>${createTime}</CreateTime>\n<MsgType><![CDATA[news]]></MsgType>\n<ArticleCount>${articles.slice(0, 8).length}</ArticleCount>\n<Articles>\n${items}\n</Articles>\n</xml>`;
}

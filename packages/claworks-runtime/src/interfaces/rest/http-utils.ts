import type { IncomingMessage, ServerResponse } from "node:http";

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found", code: "NOT_FOUND" });
}

export function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: message, code: "BAD_REQUEST" });
}

export function parsePath(url: string): string[] {
  const pathname = new URL(url, "http://localhost").pathname;
  return pathname.split("/").filter(Boolean);
}

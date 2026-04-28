import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHome(p: string): string {
  if (p.startsWith("~")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export async function readToken(path: string): Promise<string> {
  const buf = await readFile(expandHome(path), "utf8");
  const tok = buf.trim();
  if (!tok) throw new Error(`Empty token at ${path}`);
  return tok;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayYmd(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  text: string;
  error?: string;
}

export async function httpJson<T = unknown>(
  url: string,
  opts: FetchOpts = {},
  retries = 1
): Promise<FetchResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let parsed: T | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          parsed = null;
        }
      }
      return { ok: res.ok, status: res.status, body: parsed, text };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(5_000);
        continue;
      }
    }
  }
  return {
    ok: false,
    status: 0,
    body: null,
    text: "",
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

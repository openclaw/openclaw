import { OLLAMA_NATIVE_BASE_URL } from "./ollama-stream.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type OllamaHealthStatus =
  | { healthy: true; version: string }
  | { healthy: false; error: string };

export type OllamaModel = {
  name: string;
  size: number;
  modifiedAt: string;
  digest: string;
};

export type OllamaRunningModel = {
  name: string;
  size: number;
  sizeVram: number;
  digest: string;
  expiresAt: string;
};

export type OllamaStatusInfo = {
  health: OllamaHealthStatus;
  models: OllamaModel[];
  running: OllamaRunningModel[];
};

const TIMEOUT_MS = 3000;

async function ollamaFetch(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOllamaHealth(
  baseUrl: string = OLLAMA_NATIVE_BASE_URL,
): Promise<OllamaHealthStatus> {
  try {
    const data = await ollamaFetch(`${baseUrl}/api/version`);
    if (
      data &&
      typeof data === "object" &&
      "version" in data &&
      typeof (data as any).version === "string"
    ) {
      return { healthy: true, version: (data as any).version };
    }
    return { healthy: false, error: "Unexpected response from /api/version" };
  } catch (err: any) {
    const msg = err?.name === "AbortError" ? "Connection timed out" : String(err?.message ?? err);
    return { healthy: false, error: msg };
  }
}

export async function listOllamaModels(
  baseUrl: string = OLLAMA_NATIVE_BASE_URL,
): Promise<OllamaModel[]> {
  try {
    const data = await ollamaFetch(`${baseUrl}/api/tags`);
    if (!data || typeof data !== "object" || !Array.isArray((data as any).models)) {
      return [];
    }
    return ((data as any).models as any[]).map((m) => ({
      name: String(m.name ?? ""),
      size: Number(m.size ?? 0),
      modifiedAt: String(m.modified_at ?? m.modifiedAt ?? ""),
      digest: String(m.digest ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function getOllamaRunningModels(
  baseUrl: string = OLLAMA_NATIVE_BASE_URL,
): Promise<OllamaRunningModel[]> {
  try {
    const data = await ollamaFetch(`${baseUrl}/api/ps`);
    if (!data || typeof data !== "object" || !Array.isArray((data as any).models)) {
      return [];
    }
    return ((data as any).models as any[]).map((m) => ({
      name: String(m.name ?? ""),
      size: Number(m.size ?? 0),
      sizeVram: Number(m.size_vram ?? m.sizeVram ?? 0),
      digest: String(m.digest ?? ""),
      expiresAt: String(m.expires_at ?? m.expiresAt ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function getOllamaStatus(
  baseUrl: string = OLLAMA_NATIVE_BASE_URL,
): Promise<OllamaStatusInfo> {
  const [health, models, running] = await Promise.all([
    checkOllamaHealth(baseUrl),
    listOllamaModels(baseUrl),
    getOllamaRunningModels(baseUrl),
  ]);
  return { health, models, running };
}

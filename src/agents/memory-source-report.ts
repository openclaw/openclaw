import fs from "node:fs/promises";
import path from "node:path";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countDailyMemoryFiles(memoryDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .length;
  } catch {
    return 0;
  }
}

function summarizeFileMemory(parts: { hasMemory: boolean; dailyCount: number }) {
  const detail = [
    parts.hasMemory ? "MEMORY.md" : "no MEMORY.md",
    `${parts.dailyCount} daily notes`,
  ].join(", ");
  return `- File memory: ${parts.hasMemory || parts.dailyCount > 0 ? "OK" : "UNAVAILABLE"} (${detail})`;
}

type MemoryStatsResponse = {
  active_memory_count?: number;
};

type MemoryListResponse = {
  items?: unknown[];
};

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchMemoriaCount(
  apiUrl: string,
  apiKey?: string,
  userId?: string,
): Promise<number | null> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (userId) {
    headers["X-User-Id"] = userId;
  }

  const baseUrl = apiUrl.replace(/\/$/, "");
  const stats = await fetchJson<MemoryStatsResponse>(`${baseUrl}/v1/memories/stats`, headers);
  if (typeof stats?.active_memory_count === "number") {
    return stats.active_memory_count;
  }

  const list = await fetchJson<MemoryListResponse>(`${baseUrl}/v1/memories?limit=1`, headers);
  if (Array.isArray(list?.items)) {
    return list.items.length;
  }

  return null;
}

async function checkMemoriaSource(opts: {
  label: string;
  apiUrl?: string;
  apiKey?: string;
  userId?: string;
}): Promise<string> {
  if (!opts.apiUrl) {
    return `- ${opts.label}: UNAVAILABLE`;
  }
  const count = await fetchMemoriaCount(opts.apiUrl, opts.apiKey, opts.userId);
  return `- ${opts.label}: ${count === null ? "UNAVAILABLE" : `OK (${count} memories)`}`;
}

export async function buildMemorySourceReport(params: {
  workspaceDir: string;
  localMemoriaApiUrl?: string;
  localMemoriaApiKey?: string;
  localMemoriaUserId?: string;
  cloudMemoriaApiUrl?: string;
  cloudMemoriaApiKey?: string;
  cloudMemoriaUserId?: string;
}): Promise<string[]> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  const hasMemory = await exists(path.join(params.workspaceDir, "MEMORY.md"));
  const dailyCount = await countDailyMemoryFiles(memoryDir);

  return [
    "Memory startup report:",
    await checkMemoriaSource({
      label: "Local Memoria",
      apiUrl: params.localMemoriaApiUrl,
      apiKey: params.localMemoriaApiKey,
      userId: params.localMemoriaUserId,
    }),
    await checkMemoriaSource({
      label: "Cloud Memoria",
      apiUrl: params.cloudMemoriaApiUrl,
      apiKey: params.cloudMemoriaApiKey,
      userId: params.cloudMemoriaUserId,
    }),
    summarizeFileMemory({ hasMemory, dailyCount }),
  ];
}

/**
 * Strategy fork core logic.
 * Handles downloading and extracting strategies from Hub.
 */
import fs from "node:fs";
import path from "node:path";
import {
  getStrategiesRoot,
  createDateDir,
  generateForkDirName,
  writeForkMeta,
  parseStrategyId,
  formatDate,
} from "./strategy-storage.js";
import type {
  SkillApiConfig,
  ForkOptions,
  ForkResult,
  HubPublicEntry,
  ForkAndDownloadResponse,
} from "./types.js";
import type { ForkMeta } from "./types.js";

const HUB_BASE_URL = "https://hub.openfinclaw.ai";

/**
 * Fetch public strategy info from Hub API.
 * GET /api/v1/skill/public/{id}
 */
export async function fetchStrategyInfo(
  config: SkillApiConfig,
  strategyId: string,
): Promise<{ success: boolean; data?: HubPublicEntry; error?: string }> {
  const url = new URL(`${config.baseUrl}/api/v1/skill/public/${strategyId}`);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    const rawText = await response.text();
    let data: unknown;

    if (rawText && rawText.trim().startsWith("{")) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { raw: rawText };
      }
    }

    if (response.status >= 200 && response.status < 300) {
      return { success: true, data: data as HubPublicEntry };
    }

    const errorData = data as { error?: { message?: string }; message?: string; detail?: string };
    return {
      success: false,
      error:
        errorData.error?.message ??
        errorData.message ??
        errorData.detail ??
        `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fork strategy and get download URL from Hub.
 * POST /api/v1/skill/entries/{id}/fork-and-download
 */
export async function forkAndDownloadFromHub(
  config: SkillApiConfig,
  strategyId: string,
  options?: ForkOptions,
): Promise<{ success: boolean; data?: ForkAndDownloadResponse; error?: string }> {
  if (!config.apiKey) {
    return {
      success: false,
      error: "API key is required for fork operation. Set SKILL_API_KEY environment variable.",
    };
  }

  const url = new URL(`${config.baseUrl}/api/v1/skill/entries/${strategyId}/fork-and-download`);

  const body: Record<string, unknown> = {};
  if (options?.name) body.name = options.name;
  if (options?.slug) body.slug = options.slug;
  if (options?.description) body.description = options.description;
  body.forkConfig = {
    keepGenes: options?.keepGenes ?? true,
    overrideParams: {},
  };

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    const rawText = await response.text();
    let data: unknown;

    if (rawText && rawText.trim().startsWith("{")) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { raw: rawText };
      }
    }

    if (response.status >= 200 && response.status < 300) {
      return { success: true, data: data as ForkAndDownloadResponse };
    }

    const errorData = data as {
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    return {
      success: false,
      error:
        errorData.error?.message ??
        errorData.message ??
        errorData.error?.code ??
        `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download ZIP from signed URL.
 */
export async function downloadFromSignedUrl(
  signedUrl: string,
  timeoutMs: number,
): Promise<{ success: boolean; data?: Buffer; error?: string }> {
  try {
    const response = await fetch(signedUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 200 && response.status < 300) {
      const arrayBuffer = await response.arrayBuffer();
      return { success: true, data: Buffer.from(arrayBuffer) };
    }

    return { success: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extract ZIP buffer to directory.
 */
export async function extractZipToDir(
  zipBuffer: Buffer,
  targetDir: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    fs.mkdirSync(targetDir, { recursive: true });

    const admZip = await import("adm-zip").then((m) => m.default || m);
    const zip = new admZip(zipBuffer);
    zip.extractAllTo(targetDir, true);

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fork a strategy from Hub to local directory.
 * Flow: fetchStrategyInfo → forkAndDownloadFromHub → downloadFromSignedUrl → extract
 */
export async function forkStrategy(
  config: SkillApiConfig,
  strategyIdInput: string,
  options?: ForkOptions,
): Promise<ForkResult> {
  const strategyId = parseStrategyId(strategyIdInput);

  const infoResult = await fetchStrategyInfo(config, strategyId);
  if (!infoResult.success || !infoResult.data) {
    return {
      success: false,
      localPath: "",
      sourceId: strategyId,
      sourceShortId: strategyId.slice(0, 8),
      sourceName: "",
      sourceVersion: "",
      error: infoResult.error ?? "Failed to fetch strategy info",
    };
  }

  const info = infoResult.data;
  const shortId = strategyId.slice(0, 8);

  const forkResult = await forkAndDownloadFromHub(config, strategyId, options);
  if (!forkResult.success || !forkResult.data) {
    return {
      success: false,
      localPath: "",
      sourceId: strategyId,
      sourceShortId: shortId,
      sourceName: info.name,
      sourceVersion: info.version ?? "1.0.0",
      error: forkResult.error ?? "Failed to fork strategy",
    };
  }

  const forkData = forkResult.data;
  const forkEntryId = forkData.entry.id;
  const forkEntrySlug = forkData.entry.slug;
  const forkName = forkData.entry.name;

  let targetDir: string;
  if (options?.targetDir) {
    targetDir = options.targetDir;
  } else {
    const root = getStrategiesRoot();
    const dateDir = createDateDir(root, options?.dateDir);
    const dirName = generateForkDirName(forkName, forkEntryId);
    targetDir = path.join(dateDir, dirName);
  }

  if (fs.existsSync(targetDir)) {
    return {
      success: false,
      localPath: targetDir,
      sourceId: strategyId,
      sourceShortId: shortId,
      sourceName: info.name,
      sourceVersion: info.version ?? "1.0.0",
      forkEntryId,
      forkEntrySlug,
      error: `Directory already exists: ${targetDir}`,
    };
  }

  const downloadResult = await downloadFromSignedUrl(
    forkData.download.url,
    config.requestTimeoutMs,
  );
  if (!downloadResult.success || !downloadResult.data) {
    return {
      success: false,
      localPath: "",
      sourceId: strategyId,
      sourceShortId: shortId,
      sourceName: info.name,
      sourceVersion: info.version ?? "1.0.0",
      forkEntryId,
      forkEntrySlug,
      error: downloadResult.error ?? "Failed to download strategy",
    };
  }

  const extractResult = await extractZipToDir(downloadResult.data, targetDir);
  if (!extractResult.success) {
    return {
      success: false,
      localPath: targetDir,
      sourceId: strategyId,
      sourceShortId: shortId,
      sourceName: info.name,
      sourceVersion: info.version ?? "1.0.0",
      forkEntryId,
      forkEntrySlug,
      error: extractResult.error ?? "Failed to extract strategy",
    };
  }

  const meta: ForkMeta = {
    sourceId: strategyId,
    sourceShortId: shortId,
    sourceName: info.name,
    sourceVersion: info.version ?? "1.0.0",
    sourceAuthor: info.author?.displayName,
    forkedAt: forkData.forkedAt ?? new Date().toISOString(),
    forkDateDir: options?.dateDir ?? formatDate(new Date()),
    hubUrl: `${HUB_BASE_URL}/strategy/${strategyId}`,
    localPath: targetDir,
    forkEntryId,
    forkEntrySlug,
  };

  writeForkMeta(targetDir, meta);

  return {
    success: true,
    localPath: targetDir,
    sourceId: strategyId,
    sourceShortId: shortId,
    sourceName: info.name,
    sourceVersion: info.version ?? "1.0.0",
    forkEntryId,
    forkEntrySlug,
    creditsEarned: forkData.creditsEarned,
  };
}

/**
 * Build Hub URL for a strategy.
 */
export function buildHubUrl(strategyId: string): string {
  return `${HUB_BASE_URL}/strategy/${strategyId}`;
}

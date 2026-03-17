/**
 * Strategy fork core logic.
 * Handles downloading and extracting strategies from Hub.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  getStrategiesRoot,
  createDateDir,
  generateForkDirName,
  writeForkMeta,
  parseStrategyId,
  formatDate,
} from "./strategy-storage.js";
import type { SkillApiConfig, ForkOptions, ForkResult, HubStrategyInfo } from "./types.js";
import type { ForkMeta } from "./types.js";

const HUB_BASE_URL = "https://hub.openfinclaw.ai";

/**
 * Fetch strategy info from Hub API.
 */
export async function fetchStrategyInfo(
  config: SkillApiConfig,
  strategyId: string,
): Promise<{ success: boolean; data?: HubStrategyInfo; error?: string }> {
  const url = new URL(`${config.baseUrl}/api/v1/skill/${strategyId}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
      return { success: true, data: data as HubStrategyInfo };
    }

    const errorData = data as { message?: string; detail?: string };
    return {
      success: false,
      error: errorData.message ?? errorData.detail ?? `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download strategy ZIP from Hub.
 */
export async function downloadStrategyZip(
  config: SkillApiConfig,
  strategyId: string,
): Promise<{ success: boolean; data?: Buffer; error?: string }> {
  const url = new URL(`${config.baseUrl}/api/v1/skill/${strategyId}/download`);

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    if (response.status >= 200 && response.status < 300) {
      const arrayBuffer = await response.arrayBuffer();
      return { success: true, data: Buffer.from(arrayBuffer) };
    }

    const errorText = await response.text();
    let errorMessage = `HTTP ${response.status}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.message ?? errorJson.detail ?? errorMessage;
    } catch {
      if (errorText) errorMessage = errorText;
    }

    return { success: false, error: errorMessage };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extract ZIP buffer to directory.
 * Uses Node.js built-in zlib for decompression.
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

  let targetDir: string;
  if (options?.targetDir) {
    targetDir = options.targetDir;
  } else {
    const root = getStrategiesRoot();
    const dateDir = createDateDir(root, options?.dateDir);
    const dirName = generateForkDirName(info.name, strategyId);
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
      error: `Directory already exists: ${targetDir}`,
    };
  }

  const downloadResult = await downloadStrategyZip(config, strategyId);
  if (!downloadResult.success || !downloadResult.data) {
    return {
      success: false,
      localPath: "",
      sourceId: strategyId,
      sourceShortId: shortId,
      sourceName: info.name,
      sourceVersion: info.version ?? "1.0.0",
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
      error: extractResult.error ?? "Failed to extract strategy",
    };
  }

  const meta: ForkMeta = {
    sourceId: strategyId,
    sourceShortId: shortId,
    sourceName: info.name,
    sourceVersion: info.version ?? "1.0.0",
    sourceAuthor: info.author?.name,
    forkedAt: new Date().toISOString(),
    forkDateDir: options?.dateDir ?? formatDate(new Date()),
    hubUrl: `${HUB_BASE_URL}/strategy/${strategyId}`,
    localPath: targetDir,
  };

  writeForkMeta(targetDir, meta);

  return {
    success: true,
    localPath: targetDir,
    sourceId: strategyId,
    sourceShortId: shortId,
    sourceName: info.name,
    sourceVersion: info.version ?? "1.0.0",
  };
}

/**
 * Build Hub URL for a strategy.
 */
export function buildHubUrl(strategyId: string): string {
  return `${HUB_BASE_URL}/strategy/${strategyId}`;
}

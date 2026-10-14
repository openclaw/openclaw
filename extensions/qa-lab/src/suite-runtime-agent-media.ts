import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildQaImageGenerationConfigPatch } from "./providers/image-generation.js";
import { readFirstMediaPath } from "./providers/mock-openai/mock-openai-directives.js";
import {
  fetchJson,
  patchConfig,
  readConfigSnapshot,
  waitForGatewayHealthy,
  waitForTransportReady,
} from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

function extractMediaPathFromText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  const details = isRecord(parsed) ? parsed.details : undefined;
  const media = isRecord(details) ? details.media : undefined;
  return isRecord(media) ? readFirstMediaPath(media) || undefined : undefined;
}

function readPluginAllow(config: Record<string, unknown>) {
  const plugins = config.plugins;
  if (!isRecord(plugins)) {
    return [];
  }
  const allow = plugins.allow;
  return Array.isArray(allow)
    ? allow.filter(
        (pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0,
      )
    : [];
}

async function resolveGeneratedImagePath(params: {
  env: Pick<QaSuiteRuntimeEnv, "mock" | "gateway">;
  promptSnippet: string;
  startedAtMs: number;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.env.mock) {
      try {
        const requests = await fetchJson<Array<{ allInputText?: string; toolOutput?: string }>>(
          `${params.env.mock.baseUrl}/debug/requests`,
          Math.max(1, deadline - Date.now()),
        );
        for (const request of requests.toReversed()) {
          if (!(request.allInputText ?? "").includes(params.promptSnippet)) {
            continue;
          }
          const mediaPath = extractMediaPathFromText(request.toolOutput);
          if (mediaPath) {
            const stat = await fs.stat(mediaPath).catch(() => null);
            // Request snapshots include previous runs; only fresh, nonempty files prove this run.
            if (stat?.isFile() && stat.size > 0 && stat.mtimeMs >= params.startedAtMs - 1_000) {
              return mediaPath;
            }
          }
        }
      } catch {
        // The mock debug endpoint is best-effort; generated media files are the durable fallback.
      }
    }

    // Generated media may deliver directly from tool storage or be staged outbound;
    // either fresh owner artifact proves this run without depending on one delivery path.
    const mediaDirs = ["outbound", "tool-image-generation"].map((subdir) =>
      path.join(params.env.gateway.tempRoot, "state", "media", subdir),
    );
    const candidates = (
      await Promise.all(
        mediaDirs.map(async (mediaDir) => {
          const entries = await fs.readdir(mediaDir).catch(() => []);
          return Promise.all(
            entries.map(async (entry) => {
              const fullPath = path.join(mediaDir, entry);
              const stat = await fs.stat(fullPath).catch(() => null);
              if (!stat?.isFile() || stat.size === 0) {
                return null;
              }
              return {
                fullPath,
                mtimeMs: stat.mtimeMs,
              };
            }),
          );
        }),
      )
    ).flat();
    const match = candidates
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .filter((entry) => entry.mtimeMs >= params.startedAtMs - 1_000)
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
      .at(0)?.fullPath;
    if (match) {
      return match;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(250, remainingMs));
    }
  }
  throw new Error(`timed out after ${params.timeoutMs}ms`);
}

async function ensureImageGenerationConfigured(env: QaSuiteRuntimeEnv) {
  const snapshot = await readConfigSnapshot(env);
  await patchConfig({
    env,
    patch: buildQaImageGenerationConfigPatch({
      providerMode: env.providerMode,
      providerBaseUrl: env.mock ? `${env.mock.baseUrl}/v1` : undefined,
      requiredPluginIds: env.transport.requiredPluginIds,
      existingPluginIds: readPluginAllow(snapshot.config),
      forcedRuntime:
        env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME === "codex" ? "codex" : undefined,
    }),
  });
  await waitForGatewayHealthy(env);
  await waitForTransportReady(env, 60_000);
}

export { ensureImageGenerationConfigured, extractMediaPathFromText, resolveGeneratedImagePath };

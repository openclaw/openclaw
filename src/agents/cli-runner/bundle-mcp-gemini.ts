import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { applyMergePatch } from "../../config/merge-patch.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { BundleMcpConfig } from "../../plugins/bundle-mcp.types.js";
import {
  decodeHeaderEnvPlaceholder,
  isRecord,
  normalizeBundleMcpServerConfig,
  normalizeMcpStringRecord,
} from "../bundle-mcp-adapter.js";
import { withOpenClawMcpCaptureHeader, writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

const GEMINI_MCP_SERVER_FIELDS = { strings: ["type"], booleans: ["trust"] } as const;

async function readGeminiBaseSettings(
  inheritedEnv: Record<string, string> | undefined,
): Promise<Record<string, unknown>> {
  const settingsPath =
    inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const raw = settingsPath?.trim() ? await tryReadJson<unknown>(settingsPath) : undefined;
  return isRecord(raw) ? raw : {};
}

function mergeGeminiWebSearchDisabled(base: Record<string, unknown>): Record<string, unknown> {
  const existing = filterStringEntries(isRecord(base.tools) ? base.tools.exclude : undefined);
  return applyMergePatch(base, {
    tools: { exclude: [...new Set([...existing, "google_web_search"])] },
  }) as Record<string, unknown>;
}

async function writeGeminiSettings(
  settings: Record<string, unknown>,
  inheritedEnv: Record<string, string> | undefined,
  prefix = "openclaw-gemini-mcp-",
) {
  const temporary = await writeTemporaryBundleMcpJson(prefix, settings);
  return {
    env: { ...inheritedEnv, GEMINI_CLI_SYSTEM_SETTINGS_PATH: temporary.filePath },
    cleanup: temporary.cleanup,
  };
}

export async function writeGeminiWebSearchDisabledSettings(
  inheritedEnv: Record<string, string> | undefined,
) {
  return await writeGeminiSettings(
    mergeGeminiWebSearchDisabled(await readGeminiBaseSettings(inheritedEnv)),
    inheritedEnv,
  );
}

export async function writeGeminiSystemSettings(
  mergedConfig: BundleMcpConfig,
  inheritedEnv: Record<string, string> | undefined,
  mcpToolsDeny?: Record<string, string[]>,
  webSearchEnabled?: boolean,
) {
  const base = await readGeminiBaseSettings(inheritedEnv);
  const mcpServers = Object.fromEntries(
    Object.entries(mergedConfig.mcpServers).flatMap(([name, server]) => {
      const deniedTools =
        mcpToolsDeny && Object.hasOwn(mcpToolsDeny, name) ? mcpToolsDeny[name] : undefined;
      const next = normalizeBundleMcpServerConfig(server, GEMINI_MCP_SERVER_FIELDS);
      const headers = normalizeMcpStringRecord(server.headers);
      if (headers) {
        next.headers = Object.fromEntries(
          Object.entries(headers).map(([headerName, value]) => {
            // Gemini needs concrete headers, using the inherited run env before process env.
            const decoded = decodeHeaderEnvPlaceholder(value);
            if (!decoded) {
              return [headerName, value];
            }
            const resolved = inheritedEnv?.[decoded.envVar] ?? process.env[decoded.envVar] ?? "";
            return [headerName, decoded.bearer ? `Bearer ${resolved}` : resolved];
          }),
        );
      }
      const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
      const included = filterStringEntries(toolFilter.include);
      if (included.length > 0) {
        const existing = filterStringEntries(server.includeTools);
        const finalIncluded =
          existing.length > 0
            ? included.filter((toolName) => existing.includes(toolName)).toSorted()
            : [...new Set(included)].toSorted();
        if (finalIncluded.length === 0) {
          return [];
        }
        next.includeTools = finalIncluded;
      }
      const filteredDenied = filterStringEntries(toolFilter.exclude);
      if (deniedTools?.length || filteredDenied.length > 0) {
        const existing = filterStringEntries(server.excludeTools);
        next.excludeTools = [
          ...new Set([...existing, ...filteredDenied, ...(deniedTools ?? [])]),
        ].toSorted();
      }
      return [[name, next]];
    }),
  );
  const settings = applyMergePatch(
    webSearchEnabled === false ? mergeGeminiWebSearchDisabled(base) : base,
    {
      mcp: {
        allowed: Object.keys(mcpServers),
      },
      mcpServers,
    },
  ) as Record<string, unknown>;
  return {
    ...(await writeGeminiSettings(settings, inheritedEnv)),
    prepareCaptureAttempt: (captureKey: string, env: Record<string, string> | undefined) =>
      writeGeminiSettings(
        withOpenClawMcpCaptureHeader(settings, captureKey),
        env,
        "openclaw-gemini-mcp-attempt-",
      ),
  };
}

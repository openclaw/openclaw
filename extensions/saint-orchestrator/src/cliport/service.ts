import type { OpenClawPluginService } from "openclaw/plugin-sdk";
import path from "node:path";
import { createCliportDaemon } from "./daemon.js";

const DEFAULT_SOCKET_PATH = "/var/run/cliport.sock";

function normalizeSocketPath(value: string): string {
  return path.posix.normalize(value.trim());
}

function extractBindPaths(bind: string): string[] {
  const trimmed = bind.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.includes("=") && trimmed.includes(",")) {
    const parts = trimmed.split(",");
    const values = new Map<string, string>();
    for (const part of parts) {
      const [rawKey, ...rest] = part.split("=");
      if (!rawKey || rest.length === 0) {
        continue;
      }
      values.set(rawKey.trim().toLowerCase(), rest.join("=").trim());
    }
    const source = values.get("src") ?? values.get("source");
    const target = values.get("dst") ?? values.get("target") ?? values.get("destination");
    return [source, target].filter((entry): entry is string => Boolean(entry?.trim()));
  }

  const parts = trimmed.split(":");
  if (parts.length < 2) {
    return [];
  }
  return [parts[0] ?? "", parts[1] ?? ""].filter(Boolean);
}

function isCliportSocketBind(bind: string, socketPath: string): boolean {
  const normalizedSocketPath = normalizeSocketPath(socketPath);
  return extractBindPaths(bind).some((entry) => normalizeSocketPath(entry) === normalizedSocketPath);
}

function hasCliportSocketBind(value: unknown, socketPath: string): boolean {
  if (typeof value === "string") {
    return isCliportSocketBind(value, socketPath);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasCliportSocketBind(entry, socketPath));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      hasCliportSocketBind(entry, socketPath),
    );
  }
  return false;
}

function isElevatedEnabled(config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return true;
  }
  const tools = (config as { tools?: unknown }).tools;
  if (!tools || typeof tools !== "object") {
    return true;
  }
  const elevated = (tools as { elevated?: unknown }).elevated;
  if (!elevated || typeof elevated !== "object") {
    return true;
  }
  return (elevated as { enabled?: unknown }).enabled !== false;
}

export function createCliportService(): OpenClawPluginService {
  let stopDaemon: (() => Promise<void>) | null = null;

  return {
    id: "cliport",
    start: async (ctx) => {
      const workspaceDir = ctx.workspaceDir?.trim();
      if (!workspaceDir) {
        ctx.logger.warn("[cliport] workspaceDir missing; service disabled");
        return;
      }
      const socketPath = process.env.CLIPORT_SOCKET_PATH?.trim() || DEFAULT_SOCKET_PATH;
      if (hasCliportSocketBind(ctx.config, socketPath) && isElevatedEnabled(ctx.config)) {
        const message =
          "[cliport] unsafe config: tools.elevated.enabled must be false when cliport socket bind is configured";
        ctx.logger.error(message);
        throw new Error(message);
      }
      const registryPath =
        process.env.CLIPORT_REGISTRY?.trim() || path.join(ctx.stateDir, "cliport", "registry.json");
      const defaultToken = process.env.CLIPORT_TOKEN?.trim();

      const daemon = createCliportDaemon({
        socketPath,
        registryPath,
        stateDir: ctx.stateDir,
        workspaceDir,
        defaultTokens: defaultToken ? [defaultToken] : [],
        logger: {
          info: ctx.logger.info,
          warn: ctx.logger.warn,
          error: ctx.logger.error,
        },
      });

      await daemon.start();
      stopDaemon = async () => {
        await daemon.stop();
      };
    },
    stop: async () => {
      if (!stopDaemon) {
        return;
      }
      await stopDaemon();
      stopDaemon = null;
    },
  };
}

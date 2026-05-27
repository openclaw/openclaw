import { describeHttpMcpServerLaunchConfig, resolveHttpMcpServerLaunchConfig } from "./mcp-http.js";

type SseMcpServerLaunchConfig = {
  url: string;
  headers?: Record<string, string>;
};

type SseMcpServerLaunchResult =
  | { ok: true; config: SseMcpServerLaunchConfig }
  | { ok: false; reason: string };

export function resolveSseMcpServerLaunchConfig(
  raw: unknown,
  options?: {
    onDroppedHeader?: (key: string, value: unknown) => void;
    onMalformedHeaders?: (value: unknown) => void;
  },
): SseMcpServerLaunchResult {
  const resolved = resolveHttpMcpServerLaunchConfig(raw, {
    transportType: "sse",
    onDroppedHeader: options?.onDroppedHeader,
    onMalformedHeaders: options?.onMalformedHeaders,
  });
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    config: {
      url: resolved.config.url,
      headers: resolved.config.headers,
    },
  };
}

export function describeSseMcpServerLaunchConfig(config: SseMcpServerLaunchConfig): string {
  return describeHttpMcpServerLaunchConfig({ ...config, transportType: "sse" });
}

export type { SseMcpServerLaunchConfig, SseMcpServerLaunchResult };

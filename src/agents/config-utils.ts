import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

export interface ManusilizedConfig {
  streaming?: {
    mode?: "standard" | "enhanced" | "ultra";
    bufferSize?: number;
    throttleDelay?: number;
    enableThinkingOutput?: boolean;
    streamInterval?: number;
  };
  context?: {
    enableMegaContext?: boolean;
    maxContextWindow?: number;
    autoDetectContext?: boolean;
  };
}

/**
 * Load Manusilized configuration from config file
 * @param configPath Path to the OpenClaw config directory
 * @returns ManusilizedConfig or default config if not found
 */
export function loadManusilizedConfig(configPath?: string): ManusilizedConfig {
  // Try to find config file in common locations
  const possiblePaths = [
    configPath ? pathJoin(configPath, "manusilized-streaming.json") : "",
    pathJoin(process.cwd(), "config", "manusilized-streaming.json"),
    pathJoin(process.cwd(), "manusilized-streaming.json"),
    "/etc/openclaw/manusilized-streaming.json",
  ].filter(Boolean) as string[];

  for (const configFilePath of possiblePaths) {
    if (existsSync(configFilePath)) {
      try {
        const configFile = readFileSync(configFilePath, "utf8");
        const config = JSON.parse(configFile) as ManusilizedConfig;
        console.log(`[manusilized] Loaded config from ${configFilePath}`);
        return config;
      } catch (err) {
        console.warn(`[manusilized] Failed to parse config file ${configFilePath}:`, err);
      }
    }
  }

  // Return default config if no file found
  console.log("[manusilized] Using default configuration");
  return {
    streaming: {
      mode: "standard",
      bufferSize: 1024,
      throttleDelay: 10,
      enableThinkingOutput: false,
      streamInterval: 50,
    },
    context: {
      enableMegaContext: false,
      maxContextWindow: 262144,
      autoDetectContext: true,
    },
  };
}

/**
 * Apply streaming mode presets to config
 * @param config Base configuration
 * @returns Configuration with streaming mode applied
 */
export function applyStreamingMode(config: ManusilizedConfig): ManusilizedConfig {
  const mode = config.streaming?.mode || "standard";
  
  switch (mode) {
    case "enhanced":
      return {
        ...config,
        streaming: {
          ...config.streaming,
          bufferSize: 2048,
          throttleDelay: 5,
          streamInterval: 25,
        },
      };
    case "ultra":
      return {
        ...config,
        streaming: {
          ...config.streaming,
          bufferSize: 4096,
          throttleDelay: 1,
          streamInterval: 10,
          enableThinkingOutput: true,
        },
      };
    case "standard":
    default:
      return {
        ...config,
        streaming: {
          ...config.streaming,
          bufferSize: 1024,
          throttleDelay: 10,
          streamInterval: 50,
        },
      };
  }
}
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// OSCQuery and Avatar Discovery for VRChat
// Based on VRChat 2025.3.3 Open Beta specs

export interface AvatarParameter {
  name: string;
  type: "bool" | "int" | "float";
  value?: boolean | number;
  min?: number;
  max?: number;
}

export interface AvatarConfig {
  id: string;
  name?: string;
  parameters: AvatarParameter[];
}

export interface DiscoveryResult {
  avatarId: string;
  parameters: AvatarParameter[];
  source: "oscquery" | "local_json" | "none";
  timestamp: Date;
}

// Cache for discovered parameters
const discoveryCache = new Map<string, DiscoveryResult>();
let lastDiscoveryTime = 0;
const DISCOVERY_COOLDOWN_MS = 1000; // 1 second cooldown

/**
 * Discover avatar parameters from local JSON config
 * VRChat stores configs at: AppData/LocalLow/VRChat/VRChat/OSC/{userId}/Avatars/{avatarId}.json
 */
export async function discoverFromLocalJSON(avatarId: string): Promise<AvatarParameter[] | null> {
  try {
    // Search for the avatar JSON file
    const basePath = join(homedir(), "AppData", "LocalLow", "VRChat", "VRChat", "OSC");

    // Use pattern matching to find user directories
    const userDirs = await findDirectories(basePath, "usr_*");

    for (const userDir of userDirs) {
      const avatarPath = join(userDir, "Avatars", `${avatarId}.json`);

      try {
        const content = await fs.readFile(avatarPath, "utf8");
        const config = JSON.parse(content) as AvatarConfig;

        if (config.parameters) {
          return config.parameters;
        }
      } catch {
        // File not found or invalid, continue to next
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error("Error discovering from local JSON:", error);
    return null;
  }
}

/**
 * Discover parameters via OSCQuery (HTTP service from VRChat)
 */
export async function discoverFromOSCQuery(port: number = 9002): Promise<AvatarParameter[] | null> {
  try {
    // OSCQuery typically runs on port 9002
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      CONTENTS?: Record<string, unknown>;
    };

    // Parse OSCQuery response to extract parameters
    const parameters: AvatarParameter[] = [];

    if (data.CONTENTS) {
      const avatarContents = data.CONTENTS["avatar"] as {
        CONTENTS?: {
          parameters?: {
            CONTENTS?: Record<string, unknown>;
          };
        };
      };

      if (avatarContents?.CONTENTS?.parameters?.CONTENTS) {
        for (const [key, value] of Object.entries(avatarContents.CONTENTS.parameters.CONTENTS)) {
          const paramInfo = value as {
            TYPE?: string;
            VALUE?: unknown;
            RANGE?: [number, number];
          };

          parameters.push({
            name: key,
            type: (paramInfo.TYPE?.toLowerCase() as "bool" | "int" | "float") || "float",
            value: paramInfo.VALUE as boolean | number | undefined,
            min: paramInfo.RANGE?.[0],
            max: paramInfo.RANGE?.[1],
          });
        }
      }
    }

    return parameters.length > 0 ? parameters : null;
  } catch (error) {
    // OSCQuery may not be available
    return null;
  }
}

/**
 * Full discovery with dual-mode (OSCQuery + Local JSON)
 */
export async function discoverAvatarParameters(
  avatarId: string,
  oscQueryPort: number = 9002,
): Promise<DiscoveryResult> {
  const now = Date.now();

  // Check cooldown
  if (now - lastDiscoveryTime < DISCOVERY_COOLDOWN_MS) {
    const cached = discoveryCache.get(avatarId);
    if (cached) {
      return cached;
    }
  }

  lastDiscoveryTime = now;

  // Try OSCQuery first
  const oscqueryParams = await discoverFromOSCQuery(oscQueryPort);
  if (oscqueryParams) {
    const result: DiscoveryResult = {
      avatarId,
      parameters: oscqueryParams,
      source: "oscquery",
      timestamp: new Date(),
    };
    discoveryCache.set(avatarId, result);
    return result;
  }

  // Fall back to local JSON
  const localParams = await discoverFromLocalJSON(avatarId);
  if (localParams) {
    const result: DiscoveryResult = {
      avatarId,
      parameters: localParams,
      source: "local_json",
      timestamp: new Date(),
    };
    discoveryCache.set(avatarId, result);
    return result;
  }

  // No parameters found
  return {
    avatarId,
    parameters: [],
    source: "none",
    timestamp: new Date(),
  };
}

/**
 * Check if a parameter exists for the current avatar
 */
export async function isParameterSupported(avatarId: string, paramName: string): Promise<boolean> {
  const discovery = await discoverAvatarParameters(avatarId);
  return discovery.parameters.some((p) => p.name === paramName);
}

/**
 * Get cached discovery result
 */
export function getCachedDiscovery(avatarId: string): DiscoveryResult | undefined {
  return discoveryCache.get(avatarId);
}

/**
 * Clear discovery cache
 */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

// Helper function to find directories matching a pattern
async function findDirectories(basePath: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const prefix = pattern.replace("*", "");

  try {
    const entries = await fs.readdir(basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        results.push(join(basePath, entry.name));
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return results;
}

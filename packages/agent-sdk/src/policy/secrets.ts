// @openclaw/agent-sdk — Secret reference resolution (fail-closed).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SecretMapping } from "../index.js";

export interface SecretResolution {
  value: string | undefined;
  error?: string;
}

export interface SecretEnvSource {
  type: "env";
  key: string;
}

export interface SecretGatewaySource {
  type: "gateway";
  ref: string;
}

export interface SecretFileSource {
  type: "file";
  path: string;
}

export type SecretSource = SecretEnvSource | SecretGatewaySource | SecretFileSource;

function parseSource(mapping: SecretMapping): SecretSource {
  if (mapping.source === "env") return { type: "env", key: mapping.key };
  if (mapping.source === "gateway") return { type: "gateway", ref: mapping.ref };
  return { type: "file", path: mapping.path };
}

/**
 * Resolve a secret from its declared source.
 * Fail-closed: returns undefined + error message on any failure.
 * Never throws.
 */
export function resolveSecret(
  mapping: SecretMapping,
  workspacePath: string = "",
): SecretResolution {
  try {
    const source = parseSource(mapping);

    if (source.type === "env") {
      const value = process.env[source.key];
      if (value === undefined || value === "") {
        return { value: undefined, error: `env var not set: ${source.key}` };
      }
      return { value };
    }

    if (source.type === "gateway") {
      // Gateway secret resolution requires the gateway runtime.
      // In standalone/test mode, this always fails closed.
      return {
        value: undefined,
        error: `gateway secret resolution not available in this context: ${source.ref}`,
      };
    }

    if (source.type === "file") {
      const filePath = resolve(workspacePath, source.path);
      if (!existsSync(filePath)) {
        return { value: undefined, error: `secret file not found: ${source.path}` };
      }
      const value = readFileSync(filePath, "utf8").trim();
      if (!value) {
        return { value: undefined, error: `secret file is empty: ${source.path}` };
      }
      return { value };
    }

    return { value: undefined, error: `unknown secret source type` };
  } catch (e) {
    return { value: undefined, error: `secret resolution error: ${(e as Error).message}` };
  }
}

/**
 * Check whether a tool is in the allowed list for a given resource.
 */
export function isToolAllowed(
  toolName: string,
  allowList: string[] | undefined,
  globalDeny: string[] | undefined,
): boolean {
  // If global deny list exists and includes this tool, block.
  if (globalDeny?.includes(toolName)) return false;
  // If allow list exists and doesn't include this tool, block.
  if (allowList !== undefined && !allowList.includes(toolName)) return false;
  return true;
}

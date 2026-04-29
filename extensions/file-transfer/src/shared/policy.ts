// Path policy for file-transfer tools.
//
// Default behavior is DENY. The operator must explicitly opt in by adding
// a config block to ~/.openclaw/openclaw.json under
// `gateway.nodes.fileTransfer`. Without a matching block, every file
// operation is rejected before reaching the node.
//
// Schema (informal):
//
//   "gateway": {
//     "nodes": {
//       "fileTransfer": {
//         "<nodeId-or-displayName>": {
//           "ask":              "off" | "on-miss" | "always",
//           "allowReadPaths":   ["~/Screenshots/**", "/tmp/**"],
//           "allowWritePaths":  ["~/Downloads/**"],
//           "denyPaths":        ["**/.ssh/**", "**/.aws/**"],
//           "maxBytes": 16777216
//         },
//         "*": { "ask": "on-miss" }
//       }
//     }
//   }
//
// `ask` modes:
//   off       — silent: allow if matched, deny if not (today's default)
//   on-miss   — silent allow if matched; prompt operator if not matched
//   always    — prompt operator on every call (denyPaths still hard-deny)
//
// `denyPaths` always wins, even in `ask: always`.
// `allow-always` from the prompt appends the path back into allowReadPaths /
// allowWritePaths via mutateConfigFile.

import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";

export type FilePolicyKind = "read" | "write";
export type FilePolicyAskMode = "off" | "on-miss" | "always";

export type FilePolicyDecision =
  | { ok: true; reason: "matched-allow"; maxBytes?: number }
  | { ok: true; reason: "ask-always"; askMode: FilePolicyAskMode; maxBytes?: number }
  | {
      ok: false;
      code: "NO_POLICY" | "POLICY_DENIED";
      reason: string;
      askable: boolean;
      askMode?: FilePolicyAskMode;
    };

type NodeFilePolicyConfig = {
  ask?: FilePolicyAskMode;
  allowReadPaths?: string[];
  allowWritePaths?: string[];
  denyPaths?: string[];
  maxBytes?: number;
};

type FilePolicyConfig = Record<string, NodeFilePolicyConfig>;

function readFilePolicyConfig(): FilePolicyConfig | null {
  const cfg = getRuntimeConfig();
  const gateway = (cfg as { gateway?: unknown }).gateway;
  if (!gateway || typeof gateway !== "object") {
    return null;
  }
  const nodes = (gateway as { nodes?: unknown }).nodes;
  if (!nodes || typeof nodes !== "object") {
    return null;
  }
  const fileTransfer = (nodes as { fileTransfer?: unknown }).fileTransfer;
  if (!fileTransfer || typeof fileTransfer !== "object" || Array.isArray(fileTransfer)) {
    return null;
  }
  return fileTransfer as FilePolicyConfig;
}

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2));
  }
  return p;
}

function normalizeGlobs(patterns: string[] | undefined): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => expandTilde(p.trim()));
}

function matchesAny(target: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(target, pattern, { dot: true })) {
      return true;
    }
  }
  return false;
}

function resolveNodePolicy(
  config: FilePolicyConfig,
  nodeId: string,
  nodeDisplayName?: string,
): { key: string; entry: NodeFilePolicyConfig } | null {
  const candidates = [nodeId, nodeDisplayName].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  for (const key of candidates) {
    if (config[key]) {
      return { key, entry: config[key] };
    }
  }
  if (config["*"]) {
    return { key: "*", entry: config["*"] };
  }
  return null;
}

function normalizeAskMode(value: unknown): FilePolicyAskMode {
  if (value === "on-miss" || value === "always" || value === "off") {
    return value;
  }
  return "off";
}

/**
 * Evaluate whether (nodeId, kind, path) is permitted.
 *
 * Resolution order:
 *   1. No fileTransfer config or no entry for this node → NO_POLICY (deny,
 *      not askable — operator hasn't opted in at all).
 *   2. denyPaths matches → POLICY_DENIED, not askable (hard deny).
 *   3. ask=always → ask-always (prompt every time).
 *   4. allowPaths matches → matched-allow (silent allow).
 *   5. ask=on-miss → POLICY_DENIED with askable=true.
 *   6. ask=off (or unset) → POLICY_DENIED, not askable.
 */
export function evaluateFilePolicy(input: {
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  path: string;
}): FilePolicyDecision {
  const config = readFilePolicyConfig();
  if (!config) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason:
        "no gateway.nodes.fileTransfer config; file-transfer is deny-by-default until configured",
      askable: false,
    };
  }
  const resolved = resolveNodePolicy(config, input.nodeId, input.nodeDisplayName);
  if (!resolved) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason: `no fileTransfer policy entry for "${input.nodeDisplayName ?? input.nodeId}"; configure gateway.nodes.fileTransfer or "*"`,
      askable: false,
    };
  }
  const nodeConfig = resolved.entry;
  const askMode = normalizeAskMode(nodeConfig.ask);

  // 1. Deny patterns always win.
  const denyPatterns = normalizeGlobs(nodeConfig.denyPaths);
  if (matchesAny(input.path, denyPatterns)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path matches a denyPaths pattern",
      askable: false,
      askMode,
    };
  }

  const maxBytes =
    typeof nodeConfig.maxBytes === "number" && Number.isFinite(nodeConfig.maxBytes)
      ? Math.max(1, Math.floor(nodeConfig.maxBytes))
      : undefined;

  // 2. ask=always: prompt every time even if matched.
  if (askMode === "always") {
    return { ok: true, reason: "ask-always", askMode, maxBytes };
  }

  // 3. Match against allow list for this kind.
  const allowPatterns =
    input.kind === "read"
      ? normalizeGlobs(nodeConfig.allowReadPaths)
      : normalizeGlobs(nodeConfig.allowWritePaths);

  if (allowPatterns.length > 0 && matchesAny(input.path, allowPatterns)) {
    return { ok: true, reason: "matched-allow", maxBytes };
  }

  // 4. No allow match. Either askable on miss or hard-deny.
  if (askMode === "on-miss") {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
      askable: true,
      askMode,
    };
  }

  return {
    ok: false,
    code: "POLICY_DENIED",
    reason:
      allowPatterns.length === 0
        ? `no allow${input.kind === "read" ? "Read" : "Write"}Paths configured`
        : `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
    askable: false,
    askMode,
  };
}

/**
 * Persist an "allow-always" approval by appending the path to the
 * relevant allowReadPaths / allowWritePaths list for the node. Uses
 * mutateConfigFile so the change survives gateway restarts.
 *
 * Inserts under whichever key matched the policy (per-node entry, or
 * the "*" wildcard if that's what was hit). If no entry exists yet,
 * creates one keyed by nodeDisplayName ?? nodeId.
 */
export async function persistAllowAlways(input: {
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  path: string;
}): Promise<void> {
  const field = input.kind === "read" ? "allowReadPaths" : "allowWritePaths";
  await mutateConfigFile({
    afterWrite: { mode: "none", reason: "file-transfer allow-always policy update" },
    mutate: (draft) => {
      // Cast through unknown — OpenClawConfig type doesn't yet declare
      // gateway.nodes.fileTransfer.
      const root = draft as unknown as Record<string, unknown>;
      const gateway = (root.gateway ??= {}) as Record<string, unknown>;
      const nodes = (gateway.nodes ??= {}) as Record<string, unknown>;
      const fileTransfer = (nodes.fileTransfer ??= {}) as Record<string, NodeFilePolicyConfig>;

      const candidates = [input.nodeId, input.nodeDisplayName, "*"].filter(
        (k): k is string => typeof k === "string" && k.length > 0,
      );
      let key = candidates.find((c) => fileTransfer[c]);
      if (!key) {
        key = input.nodeDisplayName ?? input.nodeId;
        fileTransfer[key] = {};
      }
      const entry = fileTransfer[key];
      const list = Array.isArray(entry[field]) ? entry[field] : [];
      if (!list.includes(input.path)) {
        list.push(input.path);
      }
      entry[field] = list;
    },
  });
}

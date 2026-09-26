// Deny-by-default policy. Authored globs and exact standing grants remain separate;
// grants bind the node, command, requested path, and node-authoritative canonical path.

import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FILE_TRANSFER_NODE_INVOKE_COMMANDS,
  type FileTransferNodeInvokeCommand,
} from "./node-invoke-policy-commands.js";

export type FilePolicyKind = "read" | "write";
type FilePolicyAskMode = "off" | "on-miss" | "always";
export const FILE_TRANSFER_POLICY_VERSION = 2;

type FileTransferLiteralGrant = {
  nodeId: string;
  command: FileTransferNodeInvokeCommand;
  requestedPath: string;
  canonicalPath: string;
};

type PendingReapproval = {
  selector: string;
  kind: FilePolicyKind;
  path: string;
};

type PersistLiteralGrantInput = FileTransferLiteralGrant & {
  pendingReapprovalSelector?: string;
};

type FilePolicyDecision =
  | {
      ok: true;
      reason: "matched-allow" | "matched-literal";
      maxBytes?: number;
      followSymlinks: boolean;
      expectedCanonicalPath?: string;
    }
  | {
      ok: true;
      reason: "ask-always";
      askMode: FilePolicyAskMode;
      maxBytes?: number;
      followSymlinks: boolean;
      pendingReapprovalSelector?: string;
    }
  | {
      ok: false;
      code: "NO_POLICY" | "POLICY_DENIED" | "POLICY_MIGRATION_REQUIRED";
      reason: string;
      askable: boolean;
      askMode?: FilePolicyAskMode;
      maxBytes?: number;
      followSymlinks?: boolean;
      pendingReapprovalSelector?: string;
    };

type NodeFilePolicyConfig = {
  ask?: FilePolicyAskMode;
  allowReadPaths?: string[];
  allowWritePaths?: string[];
  denyPaths?: string[];
  maxBytes?: number;
  followSymlinks?: boolean;
};

type FilePolicyConfig = Record<string, NodeFilePolicyConfig>;

type FileTransferPolicyConfig = {
  policyVersion?: number;
  nodes?: FilePolicyConfig;
  literalGrants?: unknown;
  pendingReapprovals?: unknown;
};

function asFilePolicyConfig(value: unknown): FilePolicyConfig | null {
  return asNullableRecord(value) as FilePolicyConfig | null;
}

function readFileTransferConfigFromPluginConfig(
  pluginConfig: unknown,
): FileTransferPolicyConfig | null {
  const pluginRecord = asNullableRecord(pluginConfig);
  if (!pluginRecord) {
    return null;
  }
  return {
    policyVersion:
      typeof pluginRecord.policyVersion === "number" ? pluginRecord.policyVersion : undefined,
    nodes: asFilePolicyConfig(pluginRecord.nodes) ?? undefined,
    literalGrants: pluginRecord.literalGrants,
    pendingReapprovals: pluginRecord.pendingReapprovals,
  };
}

function readPendingReapprovals(config: FileTransferPolicyConfig): PendingReapproval[] {
  if (
    config.policyVersion !== FILE_TRANSFER_POLICY_VERSION ||
    !Array.isArray(config.pendingReapprovals)
  ) {
    return [];
  }
  return config.pendingReapprovals.flatMap((value) => {
    const pending = asNullableRecord(value);
    if (
      !pending ||
      typeof pending.selector !== "string" ||
      (pending.kind !== "read" && pending.kind !== "write") ||
      typeof pending.path !== "string"
    ) {
      return [];
    }
    return [{ selector: pending.selector, kind: pending.kind, path: pending.path }];
  });
}

function matchesPendingReapproval(
  input: FilePolicyInput,
  policySelector: string,
  pending: PendingReapproval,
): boolean {
  return (
    pending.kind === input.kind &&
    pending.path === input.path &&
    pending.selector === policySelector
  );
}

function readPluginConfigFromRuntimeConfig(): Record<string, unknown> | null {
  const cfg = getRuntimeConfig();
  const plugins = asOptionalObjectRecord((cfg as { plugins?: unknown }).plugins);
  if (!plugins) {
    return null;
  }
  const entries = asOptionalObjectRecord(plugins.entries);
  if (!entries) {
    return null;
  }
  const entry = asOptionalObjectRecord(entries["file-transfer"]);
  if (!entry) {
    return null;
  }
  return asNullableRecord(entry.config);
}

function readFileTransferConfig(
  pluginConfig?: Record<string, unknown>,
): FileTransferPolicyConfig | null {
  return (
    readFileTransferConfigFromPluginConfig(readPluginConfigFromRuntimeConfig()) ??
    readFileTransferConfigFromPluginConfig(pluginConfig)
  );
}

function readNodes(config: FileTransferPolicyConfig): FilePolicyConfig | null {
  return asFilePolicyConfig(config.nodes);
}

function hasLegacyPositiveRules(config: FileTransferPolicyConfig): boolean {
  const nodes = readNodes(config);
  if (!nodes) {
    return false;
  }
  return Object.values(nodes).some(
    (entry) =>
      (Array.isArray(entry.allowReadPaths) && entry.allowReadPaths.length > 0) ||
      (Array.isArray(entry.allowWritePaths) && entry.allowWritePaths.length > 0),
  );
}

function readLiteralGrants(config: FileTransferPolicyConfig): FileTransferLiteralGrant[] {
  if (
    config.policyVersion !== FILE_TRANSFER_POLICY_VERSION ||
    !Array.isArray(config.literalGrants)
  ) {
    return [];
  }
  return config.literalGrants.flatMap((value) => {
    const grant = asNullableRecord(value);
    if (
      !grant ||
      typeof grant.nodeId !== "string" ||
      !isFileTransferCommand(grant.command) ||
      typeof grant.requestedPath !== "string" ||
      typeof grant.canonicalPath !== "string"
    ) {
      return [];
    }
    return [
      {
        nodeId: grant.nodeId,
        command: grant.command,
        requestedPath: grant.requestedPath,
        canonicalPath: grant.canonicalPath,
      },
    ];
  });
}

function isFileTransferCommand(value: unknown): value is FileTransferNodeInvokeCommand {
  return (
    typeof value === "string" &&
    FILE_TRANSFER_NODE_INVOKE_COMMANDS.some((command) => command === value)
  );
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
  const normalizedTarget = target.replace(/\\/gu, "/");
  for (const pattern of patterns) {
    const normalizedPattern = pattern.replace(/\\/gu, "/");
    if (
      minimatch(target, pattern, { dot: true }) ||
      minimatch(normalizedTarget, normalizedPattern, { dot: true })
    ) {
      return true;
    }
  }
  return false;
}

function matchesAnyDeny(target: string, patterns: string[]): boolean {
  if (matchesAny(target, patterns)) {
    return true;
  }
  return matchesAny(`${target.replace(/[\\/]+$/u, "")}/`, patterns);
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
 * Check raw segments before glob matching: normalizing away '..' could authorize
 * traversal through an allowed prefix. Both separators count for Windows nodes.
 */
export function containsParentRefSegment(p: string): boolean {
  const unified = p.replace(/\\/gu, "/");
  return unified.split("/").includes("..");
}

type FilePolicyInput = {
  nodeId: string;
  nodeDisplayName?: string;
  kind: FilePolicyKind;
  command?: FileTransferNodeInvokeCommand;
  path: string;
  pluginConfig?: Record<string, unknown>;
};

function evaluateFilePolicyInternal(
  input: FilePolicyInput,
  constraintsOnly: boolean,
  pluginPolicy = readFileTransferConfig(input.pluginConfig),
): FilePolicyDecision {
  if (containsParentRefSegment(input.path)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path contains '..' segments; reject before glob match",
      askable: false,
    };
  }
  const config = pluginPolicy ? readNodes(pluginPolicy) : null;
  if (!pluginPolicy || !config) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason:
        "no plugins.entries.file-transfer.config.nodes config; file-transfer is deny-by-default until configured",
      askable: false,
    };
  }
  if (
    pluginPolicy.policyVersion !== FILE_TRANSFER_POLICY_VERSION &&
    hasLegacyPositiveRules(pluginPolicy)
  ) {
    return {
      ok: false,
      code: "POLICY_MIGRATION_REQUIRED",
      reason:
        "older file-transfer permissions need review; run `openclaw file-transfer approvals migrate`",
      askable: false,
    };
  }
  const resolved = resolveNodePolicy(config, input.nodeId, input.nodeDisplayName);
  if (!resolved) {
    return {
      ok: false,
      code: "NO_POLICY",
      reason: `no file-transfer policy entry for "${input.nodeDisplayName ?? input.nodeId}"; configure plugins.entries.file-transfer.config.nodes or "*"`,
      askable: false,
    };
  }
  const nodeConfig = resolved.entry;
  const askMode = normalizeAskMode(nodeConfig.ask);

  const maxBytes =
    typeof nodeConfig.maxBytes === "number" && Number.isFinite(nodeConfig.maxBytes)
      ? Math.max(1, Math.floor(nodeConfig.maxBytes))
      : undefined;
  const followSymlinks = nodeConfig.followSymlinks === true;

  // Deny patterns also constrain standing grants and interactive approvals.
  const denyPatterns = normalizeGlobs(nodeConfig.denyPaths);
  if (matchesAnyDeny(input.path, denyPatterns)) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path matches a denyPaths pattern",
      askable: false,
      askMode,
      maxBytes,
      followSymlinks,
    };
  }

  if (constraintsOnly) {
    return { ok: true, reason: "matched-allow", maxBytes, followSymlinks };
  }

  const pendingReapproval = readPendingReapprovals(pluginPolicy).find((pending) =>
    matchesPendingReapproval(input, resolved.key, pending),
  );

  if (askMode === "always") {
    return {
      ok: true,
      reason: "ask-always",
      askMode,
      maxBytes,
      followSymlinks,
      pendingReapprovalSelector: pendingReapproval?.selector,
    };
  }

  const allowPatterns =
    input.kind === "read"
      ? normalizeGlobs(nodeConfig.allowReadPaths)
      : normalizeGlobs(nodeConfig.allowWritePaths);

  if (allowPatterns.length > 0 && matchesAny(input.path, allowPatterns)) {
    return { ok: true, reason: "matched-allow", maxBytes, followSymlinks };
  }

  // Match exact standing grants by stable identity and command. These
  // strings are opaque node paths: never normalize them or feed them to a
  // glob matcher on the Gateway.
  if (input.command) {
    const literal = readLiteralGrants(pluginPolicy).find(
      (grant) =>
        grant.nodeId === input.nodeId &&
        grant.command === input.command &&
        grant.requestedPath === input.path,
    );
    if (literal) {
      return {
        ok: true,
        reason: "matched-literal",
        expectedCanonicalPath: literal.canonicalPath,
        maxBytes,
        followSymlinks,
      };
    }
  }

  // A migration-selected exact path is the only miss that becomes askable.
  // This preserves the node's authored ask mode while replacing ambiguous
  // legacy authority with a node- and command-bound approval on first use.
  if (pendingReapproval) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: "path requires exact reapproval",
      askable: true,
      askMode,
      maxBytes,
      followSymlinks,
      pendingReapprovalSelector: pendingReapproval.selector,
    };
  }

  if (askMode === "on-miss") {
    return {
      ok: false,
      code: "POLICY_DENIED",
      reason: `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
      askable: true,
      askMode,
      maxBytes,
      followSymlinks,
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
    maxBytes,
    followSymlinks,
  };
}

/** Carry only this node's read rules to the host that prepares a Skill bundle. */
export function snapshotNodeFileReadPolicy(input: {
  nodeId: string;
  nodeDisplayName?: string;
  pluginConfig?: Record<string, unknown>;
}) {
  const policy = readFileTransferConfig(input.pluginConfig);
  const nodes = policy && readNodes(policy);
  const resolved = nodes && resolveNodePolicy(nodes, input.nodeId, input.nodeDisplayName);
  if (!resolved) {
    throw new Error("Node file read policy is unavailable");
  }
  const { ask, allowReadPaths, denyPaths, maxBytes, followSymlinks } = resolved.entry;
  return {
    nodeId: input.nodeId,
    pluginConfig: {
      policyVersion: policy?.policyVersion,
      nodes: {
        [input.nodeId]: {
          ask,
          allowReadPaths: normalizeGlobs(allowReadPaths),
          denyPaths: normalizeGlobs(denyPaths),
          maxBytes,
          followSymlinks,
        },
      },
    },
  };
}

/** A delegated read uses the Gateway snapshot, never the Node process's local policy. */
export function evaluateFileReadPolicySnapshot(input: {
  nodeId: string;
  pluginConfig: Record<string, unknown>;
  path: string;
}): FilePolicyDecision {
  return evaluateFilePolicyInternal(
    { ...input, kind: "read" },
    false,
    readFileTransferConfigFromPluginConfig(input.pluginConfig),
  );
}

export function evaluateFilePolicy(input: FilePolicyInput): FilePolicyDecision {
  return evaluateFilePolicyInternal(input, false);
}

export function evaluateFilePolicyConstraints(input: FilePolicyInput): FilePolicyDecision {
  return evaluateFilePolicyInternal(input, true);
}

/** Persist an exact standing grant only after node canonical-path validation. */
export async function persistLiteralGrant(input: PersistLiteralGrantInput): Promise<void> {
  if (!isFileTransferCommand(input.command)) {
    throw new Error("unsupported file-transfer command");
  }
  if (!input.nodeId || !input.requestedPath || !input.canonicalPath) {
    throw new Error("file-transfer literal grant requires node, requested, and canonical paths");
  }
  await mutateConfigFile({
    afterWrite: { mode: "none", reason: "file-transfer literal approval update" },
    mutate: (draft) => {
      const plugins = (draft.plugins ??= {}) as Record<string, unknown>;
      const entries = (plugins.entries ??= {}) as Record<string, unknown>;
      const pluginEntry = (entries["file-transfer"] ??= {}) as Record<string, unknown>;
      const pluginConfig = (pluginEntry.config ??= {}) as Record<string, unknown>;
      const policyConfig = pluginConfig as FileTransferPolicyConfig;
      if (
        policyConfig.policyVersion !== FILE_TRANSFER_POLICY_VERSION &&
        hasLegacyPositiveRules(policyConfig)
      ) {
        throw new Error(
          "older file-transfer permissions need review; run `openclaw file-transfer approvals migrate`",
        );
      }
      policyConfig.policyVersion = FILE_TRANSFER_POLICY_VERSION;
      const grants = readLiteralGrants(policyConfig).filter(
        (grant) =>
          grant.nodeId !== input.nodeId ||
          grant.command !== input.command ||
          grant.requestedPath !== input.requestedPath,
      );
      grants.push({
        nodeId: input.nodeId,
        command: input.command,
        requestedPath: input.requestedPath,
        canonicalPath: input.canonicalPath,
      });
      policyConfig.literalGrants = grants;
      const kind =
        input.command === "file.write" || input.command === "file.create" ? "write" : "read";
      policyConfig.pendingReapprovals = readPendingReapprovals(policyConfig).filter(
        (pending) =>
          pending.kind !== kind ||
          pending.path !== input.requestedPath ||
          pending.selector !== input.pendingReapprovalSelector,
      );
    },
  });
}

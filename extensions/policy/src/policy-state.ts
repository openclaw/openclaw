import { createHash } from "node:crypto";
import { parseOcDocument, type MdAst } from "@openclaw/oc-path/api.js";

export type PolicyAttestation = {
  readonly checkedAt: string;
  readonly policy?: {
    readonly path: string;
    readonly hash: string;
  };
  readonly workspace: {
    readonly scope: "policy";
    readonly hash: string;
  };
  readonly findingsHash?: string;
  readonly attestationHash?: string;
};

export type PolicyEvidence = {
  readonly channels: readonly PolicyChannelEvidence[];
  readonly tools: readonly PolicyToolEvidence[];
};

export type PolicyChannelEvidence = {
  readonly id: string;
  readonly provider: string;
  readonly source: string;
  readonly enabled?: boolean;
};

export type PolicyToolEvidence = {
  readonly id: string;
  readonly source: string;
  readonly line: number;
  readonly risk?: string;
  readonly sensitivity?: string;
  readonly capabilities?: readonly string[];
};

const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

export function policyDocumentHash(policy: unknown): string {
  return sha256(stableJson(policy));
}

export function policyWorkspaceHash(evidence: PolicyEvidence): string {
  return sha256(stableJson(evidence));
}

export function policyFindingsHash(findings: readonly unknown[]): string {
  return sha256(stableJson(findings));
}

export function policyAttestationHash(input: {
  readonly ok: boolean;
  readonly policyHash?: string;
  readonly workspaceHash: string;
  readonly findingsHash: string;
}): string {
  return sha256(stableJson(input));
}

export function createPolicyAttestation(input: {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly policyPath: string;
  readonly policyHash?: string;
  readonly evidence: PolicyEvidence;
  readonly findings: readonly unknown[];
}): PolicyAttestation {
  const workspaceHash = policyWorkspaceHash(input.evidence);
  const findingsHash = policyFindingsHash(input.findings);
  return {
    checkedAt: input.checkedAt,
    ...(input.policyHash === undefined
      ? {}
      : {
          policy: {
            path: input.policyPath,
            hash: input.policyHash,
          },
        }),
    workspace: {
      scope: "policy",
      hash: workspaceHash,
    },
    findingsHash,
    attestationHash: policyAttestationHash({
      ok: input.ok,
      policyHash: input.policyHash,
      workspaceHash,
      findingsHash,
    }),
  };
}

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: { readonly toolsRaw?: string } = {},
): PolicyEvidence {
  return {
    channels: scanPolicyChannels(cfg),
    tools: options.toolsRaw === undefined ? [] : scanPolicyTools(options.toolsRaw),
  };
}

export function scanPolicyChannels(cfg: Record<string, unknown>): readonly PolicyChannelEvidence[] {
  return Object.entries(configuredChannels(cfg))
    .filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        provider: string;
        source: string;
        enabled?: boolean;
      } = {
        id,
        provider: id,
        source: `oc://openclaw.config/channels/${id}`,
      };
      if (isRecord(value) && typeof value.enabled === "boolean") {
        entry.enabled = value.enabled;
      }
      return entry;
    });
}

export function scanPolicyTools(raw: string): readonly PolicyToolEvidence[] {
  const parsed = parseOcDocument(raw, { fileName: "TOOLS.md" });
  if (parsed.ast.kind !== "md") {
    return [];
  }
  return scanPolicyToolHeaders(parsed.ast);
}

function scanPolicyToolHeaders(ast: MdAst): readonly PolicyToolEvidence[] {
  const tools = ast.blocks.find((entry) => entry.slug === "tools");
  if (tools === undefined) {
    return [];
  }
  return tools.bodyText.split(/\r?\n/).flatMap((line, index): readonly PolicyToolEvidence[] => {
    const match = /^###\s+([^\s#]+)(.*)$/.exec(line);
    if (match === null) {
      return [];
    }
    const id = match[1].trim();
    const meta = match[2] ?? "";
    const entry: {
      id: string;
      source: string;
      line: number;
      risk?: string;
      sensitivity?: string;
      capabilities?: readonly string[];
    } = {
      id,
      source: `oc://TOOLS.md/tools/${id}`,
      line: tools.line + index + 1,
    };
    const risk = riskFromMeta(meta);
    const sensitivity = /\bsensitivity\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1]?.toLowerCase();
    const capabilities = meta.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    if (risk !== undefined) {
      entry.risk = risk;
    }
    if (sensitivity !== undefined) {
      entry.sensitivity = sensitivity;
    }
    if (capabilities.length > 0) {
      entry.capabilities = capabilities;
    }
    return [entry];
  });
}

function riskFromMeta(meta: string): string | undefined {
  const namedRisk = /\brisk\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1];
  if (namedRisk !== undefined) {
    return namedRisk.toLowerCase();
  }
  const alias = /\bR([0-5])\b/.exec(meta)?.[1];
  switch (alias) {
    case "0":
    case "1":
      return "low";
    case "2":
    case "3":
      return "medium";
    case "4":
      return "high";
    case "5":
      return "critical";
    default:
      return undefined;
  }
}

function configuredChannels(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.channels) ? cfg.channels : {};
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

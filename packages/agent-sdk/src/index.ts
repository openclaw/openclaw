// @openclaw/agent-sdk — Agent SDK Packaging types and CLI entry points.

// ── Manifest ────────────────────────────────────────────────────────

export interface AgentPackageManifest {
  $schema?: string;
  name: string;
  version: string;
  description: string;
  license?: string;
  metadata?: PackageMetadata;
  files: FilesDeclaration;
  skills?: SkillDeclaration[];
  secrets?: SecretsDeclaration;
  tools?: ToolsDeclaration;
  channels?: ChannelsDeclaration;
  schedules?: ScheduleDeclaration[];
  policy?: PolicyDeclaration;
}

export interface PackageMetadata {
  author?: string;
  homepage?: string;
  repository?: string;
  tags?: string[];
}

export interface FilesDeclaration {
  copy: FileCopyEntry[];
  mutable: FileMutableEntry[];
}

export interface FileCopyEntry {
  src: string;
  dest: string;
}

export interface FileMutableEntry {
  dest: string;
  description?: string;
}

export interface SkillDeclaration {
  path: string;
  required?: boolean;
}

export interface SecretsDeclaration {
  consumer: SecretConsumer[];
  mapping: Record<string, SecretMapping>;
  audit?: SecretAudit;
}

export interface SecretConsumer {
  name: string;
  required: boolean;
  description?: string;
}

export type SecretMapping =
  | { source: "env"; key: string }
  | { source: "gateway"; ref: string }
  | { source: "file"; path: string };

export interface SecretAudit {
  logAccess?: boolean;
  redactInTranscripts?: boolean;
}

export interface ToolsDeclaration {
  allow?: string[];
  deny?: string[];
  sandbox?: SandboxDeclaration;
}

export interface SandboxDeclaration {
  mode?: "inherit" | "require" | "none";
  elevated?: boolean;
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
}

export interface NetworkPolicy {
  egress?: "full" | "restricted" | "none";
  allowedDomains?: string[];
  deniedDomains?: string[];
  dnsRebindingCheck?: boolean;
  denyPrivateRanges?: boolean;
}

export interface FilesystemPolicy {
  readPaths?: string[];
  writePaths?: string[];
  denyPaths?: string[];
}

export interface ChannelsDeclaration {
  bindings: ChannelBinding[];
}

export type ChannelBinding = DiscordBinding | TelegramBinding | WhatsAppBinding | SignalBinding;

export interface DiscordBinding {
  channel: "discord";
  guildId: string;
  channelId: string;
  requireMention?: boolean;
}

export interface TelegramBinding {
  channel: "telegram";
  chatId: string;
}

export interface WhatsAppBinding {
  channel: "whatsapp";
  phone: string;
}

export interface SignalBinding {
  channel: "signal";
  phone: string;
}

export interface ScheduleDeclaration {
  name: string;
  cron: string;
  tz?: string;
  payload: SchedulePayload;
  sessionTarget?: "isolated" | "current";
}

export type SchedulePayload =
  | { kind: "agentTurn"; message: string }
  | { kind: "systemEvent"; text: string };

export interface PolicyDeclaration {
  scope?: "package" | "global";
  denyMutableInstructionFiles?: boolean;
  allowMutableUserInstructionFiles?: boolean;
  onUpgrade?: "preserve-custom" | "reset" | "prompt";
  maxTokensPerTurn?: number;
  allowedModels?: string[];
}

// ── Integrity Manifest ──────────────────────────────────────────────

export interface IntegrityManifest {
  version: 1;
  algorithm: "sha256";
  package: {
    name: string;
    version: string;
  };
  files: Record<string, string>;
  skills: Record<string, string>;
  generatedAt: string;
}

// ── Validation ──────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

// ── Constants ───────────────────────────────────────────────────────

export const INSTRUCTION_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"] as const;

export const DEFAULT_DENY_PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "fd00::/8",
  "::1/128",
] as const;

// ── Hash utilities ──────────────────────────────────────────────────

// ── Policy enforcement ──────────────────────────────────────────────

export { resolveSecret, isToolAllowed } from "./policy/secrets.js";
export type {
  SecretResolution,
  SecretSource,
  SecretEnvSource,
  SecretGatewaySource,
  SecretFileSource,
} from "./policy/secrets.js";

export { checkNetworkEgress, isPrivateIp, checkDnsRebinding } from "./policy/network.js";
export type { EgressCheckResult } from "./policy/network.js";

// ── Config compiler ──────────────────────────────────────────────────

export { compileManifest, validateRoundTrip } from "./compiler/compiler.js";
export type { ConfigDiff, CompilerOptions } from "./compiler/compiler.js";

// ── Mutation detection + quarantine ─────────────────────────────────

export {
  checkMutation,
  quarantinePackage,
  isQuarantined,
  getQuarantineRecord,
  liftQuarantine,
  isToolAllowedInQuarantine,
  getQuarantineToolAllowlist,
} from "./quarantine/mutation.js";
export type { MutationCheckResult, MutatedFile, QuarantineRecord } from "./quarantine/mutation.js";

// ── Live config integration ──────────────────────────────────────────

export { applyConfigDiff, rollbackConfig, enableWithLiveConfig } from "./compiler/live.js";
export type { LiveConfigResult } from "./compiler/live.js";

// ── Declarative upgrade ─────────────────────────────────────────────

export { computeUpgrade, validateUpgrade } from "./compiler/upgrade.js";
export type { UpgradeOptions, UpgradeResult } from "./compiler/upgrade.js";

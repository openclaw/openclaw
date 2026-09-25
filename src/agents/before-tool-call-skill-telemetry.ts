import os from "node:os";
import path from "node:path";
/** Skill-usage telemetry matching and emission for before_tool_call execution. */
import { emitTrustedSkillUsedDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import {
  resolveSkillTelemetrySource,
  resolveSkillTelemetrySourceValue,
} from "../skills/loading/source.js";
import type { SkillSnapshot, SkillTelemetrySource } from "../skills/types.js";
import { isPlainObject } from "../utils.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { normalizeFileToolPathParam } from "./agent-tools.params.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { canonicalizePath } from "./utils/paths.js";

export type SkillUsageMatch = {
  skillFile?: string;
  skillName: string;
  skillSource: SkillTelemetrySource;
  activation: "command" | "read";
};

function canonicalSkillFile(value: string | undefined): string | undefined {
  const skillFile = value?.trim();
  return skillFile && path.isAbsolute(skillFile)
    ? canonicalizePath(path.resolve(skillFile))
    : undefined;
}

function resolvedSkillUsageMatch(params: {
  activation: SkillUsageMatch["activation"];
  skill: NonNullable<SkillSnapshot["resolvedSkills"]>[number];
}): SkillUsageMatch {
  const skillFile = canonicalSkillFile(params.skill.filePath);
  return {
    skillName: params.skill.name.trim(),
    skillSource: resolveSkillTelemetrySource(params.skill),
    activation: params.activation,
    ...(skillFile ? { skillFile } : {}),
  };
}

function findResolvedSkillUsageMatch(params: {
  activation: SkillUsageMatch["activation"];
  skillName: string;
  skillSource: SkillTelemetrySource;
  snapshot?: SkillSnapshot;
}): SkillUsageMatch | undefined {
  const skillName = params.skillName.trim();
  const candidates = (params.snapshot?.resolvedSkills ?? []).filter(
    (skill) => skill.name.trim() === skillName,
  );
  const skill =
    candidates.find((candidate) => resolveSkillTelemetrySource(candidate) === params.skillSource) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  return skill ? resolvedSkillUsageMatch({ activation: params.activation, skill }) : undefined;
}

function resolveRelativeToolPath(candidate: string, ctx?: HookContext): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("node://")) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  const base = ctx?.workspaceDir ?? ctx?.cwd;
  return base ? path.resolve(base, trimmed) : undefined;
}

function readToolPathCandidate(params: unknown, ctx?: HookContext): string | undefined {
  return isPlainObject(params) && typeof params.path === "string"
    ? resolveRelativeToolPath(normalizeFileToolPathParam(params.path), ctx)
    : undefined;
}

function findSkillInstructionMatch(
  snapshot: SkillSnapshot,
  candidate: string,
): SkillUsageMatch | undefined {
  const skill = snapshot.resolvedSkills?.findLast((entry) => {
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      return false;
    }
    const filePath = typeof entry.filePath === "string" ? entry.filePath.trim() : "";
    const baseDir = typeof entry.baseDir === "string" ? entry.baseDir.trim() : "";
    return (
      (filePath &&
        (filePath.startsWith("node://")
          ? filePath === candidate
          : path.isAbsolute(filePath) && path.resolve(filePath) === candidate)) ||
      (baseDir && path.isAbsolute(baseDir) && path.resolve(baseDir, "SKILL.md") === candidate)
    );
  });
  return skill ? resolvedSkillUsageMatch({ activation: "read", skill }) : undefined;
}

export function findSkillUsageMatch(params: {
  toolName: string;
  toolParams: unknown;
  ctx?: HookContext;
}): SkillUsageMatch | undefined {
  const command = params.ctx?.skillCommand;
  if (command) {
    const commandToolName = normalizeToolPolicyName(command.toolName ?? params.toolName);
    if (!commandToolName || commandToolName === params.toolName) {
      const skillSource = resolveSkillTelemetrySourceValue(command.skillSource);
      const snapshotMatch = findResolvedSkillUsageMatch({
        activation: "command",
        skillName: command.skillName,
        skillSource,
        snapshot: params.ctx?.skillsSnapshot,
      });
      const skillFile = canonicalSkillFile(command.skillFile) ?? snapshotMatch?.skillFile;
      return {
        skillName: command.skillName,
        skillSource,
        activation: "command",
        ...(skillFile ? { skillFile } : {}),
      };
    }
  }

  if (params.toolName !== "read") {
    return undefined;
  }
  const candidate = readToolPathCandidate(params.toolParams, params.ctx);
  if (!candidate) {
    return undefined;
  }
  if (params.ctx?.skillsSnapshot?.resolvedSkills?.length) {
    return findSkillInstructionMatch(params.ctx.skillsSnapshot, candidate);
  }
  const match = params.ctx?.skillUsagePaths?.findLast(
    (entry) => path.resolve(entry.readPath) === candidate,
  );
  return match
    ? {
        skillFile: match.skillFile,
        skillName: match.skillName,
        skillSource: match.skillSource,
        activation: "read",
      }
    : undefined;
}

export function emitSkillUsedDiagnostic(params: {
  ctx?: HookContext;
  match: SkillUsageMatch;
  toolName: string;
  toolCallId?: string;
}): void {
  const trace = params.ctx?.trace
    ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(params.ctx.trace))
    : undefined;
  // Skill file paths are trusted-internal accounting data. Public diagnostic
  // payloads stay path-free even when diagnostics are enabled.
  emitTrustedSkillUsedDiagnosticEvent(
    {
      type: "skill.used",
      ...(params.ctx?.runId && { runId: params.ctx.runId }),
      ...(params.ctx?.sessionKey && { sessionKey: params.ctx.sessionKey }),
      ...(params.ctx?.sessionId && { sessionId: params.ctx.sessionId }),
      ...(params.ctx?.agentId && { agentId: params.ctx.agentId }),
      ...(trace && { trace }),
      skillName: params.match.skillName,
      skillSource: params.match.skillSource,
      activation: params.match.activation,
      toolName: params.toolName,
      ...(params.toolCallId && { toolCallId: params.toolCallId }),
    },
    params.match.skillFile ? { skillUsage: { skillFile: params.match.skillFile } } : undefined,
  );
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { SkillWorkshopConfig } from "./config.js";
import {
  applyProposalToWorkspace,
  normalizeSkillName,
  prepareProposalWrite,
  writeSupportFile,
} from "./skills.js";
import type { SkillChange, SkillProposal, SkillWorkshopStatus } from "./types.js";
import { createStoreForContext, resolveWorkspaceDir } from "./workshop.js";

// ── Curator integration (lightweight, lazy-imported) ────────────────────────

let _stampAgentCreated: ((wsDir: string, name: string) => Promise<unknown>) | null = null;
let _incrementPatch: ((wsDir: string, name: string) => Promise<unknown>) | null = null;
let _curatorLoadUsage:
  | ((wsDir: string) => Promise<{ skills: Record<string, { pinned?: boolean }> }>)
  | null = null;

async function ensureCuratorModules() {
  if (_stampAgentCreated && _curatorLoadUsage) return;
  try {
    const curatorTelemetry = await import("../../skill-curator/src/telemetry.js");
    _stampAgentCreated = curatorTelemetry.stampAgentCreated;
    _incrementPatch = curatorTelemetry.incrementPatch;
    _curatorLoadUsage = curatorTelemetry.loadUsage;
  } catch {
    // skill-curator not installed — gracefully skip
  }
}

async function stampAgentCreatedIfNew(workspaceDir: string, skillName: string, created: boolean) {
  if (!created) return;
  await ensureCuratorModules();
  if (_stampAgentCreated) {
    try {
      await _stampAgentCreated(workspaceDir, skillName);
    } catch {
      // non-critical — don't fail skill creation over telemetry stamp
    }
  }
}

async function incrementPatchIfCurator(workspaceDir: string, skillName: string) {
  await ensureCuratorModules();
  if (_incrementPatch) {
    try {
      await _incrementPatch(workspaceDir, skillName);
    } catch {
      // non-critical — don't fail workshop mutation over telemetry
    }
  }
}

async function checkSkillPinned(workspaceDir: string, skillName: string): Promise<boolean> {
  await ensureCuratorModules();
  if (!_curatorLoadUsage) return false;
  try {
    const usage = await _curatorLoadUsage(workspaceDir);
    return usage.skills[skillName]?.pinned === true;
  } catch {
    return false;
  }
}

// ── Tool params ─────────────────────────────────────────────────────────────

type ToolParams = {
  action?: string;
  id?: string;
  status?: SkillWorkshopStatus;
  skillName?: string;
  title?: string;
  reason?: string;
  description?: string;
  body?: string;
  section?: string;
  oldText?: string;
  newText?: string;
  relativePath?: string;
  apply?: boolean;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildProposal(params: {
  workspaceDir: string;
  raw: ToolParams;
  source: "tool";
}): SkillProposal {
  const skillName = normalizeSkillName(readString(params.raw.skillName) ?? "");
  if (!skillName) {
    throw new Error("skillName required");
  }
  const now = Date.now();
  const title = readString(params.raw.title) ?? `Skill update: ${skillName}`;
  const reason = readString(params.raw.reason) ?? "Tool-created skill update";
  const body = readString(params.raw.body);
  const description = readString(params.raw.description) ?? title;
  let change: SkillChange;
  if (params.raw.oldText !== undefined || params.raw.newText !== undefined) {
    const oldText = readString(params.raw.oldText);
    const newText = readString(params.raw.newText);
    if (!oldText || !newText) {
      throw new Error("oldText and newText required for replace");
    }
    change = { kind: "replace", oldText, newText };
  } else if (readString(params.raw.section)) {
    if (!body) {
      throw new Error("body required");
    }
    change = {
      kind: "append",
      section: readString(params.raw.section) ?? "Workflow",
      body,
      description,
    };
  } else {
    if (!body) {
      throw new Error("body required");
    }
    change = { kind: "create", description, body };
  }
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    workspaceDir: params.workspaceDir,
    skillName,
    title,
    reason,
    source: params.source,
    status: "pending",
    change,
  };
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function createSkillWorkshopTool(params: {
  api: OpenClawPluginApi;
  config: SkillWorkshopConfig;
  ctx: { workspaceDir?: string };
}) {
  return {
    name: "skill_workshop",
    label: "Skill Workshop",
    description:
      "Create, queue, inspect, approve, or safely apply workspace skill updates for repeatable workflows.",
    parameters: Type.Object({
      action: Type.String({
        enum: [
          "status",
          "list_pending",
          "list_quarantine",
          "inspect",
          "suggest",
          "apply",
          "reject",
          "delete",
          "write_support_file",
        ],
      }),
      id: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.String({ enum: ["pending", "applied", "rejected", "quarantined"] }),
      ),
      skillName: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      section: Type.Optional(Type.String()),
      oldText: Type.Optional(Type.String()),
      newText: Type.Optional(Type.String()),
      relativePath: Type.Optional(Type.String()),
      apply: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as ToolParams;
      const action = raw.action ?? "status";
      const workspaceDir = resolveWorkspaceDir(params);
      const store = createStoreForContext(params);
      if (action === "status") {
        const all = await store.list();
        return jsonResult({
          workspaceDir,
          pending: all.filter((item) => item.status === "pending").length,
          quarantined: all.filter((item) => item.status === "quarantined").length,
          applied: all.filter((item) => item.status === "applied").length,
          rejected: all.filter((item) => item.status === "rejected").length,
        });
      }
      if (action === "list_pending") {
        return jsonResult(await store.list(raw.status ?? "pending"));
      }
      if (action === "list_quarantine") {
        return jsonResult(await store.list("quarantined"));
      }
      if (action === "inspect") {
        if (!raw.id) {
          throw new Error("id required");
        }
        return jsonResult(await store.get(raw.id));
      }
      if (action === "suggest") {
        const proposal = buildProposal({ workspaceDir, raw, source: "tool" });
        const shouldApply =
          raw.apply === true || (raw.apply !== false && params.config.approvalPolicy === "auto");
        if (shouldApply) {
          const prepared = await prepareProposalWrite({
            proposal,
            maxSkillBytes: params.config.maxSkillBytes,
          });
          const critical = prepared.findings.find((finding) => finding.severity === "critical");
          if (critical) {
            const stored = await store.add(
              {
                ...proposal,
                status: "quarantined",
                updatedAt: Date.now(),
                scanFindings: prepared.findings,
                quarantineReason: critical.message,
              },
              params.config.maxPending,
            );
            return jsonResult({ status: "quarantined", proposal: stored });
          }
          const applied = await applyProposalToWorkspace({
            proposal,
            maxSkillBytes: params.config.maxSkillBytes,
          });
          // Stamp agent-created marker for new skills
          await stampAgentCreatedIfNew(workspaceDir, proposal.skillName, applied.created);
          // Increment patch telemetry for all mutations
          await incrementPatchIfCurator(workspaceDir, proposal.skillName);
          const stored = await store.add(
            {
              ...proposal,
              status: "applied",
              updatedAt: Date.now(),
              scanFindings: applied.findings,
            },
            params.config.maxPending,
          );
          return jsonResult({ status: "applied", skillPath: applied.skillPath, proposal: stored });
        }
        const prepared = await prepareProposalWrite({
          proposal,
          maxSkillBytes: params.config.maxSkillBytes,
        });
        const critical = prepared.findings.find((finding) => finding.severity === "critical");
        if (critical) {
          const stored = await store.add(
            {
              ...proposal,
              status: "quarantined",
              updatedAt: Date.now(),
              scanFindings: prepared.findings,
              quarantineReason: critical.message,
            },
            params.config.maxPending,
          );
          return jsonResult({ status: "quarantined", proposal: stored });
        }
        const stored = await store.add(
          { ...proposal, scanFindings: prepared.findings },
          params.config.maxPending,
        );
        return jsonResult({ status: "pending", proposal: stored });
      }
      if (action === "apply") {
        if (!raw.id) {
          throw new Error("id required");
        }
        const proposal = await store.get(raw.id);
        if (!proposal) {
          throw new Error(`proposal not found: ${raw.id}`);
        }
        if (proposal.status === "quarantined") {
          throw new Error("quarantined proposal cannot be applied");
        }
        const applied = await applyProposalToWorkspace({
          proposal,
          maxSkillBytes: params.config.maxSkillBytes,
        });
        // Stamp agent-created marker for new skills applied from queue
        await stampAgentCreatedIfNew(workspaceDir, proposal.skillName, applied.created);
        // Increment patch telemetry for all mutations
        await incrementPatchIfCurator(workspaceDir, proposal.skillName);
        const updated = await store.updateStatus(raw.id, "applied");
        return jsonResult({ status: "applied", skillPath: applied.skillPath, proposal: updated });
      }
      if (action === "reject") {
        if (!raw.id) {
          throw new Error("id required");
        }
        return jsonResult(await store.updateStatus(raw.id, "rejected"));
      }
      if (action === "delete") {
        const skillName = normalizeSkillName(readString(raw.skillName) ?? "");
        if (!skillName) {
          throw new Error("skillName required for delete");
        }
        // Check if skill is pinned — refuse delete with clear instruction
        const pinned = await checkSkillPinned(workspaceDir, skillName);
        if (pinned) {
          throw new Error(
            `Skill "${skillName}" is pinned. Unpin it first with "openclaw curator unpin ${skillName}" before deleting.`,
          );
        }
        // Delete the skill directory
        const skillsDir = path.join(workspaceDir, "skills");
        const skillDir = path.join(skillsDir, skillName);
        try {
          await fs.rm(skillDir, { recursive: true, force: true });
          await incrementPatchIfCurator(workspaceDir, skillName);
          return jsonResult({ status: "deleted", skillName });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return jsonResult({ status: "not_found", skillName });
          }
          throw new Error(`Failed to delete skill "${skillName}": ${msg}`);
        }
      }
      if (action === "write_support_file") {
        const skillName = readString(raw.skillName);
        const relativePath = readString(raw.relativePath);
        const body = raw.body;
        if (!skillName || !relativePath || typeof body !== "string") {
          throw new Error("skillName, relativePath, and body required");
        }
        const filePath = await writeSupportFile({
          workspaceDir,
          skillName,
          relativePath,
          content: body,
          maxBytes: params.config.maxSkillBytes,
        });
        return jsonResult({ status: "written", filePath });
      }
      throw new Error(`unknown action: ${action}`);
    },
  };
}

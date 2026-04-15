#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffInventoryEntries, runBaselineInventoryCheck } from "./lib/guard-inventory-utils.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(repoRoot, "test", "fixtures", "claw-code-parity-harness-baseline.json");

/**
 * @typedef {"present" | "partial" | "missing"} ParityStatus
 *
 * @typedef {Object} ParityLaneEntry
 * @property {number} lane
 * @property {string} laneName
 * @property {ParityStatus} status
 * @property {string} summary
 * @property {string[]} evidence
 */

/**
 * @param {string} relativePath
 */
function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

/**
 * @param {string} relativePath
 */
async function readRepoFile(relativePath) {
  return await fs.readFile(repoPath(relativePath), "utf8");
}

/**
 * @param {string} relativePath
 * @param {RegExp} pattern
 */
async function hasPattern(relativePath, pattern) {
  const text = await readRepoFile(relativePath);
  return pattern.test(text);
}

/**
 * @param {ParityLaneEntry} left
 * @param {ParityLaneEntry} right
 */
function compareLaneEntries(left, right) {
  return left.lane - right.lane || left.laneName.localeCompare(right.laneName);
}

/**
 * @param {ParityLaneEntry[]} entries
 */
function formatInventoryHuman(entries) {
  const lines = ["Claw-code parity harness snapshot:"];
  for (const entry of entries) {
    lines.push(
      `lane ${entry.lane} (${entry.laneName}): ${entry.status} - ${entry.summary} [${entry.evidence.join(", ")}]`,
    );
  }
  return lines.join("\n");
}

/**
 * @param {ParityLaneEntry} entry
 */
function formatEntry(entry) {
  return `lane ${entry.lane} ${entry.laneName} status=${entry.status} summary=${entry.summary}`;
}

/**
 * @returns {Promise<ParityLaneEntry[]>}
 */
export async function collectClawCodeParityHarnessSnapshot() {
  const [
    bashValidationModule,
    bashValidationWired,
    fileGuardPayloadLimit,
    fileGuardMutationAssert,
    taskRegistryCore,
    taskToolWiring,
    teamToolWiring,
    cronToolRuntime,
    mcpRuntimeBridge,
    lspRuntimeBridge,
    fsPermissionDeniedCore,
    fsPermissionDeniedApplyPatch,
    fsPermissionDeniedSandboxBridge,
    sandboxCapabilityProbe,
  ] = await Promise.all([
    hasPattern("src/agents/bash-validation.ts", /export function validateBashCommand/u),
    hasPattern("src/agents/bash-tools.exec.ts", /validateBashCommand\(/u),
    hasPattern("src/agents/pi-tools.read.ts", /MAX_TOOL_WRITE_CONTENT_BYTES/u),
    hasPattern("src/agents/pi-tools.read.ts", /assertSafeMutationTextPayload/u),
    hasPattern("src/tasks/task-registry.ts", /export function createTaskRecord\(/u),
    hasPattern("src/agents/tools/task-tool.ts", /name:\s*"task"|action:\s*"create"|action:\s*"list"/u),
    hasPattern("src/agents/openclaw-tools.ts", /createTeamTool\(/u),
    hasPattern("src/agents/tools/cron-tool.ts", /name:\s*"cron"/u),
    hasPattern("src/agents/pi-bundle-mcp-runtime.ts", /createSessionMcpRuntime|bundle-mcp/u),
    hasPattern("src/agents/pi-bundle-lsp-runtime.ts", /buildLspTools|lsp_hover_/u),
    hasPattern("src/agents/fs-permission-denied.ts", /E_FS_PERMISSION_DENIED|permission_denied reason=/u),
    hasPattern("src/agents/apply-patch.ts", /createFsPermissionDeniedError/u),
    hasPattern("src/agents/sandbox/fs-bridge-path-safety.ts", /createFsPermissionDeniedError/u),
    hasPattern("src/agents/sandbox.ts", /unshare|capability probe|supportsSandbox/u),
  ]);

  /** @type {ParityLaneEntry[]} */
  const entries = [
    {
      lane: 1,
      laneName: "bash_validation",
      status: bashValidationModule && bashValidationWired ? "present" : "missing",
      summary: bashValidationModule
        ? "Dedicated bash validation module wired into exec."
        : "No dedicated bash validation module wiring detected.",
      evidence: ["src/agents/bash-validation.ts", "src/agents/bash-tools.exec.ts"],
    },
    {
      lane: 2,
      laneName: "ci_sandbox_capability_probe",
      status: sandboxCapabilityProbe ? "present" : "missing",
      summary: sandboxCapabilityProbe
        ? "Sandbox capability probing markers detected."
        : "No explicit sandbox capability probe marker detected.",
      evidence: ["src/agents/sandbox.ts"],
    },
    {
      lane: 3,
      laneName: "file_tool_hardening",
      status: fileGuardPayloadLimit && fileGuardMutationAssert ? "present" : "partial",
      summary:
        fileGuardPayloadLimit && fileGuardMutationAssert
          ? "File mutation payload limits and text/binary guards are in place."
          : "Only part of file mutation hardening markers detected.",
      evidence: ["src/agents/pi-tools.read.ts"],
    },
    {
      lane: 4,
      laneName: "task_registry_runtime",
      status: taskRegistryCore ? "present" : "missing",
      summary: taskRegistryCore
        ? "Task registry runtime core is present."
        : "Task registry runtime core markers are missing.",
      evidence: ["src/tasks/task-registry.ts"],
    },
    {
      lane: 5,
      laneName: "task_tool_wiring",
      status: taskToolWiring ? "present" : "missing",
      summary: taskToolWiring
        ? "Task tool wiring markers are present in agent tools."
        : "No task tool surface wiring markers detected in agent tools.",
      evidence: ["src/agents/tools/task-tool.ts"],
    },
    {
      lane: 6,
      laneName: "team_cron_runtime",
      status: teamToolWiring && cronToolRuntime ? "present" : "partial",
      summary:
        teamToolWiring && cronToolRuntime
          ? "Team + cron runtime tool surfaces are present."
          : "Team + cron runtime appears only partially wired.",
      evidence: ["src/agents/openclaw-tools.ts", "src/agents/tools/cron-tool.ts"],
    },
    {
      lane: 7,
      laneName: "mcp_lifecycle_bridge",
      status: mcpRuntimeBridge ? "present" : "missing",
      summary: mcpRuntimeBridge
        ? "Bundle MCP runtime bridge markers detected."
        : "Bundle MCP runtime bridge markers missing.",
      evidence: ["src/agents/pi-bundle-mcp-runtime.ts"],
    },
    {
      lane: 8,
      laneName: "lsp_client_dispatch",
      status: lspRuntimeBridge ? "present" : "missing",
      summary: lspRuntimeBridge
        ? "Bundle LSP runtime dispatch markers detected."
        : "Bundle LSP runtime dispatch markers missing.",
      evidence: ["src/agents/pi-bundle-lsp-runtime.ts"],
    },
    {
      lane: 9,
      laneName: "permission_enforcement",
      status:
        fsPermissionDeniedCore && fsPermissionDeniedApplyPatch && fsPermissionDeniedSandboxBridge
          ? "present"
          : "partial",
      summary:
        fsPermissionDeniedCore && fsPermissionDeniedApplyPatch && fsPermissionDeniedSandboxBridge
          ? "permission_denied standardization is wired across core fs paths."
          : "permission_denied standardization appears partially wired.",
      evidence: [
        "src/agents/fs-permission-denied.ts",
        "src/agents/apply-patch.ts",
        "src/agents/sandbox/fs-bridge-path-safety.ts",
      ],
    },
  ];

  return entries.toSorted(compareLaneEntries);
}

export async function readExpectedInventory() {
  try {
    return JSON.parse(await fs.readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function diffInventory(expected, actual) {
  return diffInventoryEntries(expected, actual, compareLaneEntries);
}

export async function runClawCodeParityHarnessCheck(argv = process.argv.slice(2), io) {
  return await runBaselineInventoryCheck({
    argv,
    io,
    collectActual: collectClawCodeParityHarnessSnapshot,
    readExpected: readExpectedInventory,
    diffInventory,
    formatInventoryHuman,
    formatEntry,
  });
}

export async function main(argv = process.argv.slice(2), io) {
  const exitCode = await runClawCodeParityHarnessCheck(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}

runAsScript(import.meta.url, main);

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "../../test/helpers/memory-tool-manager-mock.js";
import {
  setKnowledgeTransferPairMode,
  upsertKnowledgeTransferRule,
} from "../infra/knowledge-transfer-policy.js";
import { createMemorySearchTool } from "./tools/memory-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let mockConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

type PendingApproval = {
  id: string;
  approvalKind: "export" | "import";
  resolve: (decision: "allow" | "deny" | null) => void;
  promise: Promise<"allow" | "deny" | null>;
};

function computeFingerprint(text: string, sourcePath: string): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return crypto.createHash("sha256").update(`${sourcePath}\n${normalized}`).digest("hex");
}

describe("sessions_transfer_knowledge proof scenario", () => {
  let rootDir = "";
  let requesterWorkspace = "";
  let sourceWorkspace = "";
  let stateDir = "";
  let previousStateDir: string | undefined;
  let approvalSeq = 0;
  const pendingApprovals = new Map<string, PendingApproval>();
  let approvalRequests = 0;

  beforeEach(async () => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
    callGatewayMock.mockReset();
    approvalSeq = 0;
    pendingApprovals.clear();
    approvalRequests = 0;

    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transfer-proof-"));
    requesterWorkspace = path.join(rootDir, "workspace-requester");
    sourceWorkspace = path.join(rootDir, "workspace-source");
    stateDir = path.join(rootDir, "state");
    await fs.mkdir(requesterWorkspace, { recursive: true });
    await fs.mkdir(path.join(sourceWorkspace, "memory", "public"), { recursive: true });
    await fs.mkdir(path.join(sourceWorkspace, "memory", "private"), { recursive: true });
    await fs.mkdir(path.join(sourceWorkspace, "memory", "transfers"), { recursive: true });

    await fs.writeFile(path.join(sourceWorkspace, "MEMORY.md"), "Fact A\nFact B\n", "utf-8");
    await fs.writeFile(
      path.join(sourceWorkspace, "memory", "public", "share.md"),
      "Fact C\nFact D\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(sourceWorkspace, "memory", "private", "secret.md"),
      "Secret X\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(sourceWorkspace, "memory", "transfers", "previous-transfer.md"),
      [
        "# Knowledge Transfer",
        "",
        "Requester Agent: legacy",
        "Source: memory/public/share.md",
        "Modes: export=auto, import=auto",
        "Transferred metadata that should not be re-imported.",
        "",
      ].join("\n"),
      "utf-8",
    );

    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: {
          enabled: true,
          allow: ["*"],
          knowledgeTransfer: {
            enabled: true,
            defaultExportMode: "ask",
            defaultImportMode: "ask",
            approvalTimeoutSeconds: 120,
          },
        },
      },
      agents: {
        list: [
          { id: "requester", workspace: requesterWorkspace },
          { id: "source", workspace: sourceWorkspace },
        ],
      },
      memory: {
        citations: "off",
      },
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };

      if (request.method === "sessions.resolve") {
        const key = typeof request.params?.key === "string" ? request.params.key : "";
        return { key: key || "agent:source:main" };
      }

      if (request.method === "knowledge.transfer.approval.request") {
        approvalRequests += 1;
        approvalSeq += 1;
        const approvalKindRaw = request.params?.approvalKind;
        const approvalKind = approvalKindRaw === "import" ? "import" : "export";
        const id = `kt-approval-${approvalSeq}`;
        let resolveDecision!: (decision: "allow" | "deny" | null) => void;
        const promise = new Promise<"allow" | "deny" | null>((resolve) => {
          resolveDecision = resolve;
        });
        pendingApprovals.set(id, { id, approvalKind, resolve: resolveDecision, promise });
        return {
          status: "accepted",
          id,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
        };
      }

      if (request.method === "knowledge.transfer.approval.wait") {
        const id = typeof request.params?.id === "string" ? request.params.id : "";
        const pending = pendingApprovals.get(id);
        if (!pending) {
          return { decision: null };
        }
        const decision = await pending.promise;
        return { id, decision };
      }

      if (request.method === "knowledge.transfer.approval.resolve") {
        const id = typeof request.params?.id === "string" ? request.params.id : "";
        const decision = request.params?.decision;
        const pending = pendingApprovals.get(id);
        if (!pending) {
          throw new Error("unknown approval id");
        }
        pendingApprovals.delete(id);
        pending.resolve(decision === "allow" ? "allow" : "deny");
        return { ok: true };
      }

      return {};
    });
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("proves path-level export/import policy, dual approvals, dedupe, deny, auto, and memory retrieval", async () => {
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      pathPattern: "MEMORY.md",
      decision: "ask",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      pathPattern: "MEMORY.md",
      decision: "ask",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      pathPattern: "memory/public/**",
      decision: "auto",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      pathPattern: "memory/public/**",
      decision: "auto",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "export",
      pathPattern: "memory/private/**",
      decision: "hide",
      baseDir: stateDir,
    });
    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      pathPattern: "memory/private/**",
      decision: "hide",
      baseDir: stateDir,
    });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:requester:main",
    }).find((candidate) => candidate.name === "sessions_transfer_knowledge");
    if (!tool) {
      throw new Error("missing sessions_transfer_knowledge tool");
    }

    const runAllow = tool.execute("transfer-allow", {
      sessionKey: "agent:source:main",
      timeoutSeconds: 10,
    });

    await vi.waitFor(() => {
      expect(pendingApprovals.size).toBe(1);
    });
    const exportApprovalId = Array.from(pendingApprovals.keys())[0];
    const exportPending = pendingApprovals.get(exportApprovalId);
    if (!exportPending) {
      throw new Error("missing export approval");
    }
    expect(exportPending.approvalKind).toBe("export");
    pendingApprovals.delete(exportApprovalId);
    exportPending.resolve("allow");

    await vi.waitFor(() => {
      expect(pendingApprovals.size).toBe(1);
    });
    const importApprovalId = Array.from(pendingApprovals.keys())[0];
    const importPending = pendingApprovals.get(importApprovalId);
    if (!importPending) {
      throw new Error("missing import approval");
    }
    expect(importPending.approvalKind).toBe("import");
    pendingApprovals.delete(importApprovalId);
    importPending.resolve("allow");

    const firstResult = (await runAllow).details as {
      status: string;
      candidateTotal: number;
      blockedExport: number;
      blockedImport: number;
      imported: number;
      skippedDuplicate: number;
      transferFile?: string;
      exportApprovalId?: string;
      importApprovalId?: string;
    };

    expect(firstResult.status).toBe("ok");
    expect(firstResult.candidateTotal).toBe(5);
    expect(firstResult.blockedExport).toBe(1);
    expect(firstResult.blockedImport).toBe(0);
    expect(firstResult.imported).toBe(4);
    expect(firstResult.skippedDuplicate).toBe(0);
    expect(firstResult.exportApprovalId).toBe(exportApprovalId);
    expect(firstResult.importApprovalId).toBe(importApprovalId);
    expect(typeof firstResult.transferFile).toBe("string");

    const firstTransferRel = firstResult.transferFile ?? "";
    expect(firstTransferRel.startsWith("memory/transfers/")).toBe(true);
    const firstTransferAbs = path.join(requesterWorkspace, firstTransferRel);
    const firstTransferText = await fs.readFile(firstTransferAbs, "utf-8");
    expect(firstTransferText).toContain("Fact A");
    expect(firstTransferText).toContain("Fact C");
    expect(firstTransferText).not.toContain("Secret X");
    expect(firstTransferText).not.toContain("Transferred metadata that should not be re-imported.");
    expect(firstTransferText).toContain("openclaw-transfer-fingerprint");
    expect(firstTransferText).toContain(computeFingerprint("Fact A", "MEMORY.md"));
    expect(firstTransferText).toContain(computeFingerprint("Fact C", "memory/public/share.md"));

    setMemorySearchImpl(async () => [
      {
        path: firstTransferRel,
        startLine: 1,
        endLine: 1,
        score: 0.99,
        snippet: "Fact A",
        source: "memory" as const,
      },
    ]);
    const memoryTool = createMemorySearchTool({
      config: mockConfig as Parameters<typeof createMemorySearchTool>[0]["config"],
      agentSessionKey: "agent:requester:main",
    });
    if (!memoryTool) {
      throw new Error("missing memory_search tool");
    }
    const memoryResult = (
      await memoryTool.execute("memory-proof", {
        query: "Fact A",
      })
    ).details as {
      results?: Array<{ path?: string; snippet?: string }>;
    };
    expect(memoryResult.results?.[0]?.path?.startsWith("memory/transfers/")).toBe(true);
    expect(memoryResult.results?.[0]?.snippet).toContain("Fact A");

    const transferDir = path.join(requesterWorkspace, "memory", "transfers");
    const filesAfterFirst = (await fs.readdir(transferDir)).toSorted();

    const runDuplicate = tool.execute("transfer-duplicate", {
      sessionKey: "agent:source:main",
      timeoutSeconds: 10,
    });

    await vi.waitFor(() => {
      expect(pendingApprovals.size).toBe(1);
    });
    const exportApprovalId2 = Array.from(pendingApprovals.keys())[0];
    const exportPending2 = pendingApprovals.get(exportApprovalId2);
    if (!exportPending2) {
      throw new Error("missing export approval 2");
    }
    pendingApprovals.delete(exportApprovalId2);
    exportPending2.resolve("allow");

    await vi.waitFor(() => {
      expect(pendingApprovals.size).toBe(1);
    });
    const importApprovalId2 = Array.from(pendingApprovals.keys())[0];
    const importPending2 = pendingApprovals.get(importApprovalId2);
    if (!importPending2) {
      throw new Error("missing import approval 2");
    }
    pendingApprovals.delete(importApprovalId2);
    importPending2.resolve("allow");

    const duplicateResult = (await runDuplicate).details as {
      status: string;
      imported: number;
      skippedDuplicate: number;
      transferFile?: string;
    };
    expect(duplicateResult.status).toBe("ok");
    expect(duplicateResult.imported).toBe(0);
    expect(duplicateResult.skippedDuplicate).toBe(4);
    expect(duplicateResult.transferFile).toBeUndefined();

    const filesAfterDuplicate = (await fs.readdir(transferDir)).toSorted();
    expect(filesAfterDuplicate).toEqual(filesAfterFirst);

    await upsertKnowledgeTransferRule({
      requesterAgentId: "requester",
      targetAgentId: "source",
      side: "import",
      pathPattern: "memory/public/**",
      decision: "hide",
      baseDir: stateDir,
    });

    const runDeny = tool.execute("transfer-deny", {
      sessionKey: "agent:source:main",
      timeoutSeconds: 10,
    });

    await vi.waitFor(() => {
      expect(pendingApprovals.size).toBe(1);
    });
    const exportApprovalId3 = Array.from(pendingApprovals.keys())[0];
    const exportPending3 = pendingApprovals.get(exportApprovalId3);
    if (!exportPending3) {
      throw new Error("missing export approval 3");
    }
    pendingApprovals.delete(exportApprovalId3);
    exportPending3.resolve("allow");

    await vi.waitFor(() => {
      expect(pendingApprovals.size).toBe(1);
    });
    const importApprovalId3 = Array.from(pendingApprovals.keys())[0];
    const importPending3 = pendingApprovals.get(importApprovalId3);
    if (!importPending3) {
      throw new Error("missing import approval 3");
    }
    pendingApprovals.delete(importApprovalId3);
    importPending3.resolve("deny");

    const denyResult = (await runDeny).details as {
      status: string;
      imported: number;
      skippedDuplicate: number;
    };
    expect(denyResult.status).toBe("declined");
    expect(denyResult.imported).toBe(0);
    expect(denyResult.skippedDuplicate).toBe(0);

    const filesAfterDeny = (await fs.readdir(transferDir)).toSorted();
    expect(filesAfterDeny).toEqual(filesAfterFirst);

    await setKnowledgeTransferPairMode({
      requesterAgentId: "requester",
      targetAgentId: "source",
      mode: "auto",
      baseDir: stateDir,
    });

    const approvalsBeforeAuto = approvalRequests;
    const autoResult = (
      await tool.execute("transfer-auto", {
        sessionKey: "agent:source:main",
        timeoutSeconds: 10,
      })
    ).details as {
      status: string;
      imported: number;
      skippedDuplicate: number;
      transferFile?: string;
    };

    expect(autoResult.status).toBe("ok");
    expect(autoResult.imported).toBe(1);
    expect(autoResult.skippedDuplicate).toBe(4);
    expect(approvalRequests).toBe(approvalsBeforeAuto);

    const autoTransferRel = autoResult.transferFile ?? "";
    expect(autoTransferRel.startsWith("memory/transfers/")).toBe(true);
    const autoTransferText = await fs.readFile(
      path.join(requesterWorkspace, autoTransferRel),
      "utf-8",
    );
    expect(autoTransferText).toContain("Secret X");
  });
});

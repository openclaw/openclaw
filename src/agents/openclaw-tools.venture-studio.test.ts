import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("venture_studio tool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-venture-studio-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("records findings, dedupes duplicates, and generates plan/workflow/spec artifacts", async () => {
    const tool = createOpenClawTools({ workspaceDir }).find(
      (candidate) => candidate.name === "venture_studio",
    );
    if (!tool) {
      throw new Error("missing venture_studio tool");
    }

    await tool.execute("call-init", { action: "init" });
    await tool.execute("call-add-1", {
      action: "add_finding",
      sourceType: "forum",
      sourceUrl: "https://example.com/thread/123",
      title: "Missed patient follow-ups",
      painPoint: "Small dental clinics miss recall follow-ups and lose recurring revenue",
      targetCustomer: "dental clinics",
      urgency: "high",
      willingnessToPay: "$299/month",
    });

    const dedupeResult = await tool.execute("call-add-2", {
      action: "add_finding",
      sourceType: "forum",
      sourceUrl: "https://example.com/thread/123",
      title: "Missed patient follow-ups",
      painPoint: "Small dental clinics miss recall follow-ups and lose recurring revenue",
      targetCustomer: "dental clinics",
      urgency: "high",
      willingnessToPay: "$299/month",
    });
    expect(dedupeResult.details).toMatchObject({ deduped: true, totalFindings: 1 });

    const planResult = await tool.execute("call-plan", {
      action: "plan_apps",
      appCount: 1,
      stack: "nextjs-node-postgres",
    });
    expect(planResult.details).toMatchObject({
      action: "plan_apps",
      totalPlans: 1,
    });

    const details = planResult.details as {
      discussionPath?: string;
      generatedPlans?: Array<{
        docPath: string;
        workflowPath: string;
        specPath: string;
        id: string;
      }>;
    };
    if (!details.discussionPath || !details.generatedPlans?.[0]) {
      throw new Error("missing generated artifacts");
    }

    await expect(fs.readFile(details.discussionPath, "utf-8")).resolves.toContain(
      "Agent roundtable",
    );
    await expect(fs.readFile(details.generatedPlans[0].docPath, "utf-8")).resolves.toContain(
      "Recommended stack",
    );
    await expect(fs.readFile(details.generatedPlans[0].workflowPath, "utf-8")).resolves.toContain(
      "go_to_market",
    );
    await expect(fs.readFile(details.generatedPlans[0].specPath, "utf-8")).resolves.toContain(
      "coreFeatures",
    );
  });

  it("builds a scaffold for a generated plan", async () => {
    const tool = createOpenClawTools({ workspaceDir }).find(
      (candidate) => candidate.name === "venture_studio",
    );
    if (!tool) {
      throw new Error("missing venture_studio tool");
    }

    await tool.execute("call-init", { action: "init" });
    await tool.execute("call-add", {
      action: "add_finding",
      sourceType: "web",
      sourceUrl: "https://example.com/blog",
      title: "Manual invoice reconciliation",
      painPoint: "Accounting teams lose time reconciling invoices with bank feeds",
      targetCustomer: "mid-market finance teams",
      urgency: "critical",
    });

    const planResult = (await tool.execute("call-plan", {
      action: "plan_apps",
      appCount: 1,
      stack: "react-fastapi-postgres",
    })) as { details?: { generatedPlans?: Array<{ id: string }> } };
    const planId = planResult.details?.generatedPlans?.[0]?.id;
    if (!planId) {
      throw new Error("missing plan id");
    }

    const scaffoldResult = await tool.execute("call-scaffold", {
      action: "build_scaffold",
      planId,
    });
    expect(scaffoldResult.details).toMatchObject({ action: "build_scaffold", planId });

    const details = scaffoldResult.details as { scaffoldRoot?: string };
    if (!details.scaffoldRoot) {
      throw new Error("missing scaffold root");
    }

    await expect(
      fs.readFile(path.join(details.scaffoldRoot, "docker-compose.yml"), "utf-8"),
    ).resolves.toContain("services:");
    await expect(
      fs.readFile(path.join(details.scaffoldRoot, "backend", "requirements.txt"), "utf-8"),
    ).resolves.toContain("fastapi==");
    await expect(
      fs.readFile(path.join(details.scaffoldRoot, "frontend", "package.json"), "utf-8"),
    ).resolves.toContain("vite");
    await expect(
      fs.readFile(path.join(details.scaffoldRoot, "DEPENDENCIES.md"), "utf-8"),
    ).resolves.toContain("docker compose up --build");
    await expect(
      fs.readFile(path.join(details.scaffoldRoot, "scripts", "dev.ps1"), "utf-8"),
    ).resolves.toContain("docker compose up --build");
    await expect(
      fs.readFile(path.join(details.scaffoldRoot, "scripts", "dev.cmd"), "utf-8"),
    ).resolves.toContain("docker compose up --build");
  });

  it("rejects operations before init", async () => {
    const tool = createOpenClawTools({ workspaceDir }).find(
      (candidate) => candidate.name === "venture_studio",
    );
    if (!tool) {
      throw new Error("missing venture_studio tool");
    }

    await expect(tool.execute("call-list", { action: "list_findings" })).rejects.toThrow(
      "Run action=init first",
    );
  });
});

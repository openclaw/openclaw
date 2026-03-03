import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("architect_pipeline tool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-architect-pipeline-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("initializes and reads default state", async () => {
    const tool = createOpenClawTools({ workspaceDir }).find(
      (candidate) => candidate.name === "architect_pipeline",
    );
    if (!tool) {
      throw new Error("missing architect_pipeline tool");
    }

    const initResult = await tool.execute("call-1", {
      action: "init",
      project: "dentist-crm",
    });
    expect(initResult.details).toMatchObject({
      action: "init",
      state: {
        project: "dentist-crm",
        currentPhase: "planning",
        currentStep: 1,
        retryCount: 0,
        status: "running",
      },
    });

    const getResult = await tool.execute("call-2", { action: "get" });
    expect(getResult.details).toMatchObject({
      action: "get",
      state: {
        project: "dentist-crm",
      },
    });
  });

  it("applies decision gate retries and escalates at retry limit", async () => {
    const tool = createOpenClawTools({ workspaceDir }).find(
      (candidate) => candidate.name === "architect_pipeline",
    );
    if (!tool) {
      throw new Error("missing architect_pipeline tool");
    }

    await tool.execute("call-init", { action: "init", project: "crm" });

    const failResult = await tool.execute("call-fail", {
      action: "decision_gate",
      report: "FAIL",
      findings: "xss in comment renderer",
      maxRetries: 2,
    });
    expect(failResult.details).toMatchObject({
      status: "running",
      retryCount: 1,
      nextAction: "send_findings_to_builder_then_reaudit",
    });

    const escalateResult = await tool.execute("call-escalate", {
      action: "decision_gate",
      report: "ERROR",
      findings: "build not reproducible",
      maxRetries: 2,
    });
    expect(escalateResult.details).toMatchObject({
      status: "escalated",
      retryCount: 2,
      nextAction: "escalate_to_human",
    });
  });

  it("rejects state paths outside workspace", async () => {
    const tool = createOpenClawTools({ workspaceDir }).find(
      (candidate) => candidate.name === "architect_pipeline",
    );
    if (!tool) {
      throw new Error("missing architect_pipeline tool");
    }

    await expect(
      tool.execute("call-bad-path", {
        action: "init",
        path: path.join("..", "..", "tmp", "state.json"),
      }),
    ).rejects.toThrow("path must stay within the workspace directory");
  });
});

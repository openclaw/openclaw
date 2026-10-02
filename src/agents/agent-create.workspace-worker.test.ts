import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as snapshots from "../infra/sqlite-readonly-worker.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { readAgentProvenance } from "../state/agent-provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgent } from "./agent-create.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
} from "./workspace.js";

it("records operator and agent creation provenance after roster commits", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "agent-creation-provenance",
  });
  const admission = workerAdmission.createSqliteWorkerOperationAdmission;
  let grants = 0;
  const spy = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      admission((request, grant) => {
        const sql = observeMainThreadSql();
        const snapshot = vi.spyOn(snapshots, "runSqliteReadOnlyWorkerSync");
        try {
          admit(request, grant);
          sql.expectIdle();
          expect(snapshot).not.toHaveBeenCalled();
          grants++;
        } finally {
          sql.restore();
          snapshot.mockRestore();
        }
      }, attachment),
    );
  try {
    await createAgent({ name: "Operator Child", workspace: state.path("operator-child") });
    await createAgent({
      name: "Agent Child",
      workspace: state.path("agent-child"),
      provenance: { createdVia: "agent", creatorAgentId: "main" },
    });

    expect(grants).toBeGreaterThan(0);
    expect(readAgentProvenance("operator-child", { env: state.env })).toMatchObject({
      agentId: "operator-child",
      createdVia: "operator",
      creatorAgentId: null,
      createdAtMs: expect.any(Number),
    });
    expect(readAgentProvenance("agent-child", { env: state.env })).toMatchObject({
      agentId: "agent-child",
      createdVia: "agent",
      creatorAgentId: "main",
      createdAtMs: expect.any(Number),
    });
  } finally {
    spy.mockRestore();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("preserves env references from guided staging when preparation changes the environment", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "guided-stage-env",
  });
  const oldToken = process.env.GUIDED_STAGE_TOKEN;
  try {
    process.env.GUIDED_STAGE_TOKEN = "synthetic-read-value";
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    await state.writeConfig({
      ...config,
      gateway: { ...config.gateway, auth: { mode: "token", token: "${GUIDED_STAGE_TOKEN}" } },
    });
    const writeSnapshot = await readConfigFileSnapshotForWrite();
    const staged = writeSnapshot.snapshot.sourceConfig;
    expect(staged.gateway?.auth?.token).toBe("synthetic-read-value");
    await Promise.resolve();
    process.env.GUIDED_STAGE_TOKEN = "synthetic-after-guided-await";
    const created = await createAgent({
      name: "guided",
      workspace: state.path("guided-workspace"),
      stagedConfig: { config: staged, writeSnapshot },
      prepareConfigCommit: async () => {
        await Promise.resolve();
        process.env.GUIDED_STAGE_TOKEN = "synthetic-after-preparation";
      },
    });
    expect(created).toMatchObject({ status: "created", agentId: "guided" });
    const saved = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    expect(saved.gateway?.auth?.token).toBe("${GUIDED_STAGE_TOKEN}");
    expect(saved.agents?.entries?.guided).toBeDefined();
  } finally {
    if (oldToken === undefined) {
      delete process.env.GUIDED_STAGE_TOKEN;
    } else {
      process.env.GUIDED_STAGE_TOKEN = oldToken;
    }
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("keeps a fresh named workspace pending through the first run setup", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "named-agent-hatch",
  });
  const workspace = state.path("named-workspace");

  try {
    const created = await createAgent({ name: "Researcher", workspace });

    expect(created).toMatchObject({ status: "created", bootstrapPending: true });
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);

    const firstRunWorkspace = await ensureAgentWorkspace({
      dir: workspace,
      ensureBootstrapFiles: true,
    });
    expect(firstRunWorkspace.bootstrapPending).toBe(true);
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME), "utf8"),
    ).not.toContain("Researcher");
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { QaBusState } from "./bus-state.js";
import { startQaLabServer } from "./lab-server.js";
import { renderQaMarkdownReport } from "./report.js";
import { runQaScenario, type QaScenarioResult } from "./scenario.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";

export type QaSelfCheckResult = {
  outputPath: string;
  report: string;
  checks: Array<{ name: string; status: "pass" | "fail"; details?: string }>;
  scenarioResult: QaScenarioResult;
};

export async function runQaSelfCheckAgainstState(params: {
  state: QaBusState;
  cfg: OpenClawConfig;
  outputPath?: string;
  notes?: string[];
}): Promise<QaSelfCheckResult> {
  const startedAt = new Date();
  params.state.reset();
  const scenarioResult = await runQaScenario(createQaSelfCheckScenario(params.cfg), {
    state: params.state,
  });
  const checks = [
    {
      name: "QA self-check scenario",
      status: scenarioResult.status,
      details: `${scenarioResult.steps.filter((step) => step.status === "pass").length}/${scenarioResult.steps.length} steps passed`,
    },
  ] satisfies Array<{ name: string; status: "pass" | "fail"; details?: string }>;
  const finishedAt = new Date();
  const snapshot = params.state.getSnapshot();
  const timeline = snapshot.events.map((event) => {
    switch (event.kind) {
      case "thread-created":
        return `${event.cursor}. ${event.kind} ${event.thread.conversationId}/${event.thread.id}`;
      case "reaction-added":
        return `${event.cursor}. ${event.kind} ${event.message.id} ${event.emoji}`;
      default:
        return `${event.cursor}. ${event.kind} ${"message" in event ? event.message.id : ""}`.trim();
    }
  });
  const report = renderQaMarkdownReport({
    title: "OpenClaw QA E2E Self-Check",
    startedAt,
    finishedAt,
    checks,
    scenarios: [
      {
        name: scenarioResult.name,
        status: scenarioResult.status,
        details: scenarioResult.details,
        steps: scenarioResult.steps,
      },
    ],
    timeline,
    notes: params.notes ?? [
      "Vertical slice: qa-channel + qa-lab bus + private debugger surface.",
      "Docker orchestration, matrix runs, and auto-fix loops remain follow-up work.",
    ],
  });

  const outputPath =
    params.outputPath ?? path.join(process.cwd(), ".artifacts", "qa-e2e", "self-check.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, report, "utf8");

  return {
    outputPath,
    report,
    checks,
    scenarioResult,
  };
}

export async function runQaLabSelfCheck(params?: { outputPath?: string }) {
  const server = await startQaLabServer({
    outputPath: params?.outputPath,
  });
  try {
    return await server.runSelfCheck();
  } finally {
    await server.stop();
  }
}

export const runQaE2eSelfCheck = runQaLabSelfCheck;

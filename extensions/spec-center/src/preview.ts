import type {
  SpecCheckIssue,
  SpecCheckResult,
  SpecRecord,
  SpecRunPreview,
  SpecStep,
} from "./types.js";

export function checkSpec(spec: SpecRecord): SpecCheckResult {
  const issues: SpecCheckIssue[] = [];
  const artifactNames = new Set(spec.artifacts.map((artifact) => artifact.name));

  for (const required of ["overview.md", "requirements.md", "tasks.md", "runbook.md"] as const) {
    if (!artifactNames.has(required)) {
      issues.push({
        severity: "error",
        code: "missing_artifact",
        message: `Missing required spec artifact: ${required}`,
      });
    }
  }

  if (spec.steps.length === 0) {
    issues.push({
      severity: "error",
      code: "missing_steps",
      message: "Spec must define at least one executable step in tasks.md or legacy YAML.",
    });
  }

  const ids = new Set(spec.steps.map((step) => step.id));
  for (const step of spec.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push({
          severity: "error",
          code: "unknown_dependency",
          message: `Step ${step.id} depends on unknown step ${dependency}.`,
        });
      }
    }
  }

  if (spec.steps.some(isHighRiskStep) && !spec.steps.some((step) => step.type === "approval")) {
    issues.push({
      severity: "warning",
      code: "approval_recommended",
      message: "Spec includes high-risk submission or fix steps but has no approval step.",
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

export function buildRunPreview(spec: SpecRecord): SpecRunPreview {
  const check = checkSpec(spec);
  return {
    specId: spec.id,
    title: spec.title,
    stepCount: spec.steps.length,
    waves: buildWaves(spec.steps),
    approvalSteps: spec.steps.filter((step) => step.type === "approval").map((step) => step.id),
    validationSteps: spec.steps
      .filter((step) => step.type === "validation" || step.id.startsWith("validate_"))
      .map((step) => step.id),
    issues: check.issues,
  };
}

export function formatSpecCheck(result: SpecCheckResult): string {
  if (result.issues.length === 0) {
    return "Spec check passed.";
  }
  return [
    result.ok ? "Spec check passed with warnings:" : "Spec check failed:",
    ...result.issues.map((issue) => `- ${issue.severity}: ${issue.code} - ${issue.message}`),
  ].join("\n");
}

export function formatRunPreview(preview: SpecRunPreview): string {
  const waves =
    preview.waves.length > 0
      ? preview.waves.map((wave) => `- Wave ${wave.wave}: ${wave.steps.join(", ")}`).join("\n")
      : "- No executable waves.";
  const approvals = preview.approvalSteps.length > 0 ? preview.approvalSteps.join(", ") : "none";
  const validations =
    preview.validationSteps.length > 0 ? preview.validationSteps.join(", ") : "none";
  return [
    `Spec Run Preview: ${preview.title}`,
    `- specId: ${preview.specId}`,
    `- steps: ${preview.stepCount}`,
    `- validation steps: ${validations}`,
    `- approval steps: ${approvals}`,
    "",
    waves,
    "",
    formatSpecCheck({
      ok: preview.issues.every((issue) => issue.severity !== "error"),
      issues: preview.issues,
    }),
  ].join("\n");
}

function buildWaves(steps: SpecStep[]): Array<{ wave: number; steps: string[] }> {
  const remaining = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const waves: Array<{ wave: number; steps: string[] }> = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((step) =>
      step.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      waves.push({ wave: waves.length + 1, steps: [...remaining.keys()] });
      break;
    }
    for (const step of ready) {
      remaining.delete(step.id);
      completed.add(step.id);
    }
    waves.push({ wave: waves.length + 1, steps: ready.map((step) => step.id) });
  }

  return waves;
}

function isHighRiskStep(step: SpecStep): boolean {
  const text = `${step.id} ${step.title} ${step.task ?? ""} ${step.tool ?? ""}`.toLowerCase();
  return (
    text.includes("fix") ||
    text.includes("submit") ||
    text.includes("push") ||
    text.includes("merge") ||
    text.includes("publish") ||
    text.includes("mr") ||
    text.includes("pr")
  );
}

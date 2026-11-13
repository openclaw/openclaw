import type { BootstrapMode } from "./bootstrap-mode.js";

/** Builds prompt lines for a full BOOTSTRAP.md workflow handoff. */
export function buildFullBootstrapPromptLines(params: {
  readLine: string;
  firstReplyLine: string;
}): string[] {
  return [
    params.readLine,
    "Can finish BOOTSTRAP.md here: do it.",
    "Cannot: brief blocker, possible steps, simplest next step.",
    "Never claim completion early. No generic greeting/normal reply before BOOTSTRAP.md handling.",
    params.firstReplyLine,
  ];
}

/** Builds prompt lines for a constrained BOOTSTRAP.md workflow handoff. */
export function buildLimitedBootstrapPromptLines(params: {
  introLine: string;
  nextStepLine: string;
}): string[] {
  return [
    params.introLine,
    "Never claim complete; no generic first greeting.",
    "Brief limitation; possible steps; simplest next step.",
    params.nextStepLine,
  ];
}

/** Builds the system-prompt section for pending or recorded-complete workspace bootstrap. */
export function buildBootstrapSystemPromptSection(params: {
  bootstrapMode?: BootstrapMode;
  bootstrapCompleted?: boolean;
  bootstrapContextInjected: boolean;
}): string[] {
  if (params.bootstrapMode === "limited") {
    return [
      "## Bootstrap Pending",
      ...buildLimitedBootstrapPromptLines({
        introLine: "Bootstrap pending; this run cannot safely finish full BOOTSTRAP.md.",
        nextStepLine:
          "Next: primary interactive run with normal workspace access, or user deletes workspace BOOTSTRAP.md after completion.",
      }),
      "",
    ];
  }
  if (params.bootstrapMode === "full") {
    return [
      "## Bootstrap Pending",
      ...buildFullBootstrapPromptLines({
        readLine: params.bootstrapContextInjected
          ? "BOOTSTRAP.md below; follow before normal reply."
          : "Read workspace BOOTSTRAP.md; follow before normal reply.",
        firstReplyLine: "First visible reply must follow BOOTSTRAP.md; no generic greeting.",
      }),
      "",
    ];
  }
  if (params.bootstrapCompleted) {
    // Completion drops BOOTSTRAP.md from the prompt while earlier turns that followed it remain.
    return [
      "## Bootstrap Complete",
      "OpenClaw recorded workspace setup as complete; earlier BOOTSTRAP.md instructions are no longer shown.",
      "Missing BOOTSTRAP.md is expected. It and blank optional profile files do not mean setup was skipped.",
      "",
    ];
  }
  return [];
}

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PCC_FORMAT = "openclaw-snes-team-pcc-v1";
export const PCC_STATE_FILES = [
  "project.intent.json",
  "milestone-ledger.json",
  "dependency-dag.json",
  "active-worker-locks.json",
  "decision-log.json",
  "memory-cards.json",
  "repair-queue.json",
  "approval-queue.json",
  "run-control.json",
  "run-history.json",
  "model-usage.json",
  "build-history.json",
  "latest-run-summary.md",
  "latest-summary.md",
  "worker-dispatch-log.json",
  "worker-sandboxes.json",
  "patch-ledger.json",
  "artifact-cache.json",
  "reviewer-receipts.json",
  "conflict-receipts.json",
  "telemetry.json",
  "dashboard-snapshot.json",
  "regression-benchmarks.json",
];

export const PCC_STATUSES = new Set([
  "pending",
  "ready",
  "in_progress",
  "pass",
  "fail",
  "blocked",
  "rejected",
  "superseded",
]);

export const PCC_FAILURE_CLASSES = new Set([
  "invalid-patch",
  "build-failure",
  "runtime-failure",
  "visual-failure",
  "budget-failure",
  "external-blocker",
]);

export const PCC_APPROVAL_TYPES = new Set([
  "hosted-glm",
  "paid-tool-or-asset",
  "fxpak-removable-write",
  "push-or-pr",
  "original-hardware-proof",
  "human-production-visual-approval",
  "live-model-spending-automation",
]);

export const DEFAULT_ROUTING_POLICY = Object.freeze({
  format: "openclaw-snes-team-routing-policy-v1",
  producerOrchestrator: {
    role: "deterministic-script",
    model: "none",
  },
  initialBlueprint: {
    role: "gpt-game-director",
    model: "openai/gpt-5.5",
    reasoning: "high",
    approvalGated: true,
  },
  routineWorkers: {
    model: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    fallbacks: [
      "ollama/openclaw-control-qwen36-27b:latest",
      "ollama/openclaw-control-qwen25-32b:latest",
    ],
  },
  finalApproval: {
    role: "deterministic-receipts-gpt55-human-when-required",
    model: "openai/gpt-5.5",
    reasoning: "high",
    approvalGated: true,
  },
  hostedGlmUsed: false,
  gpt55UsedByDeterministicCommands: false,
});

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 4,
  attempts: [
    { attempt: 1, action: "same-role-repair" },
    { attempt: 2, action: "fallback-local-model-repair" },
    { attempt: 3, action: "gpt55-high-diagnosis-required" },
    { attempt: 4, action: "block-unless-user-approves-deeper-work" },
  ],
});

const nowIso = () => new Date().toISOString();

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function jsonStable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, jsonStable(value));
}

function spawnText(result, stream) {
  return typeof result?.[stream] === "string" ? result[stream] : "";
}

function extractJsonObject(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function ollamaModelId(modelRef) {
  return String(modelRef ?? "").startsWith("ollama/")
    ? String(modelRef).slice("ollama/".length)
    : String(modelRef ?? "");
}

function parseOllamaList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^name\s+/iu.test(line))
    .map((line) => line.split(/\s+/u)[0])
    .filter(Boolean)
    .map((name) => (name.startsWith("ollama/") ? name : `ollama/${name}`));
}

function configuredLocalWorkerModels() {
  return [
    DEFAULT_ROUTING_POLICY.routineWorkers.model,
    ...DEFAULT_ROUTING_POLICY.routineWorkers.fallbacks,
  ];
}

function safeProjectId(projectId) {
  if (!projectId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(projectId)) {
    throw new Error("project id must use letters, numbers, dot, underscore, or dash");
  }
  if (projectId.includes("..")) {
    throw new Error("project id must not contain '..'");
  }
  return projectId;
}

export function pccProjectDir({ project, root = ".artifacts/snes-projects" }) {
  return path.join(root, safeProjectId(project), "pcc");
}

function pccFile(projectDir, name) {
  return path.join(projectDir, name);
}

function defaultRequiredProof(names) {
  return names.map((name) => ({ name, required: true }));
}

export function createDefaultMilestones() {
  const common = {
    retryPolicy: DEFAULT_RETRY_POLICY,
    modelPolicy: DEFAULT_ROUTING_POLICY.routineWorkers,
    completionPercent: 0,
    proof: {},
    failCriteria: ["missing-required-proof", "unsafe-patch", "commercial-material", "hosted-glm"],
  };
  return [
    {
      ...common,
      milestoneId: "PCC-001-blueprint",
      title: "Initial game blueprint and rubric",
      ownerRole: "gpt-game-director",
      workerRole: "gpt-game-director",
      judgeRole: "deterministic-validator",
      dependsOn: [],
      parallelGroup: "sequential-blueprint",
      sequentialOnly: true,
      allowedWriteSurfaces: ["blueprint"],
      requiredProof: defaultRequiredProof(["blueprintReceipt", "legalBoundaryReceipt"]),
      passCriteria: ["blueprint-complete", "legal-clean-room", "quality-rubric-present"],
      status: "ready",
      humanApprovalRequired: false,
      modelPolicy: DEFAULT_ROUTING_POLICY.initialBlueprint,
    },
    {
      ...common,
      milestoneId: "PCC-010-level-plan",
      title: "Finishable level route plan",
      ownerRole: "snes-level-designer",
      workerRole: "snes-level-designer",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-001-blueprint"],
      parallelGroup: "parallel-design",
      allowedWriteSurfaces: ["level-plan"],
      requiredProof: defaultRequiredProof(["levelRouteReceipt", "reachabilityReceipt"]),
      passCriteria: [
        "spawn-to-goal-route",
        "first-screen-teaches",
        "checkpoint-and-reward-specified",
      ],
      status: "pending",
      humanApprovalRequired: false,
    },
    {
      ...common,
      milestoneId: "PCC-011-gameplay-plan",
      title: "Gameplay feel and mechanics plan",
      ownerRole: "snes-game-feel-tuner",
      workerRole: "snes-game-feel-tuner",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-001-blueprint"],
      parallelGroup: "parallel-design",
      allowedWriteSurfaces: ["gameplay-constants"],
      requiredProof: defaultRequiredProof(["gameplayReceipt", "replayHypothesisReceipt"]),
      passCriteria: ["movement-constants", "enemy-rules", "playtest-hypothesis"],
      status: "pending",
      humanApprovalRequired: false,
    },
    {
      ...common,
      milestoneId: "PCC-012-asset-intents",
      title: "Production asset intent contracts",
      ownerRole: "snes-pixel-art-director",
      workerRole: "snes-pixel-art-director",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-001-blueprint"],
      parallelGroup: "parallel-design",
      allowedWriteSurfaces: ["asset-intents"],
      requiredProof: defaultRequiredProof(["assetIntentReceipt", "promptMatchReceipt"]),
      passCriteria: [
        "must-show-and-must-not-show",
        "palette-and-frame-bounds",
        "runtime-proof-required",
      ],
      status: "pending",
      humanApprovalRequired: true,
    },
    {
      ...common,
      milestoneId: "PCC-013-audio-plan",
      title: "Audio and SPC700 event plan",
      ownerRole: "snes-audio-spc700",
      workerRole: "snes-audio-spc700",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-001-blueprint"],
      parallelGroup: "parallel-design",
      allowedWriteSurfaces: ["audio-plan"],
      requiredProof: defaultRequiredProof(["audioEventReceipt", "aramBudgetReceipt"]),
      passCriteria: ["music-loop-intent", "sfx-event-map", "aram-budget"],
      status: "pending",
      humanApprovalRequired: false,
    },
    {
      ...common,
      milestoneId: "PCC-014-hardware-plan",
      title: "SNES hardware and FXPAK constraint plan",
      ownerRole: "snes-engine-architect",
      workerRole: "snes-engine-architect",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-001-blueprint"],
      parallelGroup: "parallel-design",
      allowedWriteSurfaces: ["hardware-budget"],
      requiredProof: defaultRequiredProof(["budgetReceipt", "fxpakConstraintReceipt"]),
      passCriteria: ["vram-oam-cgram-aram-budget", "lorom-default", "no-removable-write"],
      status: "pending",
      humanApprovalRequired: false,
    },
    {
      ...common,
      milestoneId: "PCC-020-integration",
      title: "Deterministic integration plan",
      ownerRole: "producer-orchestrator",
      workerRole: "deterministic-script",
      judgeRole: "deterministic-validator",
      dependsOn: [
        "PCC-010-level-plan",
        "PCC-011-gameplay-plan",
        "PCC-012-asset-intents",
        "PCC-013-audio-plan",
        "PCC-014-hardware-plan",
      ],
      parallelGroup: "sequential-integration",
      sequentialOnly: true,
      allowedWriteSurfaces: ["integration"],
      requiredProof: defaultRequiredProof(["integrationReceipt", "conflictScanReceipt"]),
      passCriteria: ["no-write-conflicts", "accepted-patches-only"],
      status: "pending",
      humanApprovalRequired: false,
      modelPolicy: DEFAULT_ROUTING_POLICY.producerOrchestrator,
    },
    {
      ...common,
      milestoneId: "PCC-030-rom-build-proof",
      title: "ROM build and SNES budget proof",
      ownerRole: "snes-engine-architect",
      workerRole: "deterministic-script",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-020-integration"],
      parallelGroup: "sequential-build",
      sequentialOnly: true,
      allowedWriteSurfaces: ["rom-build"],
      requiredProof: defaultRequiredProof(["romReceipt", "superfamicheckReceipt", "budgetReceipt"]),
      passCriteria: ["sfc-builds", "superfamicheck-pass", "budgets-pass"],
      status: "pending",
      humanApprovalRequired: false,
      modelPolicy: DEFAULT_ROUTING_POLICY.producerOrchestrator,
    },
    {
      ...common,
      milestoneId: "PCC-040-runtime-proof",
      title: "Emulator and runtime asset proof",
      ownerRole: "snes-emulator-regression-qa",
      workerRole: "deterministic-script",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-030-rom-build-proof"],
      parallelGroup: "sequential-runtime-proof",
      sequentialOnly: true,
      allowedWriteSurfaces: ["runtime-proof"],
      requiredProof: defaultRequiredProof([
        "emulatorScreenshotReceipt",
        "runtimeAssetTruthReceipt",
      ]),
      passCriteria: ["fresh-nonblank-screenshot", "runtime-assets-visible"],
      status: "pending",
      humanApprovalRequired: false,
      modelPolicy: DEFAULT_ROUTING_POLICY.producerOrchestrator,
    },
    {
      ...common,
      milestoneId: "PCC-050-human-visual-approval",
      title: "Human production visual approval",
      ownerRole: "snes-pixel-art-director",
      workerRole: "human-review-required",
      judgeRole: "human-visual-judge",
      dependsOn: ["PCC-040-runtime-proof"],
      parallelGroup: "sequential-human-review",
      sequentialOnly: true,
      allowedWriteSurfaces: ["visual-approval"],
      requiredProof: defaultRequiredProof(["humanVisualApproval"]),
      passCriteria: ["human-score-meets-target", "runtime-screenshot-reviewed"],
      status: "pending",
      humanApprovalRequired: true,
      modelPolicy: { role: "human", model: "none" },
    },
    {
      ...common,
      milestoneId: "PCC-060-package-readiness",
      title: "Package and handoff readiness",
      ownerRole: "snes-rom-patch-handoff",
      workerRole: "deterministic-script",
      judgeRole: "deterministic-validator",
      dependsOn: ["PCC-050-human-visual-approval"],
      parallelGroup: "sequential-package",
      sequentialOnly: true,
      allowedWriteSurfaces: ["package"],
      requiredProof: defaultRequiredProof(["packageReceipt", "noRomLeakReceipt"]),
      passCriteria: ["package-hashes", "no-disallowed-rom-handoff", "fxpak-write-not-performed"],
      status: "pending",
      humanApprovalRequired: false,
      modelPolicy: DEFAULT_ROUTING_POLICY.producerOrchestrator,
    },
  ];
}

export function createDependencyDag(milestones) {
  return {
    format: "openclaw-snes-pcc-dependency-dag-v1",
    generatedAt: nowIso(),
    maxParallelWorkers: 4,
    nodes: milestones.map((milestone) => ({
      milestoneId: milestone.milestoneId,
      dependsOn: milestone.dependsOn,
      parallelGroup: milestone.parallelGroup,
      sequentialOnly: Boolean(milestone.sequentialOnly),
      allowedWriteSurfaces: milestone.allowedWriteSurfaces,
    })),
  };
}

export function createProjectIntent({ project, promptText }) {
  return {
    format: "openclaw-snes-pcc-project-intent-v1",
    generatedAt: nowIso(),
    projectId: project,
    prompt: promptText,
    promptSha256: sha256Text(promptText),
    target: "production-snes-platformer",
    constraints: {
      noCommercialSnesMaterial: true,
      hostedGlmUsed: false,
      fxpakWritePerformed: false,
      liveAgentExecution: false,
      localFirst: true,
    },
    qualityTarget: {
      draftMinimumVisualScore: 50,
      productionCandidateMinimumVisualScore: 80,
      finalHumanApprovalRequired: true,
      styleTarget: "legal-clean-room-classic-snes-platformer-polish",
    },
  };
}

function projectSummary({ project, promptText, milestones }) {
  const total = milestones.length;
  const passed = milestones.filter((m) => m.status === "pass").length;
  const blocked = milestones.filter((m) => m.status === "blocked").length;
  const failed = milestones.filter((m) => m.status === "fail").length;
  return [
    `# SNES PCC Project: ${project}`,
    "",
    `Prompt SHA-256: ${sha256Text(promptText)}`,
    `Milestones passed: ${passed}/${total}`,
    `Blocked: ${blocked}`,
    `Failed: ${failed}`,
    "",
    "This PCC state is deterministic scaffolding only. It does not prove a finished game until the milestone ledger and required receipts pass.",
    "",
  ].join("\n");
}

export function initPccProject({ project, promptPath, promptText, root }) {
  const projectDir = pccProjectDir({ project, root });
  if (fs.existsSync(projectDir)) {
    return pccStatus({ project, root, initialized: false, note: "existing-project-preserved" });
  }
  const actualPromptText = promptText ?? fs.readFileSync(promptPath, "utf8");
  const milestones = createDefaultMilestones();
  fs.mkdirSync(projectDir, { recursive: true });
  writeJson(
    pccFile(projectDir, "project.intent.json"),
    createProjectIntent({ project, promptText: actualPromptText }),
  );
  writeJson(pccFile(projectDir, "milestone-ledger.json"), {
    format: "openclaw-snes-pcc-milestone-ledger-v1",
    generatedAt: nowIso(),
    projectId: project,
    statuses: [...PCC_STATUSES],
    milestones,
    futureMilestonesPreserved: futureMilestonesPreserved(),
  });
  writeJson(pccFile(projectDir, "dependency-dag.json"), createDependencyDag(milestones));
  writeJson(pccFile(projectDir, "active-worker-locks.json"), {
    format: "openclaw-snes-pcc-worker-locks-v1",
    generatedAt: nowIso(),
    locks: [],
  });
  writeJson(pccFile(projectDir, "decision-log.json"), {
    format: "openclaw-snes-pcc-decision-log-v1",
    generatedAt: nowIso(),
    decisions: [
      {
        at: nowIso(),
        event: "init",
        status: "pass",
        hostedGlmUsed: false,
        gpt55Used: false,
      },
    ],
  });
  writeJson(pccFile(projectDir, "memory-cards.json"), {
    format: "openclaw-snes-pcc-memory-cards-v1",
    generatedAt: nowIso(),
    cards: [
      {
        id: "legal-clean-room-only",
        text: "Do not use commercial SNES ROMs, source leaks, disassemblies, copied art, maps, palettes, music, or SFX.",
      },
      {
        id: "proof-surfaces-separate",
        text: "Do not collapse source, conversion, runtime, ROM, emulator, FXPAK, hardware, or human approval proof.",
      },
    ],
  });
  writeJson(pccFile(projectDir, "repair-queue.json"), {
    format: "openclaw-snes-pcc-repair-queue-v1",
    generatedAt: nowIso(),
    repairs: [],
  });
  writeJson(pccFile(projectDir, "approval-queue.json"), {
    format: "openclaw-snes-pcc-approval-queue-v1",
    generatedAt: nowIso(),
    approvals: [],
  });
  writeJson(pccFile(projectDir, "run-control.json"), {
    format: "openclaw-snes-pcc-run-control-v1",
    generatedAt: nowIso(),
    state: "running",
    reason: null,
  });
  writeJson(pccFile(projectDir, "run-history.json"), {
    format: "openclaw-snes-pcc-run-history-v1",
    generatedAt: nowIso(),
    runs: [],
  });
  writeJson(pccFile(projectDir, "worker-dispatch-log.json"), {
    format: "openclaw-snes-pcc-worker-dispatch-log-v1",
    generatedAt: nowIso(),
    dispatches: [],
  });
  writeJson(pccFile(projectDir, "worker-sandboxes.json"), {
    format: "openclaw-snes-pcc-worker-sandboxes-v1",
    generatedAt: nowIso(),
    sandboxes: [],
  });
  writeJson(pccFile(projectDir, "patch-ledger.json"), {
    format: "openclaw-snes-pcc-patch-ledger-v1",
    generatedAt: nowIso(),
    patches: [],
  });
  writeJson(pccFile(projectDir, "artifact-cache.json"), {
    format: "openclaw-snes-pcc-artifact-cache-v1",
    generatedAt: nowIso(),
    entries: [],
  });
  writeJson(pccFile(projectDir, "reviewer-receipts.json"), {
    format: "openclaw-snes-pcc-reviewer-receipts-v1",
    generatedAt: nowIso(),
    receipts: [],
  });
  writeJson(pccFile(projectDir, "conflict-receipts.json"), {
    format: "openclaw-snes-pcc-conflict-receipts-v1",
    generatedAt: nowIso(),
    conflicts: [],
  });
  writeJson(pccFile(projectDir, "telemetry.json"), {
    format: "openclaw-snes-pcc-telemetry-v1",
    generatedAt: nowIso(),
    events: [],
  });
  writeJson(pccFile(projectDir, "dashboard-snapshot.json"), {
    format: "openclaw-snes-pcc-dashboard-snapshot-v1",
    generatedAt: nowIso(),
    projectId: project,
    activeRun: null,
    pendingApprovals: [],
    blockedMilestones: [],
    nextSafeAction: "inspect-status",
    completionPercent: 0,
  });
  writeJson(pccFile(projectDir, "regression-benchmarks.json"), {
    format: "openclaw-snes-pcc-regression-benchmarks-v1",
    generatedAt: nowIso(),
    prompts: [
      { id: "clean-room-runner", prompt: "Create a tiny legal clean-room SNES runner kata." },
      {
        id: "clean-room-collectathon",
        prompt: "Create a tiny legal clean-room SNES item collection kata.",
      },
      {
        id: "clean-room-checkpoint",
        prompt: "Create a tiny legal clean-room SNES checkpoint kata.",
      },
    ],
    runs: [],
  });
  writeJson(pccFile(projectDir, "model-usage.json"), {
    format: "openclaw-snes-pcc-model-usage-v1",
    generatedAt: nowIso(),
    routingPolicy: DEFAULT_ROUTING_POLICY,
    usage: [],
  });
  writeJson(pccFile(projectDir, "build-history.json"), {
    format: "openclaw-snes-pcc-build-history-v1",
    generatedAt: nowIso(),
    lastKnownGood: null,
    builds: [],
  });
  fs.writeFileSync(
    pccFile(projectDir, "latest-summary.md"),
    projectSummary({ project, promptText: actualPromptText, milestones }),
  );
  fs.writeFileSync(
    pccFile(projectDir, "latest-run-summary.md"),
    `# SNES PCC Run Summary: ${project}\n\nNo run has been executed yet.\n`,
  );
  return pccStatus({ project, root, initialized: true });
}

export function futureMilestonesPreserved() {
  return [
    "Live multi-agent execution that actually calls OpenClaw worker agents.",
    "Real prompt-to-ROM game generation through PCC.",
    "Level editor/compiler pipeline.",
    "Runtime asset integration compiler.",
    "Full production art generator.",
    "Human visual approval station in dashboard.",
    "PCC dashboard UI.",
    "Prompt-to-ROM regression benchmark.",
    "Original SNES hardware proof.",
    "FXPAK copy proof.",
    "Stanski-specific visual fixes, source photo preservation, Cleveland background, and full Stanski content.",
  ];
}

function ensurePccV3State(projectDir, project) {
  const defaults = {
    "worker-dispatch-log.json": {
      format: "openclaw-snes-pcc-worker-dispatch-log-v1",
      generatedAt: nowIso(),
      dispatches: [],
    },
    "worker-sandboxes.json": {
      format: "openclaw-snes-pcc-worker-sandboxes-v1",
      generatedAt: nowIso(),
      sandboxes: [],
    },
    "patch-ledger.json": {
      format: "openclaw-snes-pcc-patch-ledger-v1",
      generatedAt: nowIso(),
      patches: [],
    },
    "artifact-cache.json": {
      format: "openclaw-snes-pcc-artifact-cache-v1",
      generatedAt: nowIso(),
      entries: [],
    },
    "reviewer-receipts.json": {
      format: "openclaw-snes-pcc-reviewer-receipts-v1",
      generatedAt: nowIso(),
      receipts: [],
    },
    "conflict-receipts.json": {
      format: "openclaw-snes-pcc-conflict-receipts-v1",
      generatedAt: nowIso(),
      conflicts: [],
    },
    "telemetry.json": {
      format: "openclaw-snes-pcc-telemetry-v1",
      generatedAt: nowIso(),
      events: [],
    },
    "dashboard-snapshot.json": {
      format: "openclaw-snes-pcc-dashboard-snapshot-v1",
      generatedAt: nowIso(),
      projectId: project,
      activeRun: null,
      pendingApprovals: [],
      blockedMilestones: [],
      nextSafeAction: "inspect-status",
      completionPercent: 0,
    },
    "regression-benchmarks.json": {
      format: "openclaw-snes-pcc-regression-benchmarks-v1",
      generatedAt: nowIso(),
      prompts: [
        { id: "clean-room-runner", prompt: "Create a tiny legal clean-room SNES runner kata." },
        {
          id: "clean-room-collectathon",
          prompt: "Create a tiny legal clean-room SNES item collection kata.",
        },
        {
          id: "clean-room-checkpoint",
          prompt: "Create a tiny legal clean-room SNES checkpoint kata.",
        },
      ],
      runs: [],
    },
  };
  for (const [fileName, defaultValue] of Object.entries(defaults)) {
    const filePath = pccFile(projectDir, fileName);
    if (!fs.existsSync(filePath)) {
      writeJson(filePath, defaultValue);
    }
  }
}

export function loadPccProject({ project, root }) {
  const projectDir = pccProjectDir({ project, root });
  if (!fs.existsSync(projectDir)) {
    return { ok: false, projectDir, missingProject: true };
  }
  ensurePccV3State(projectDir, project);
  const files = Object.fromEntries(
    PCC_STATE_FILES.map((name) => [name, pccFile(projectDir, name)]),
  );
  const missingFiles = PCC_STATE_FILES.filter((name) => !fs.existsSync(files[name]));
  const loaded = { ok: missingFiles.length === 0, projectDir, files, missingFiles };
  if (fs.existsSync(files["project.intent.json"])) {
    loaded.intent = readJson(files["project.intent.json"]);
  }
  if (fs.existsSync(files["milestone-ledger.json"])) {
    loaded.ledger = readJson(files["milestone-ledger.json"]);
  }
  if (fs.existsSync(files["dependency-dag.json"])) {
    loaded.dag = readJson(files["dependency-dag.json"]);
  }
  if (fs.existsSync(files["repair-queue.json"])) {
    loaded.repairQueue = readJson(files["repair-queue.json"]);
  }
  if (fs.existsSync(files["approval-queue.json"])) {
    loaded.approvalQueue = readJson(files["approval-queue.json"]);
  }
  if (fs.existsSync(files["run-control.json"])) {
    loaded.runControl = readJson(files["run-control.json"]);
  }
  if (fs.existsSync(files["run-history.json"])) {
    loaded.runHistory = readJson(files["run-history.json"]);
  }
  if (fs.existsSync(files["build-history.json"])) {
    loaded.buildHistory = readJson(files["build-history.json"]);
  }
  if (fs.existsSync(files["worker-dispatch-log.json"])) {
    loaded.workerDispatchLog = readJson(files["worker-dispatch-log.json"]);
  }
  if (fs.existsSync(files["worker-sandboxes.json"])) {
    loaded.workerSandboxes = readJson(files["worker-sandboxes.json"]);
  }
  if (fs.existsSync(files["patch-ledger.json"])) {
    loaded.patchLedger = readJson(files["patch-ledger.json"]);
  }
  if (fs.existsSync(files["artifact-cache.json"])) {
    loaded.artifactCache = readJson(files["artifact-cache.json"]);
  }
  if (fs.existsSync(files["reviewer-receipts.json"])) {
    loaded.reviewerReceipts = readJson(files["reviewer-receipts.json"]);
  }
  if (fs.existsSync(files["conflict-receipts.json"])) {
    loaded.conflictReceipts = readJson(files["conflict-receipts.json"]);
  }
  if (fs.existsSync(files["telemetry.json"])) {
    loaded.telemetry = readJson(files["telemetry.json"]);
  }
  if (fs.existsSync(files["dashboard-snapshot.json"])) {
    loaded.dashboardSnapshot = readJson(files["dashboard-snapshot.json"]);
  }
  if (fs.existsSync(files["regression-benchmarks.json"])) {
    loaded.regressionBenchmarks = readJson(files["regression-benchmarks.json"]);
  }
  return loaded;
}

export function validateAssetIntentContract(intent) {
  const errors = [];
  const requiredStrings = ["assetId", "kind", "dimensions"];
  for (const field of requiredStrings) {
    if (typeof intent?.[field] !== "string" || intent[field].trim() === "") {
      errors.push(`missing-${field}`);
    }
  }
  if (!Number.isInteger(intent?.frames) || intent.frames < 1) {
    errors.push("invalid-frames");
  }
  if (
    !Number.isInteger(intent?.paletteLimit) ||
    intent.paletteLimit < 1 ||
    intent.paletteLimit > 16
  ) {
    errors.push("invalid-paletteLimit");
  }
  if (!Array.isArray(intent?.mustShow) || intent.mustShow.length === 0) {
    errors.push("missing-mustShow");
  }
  if (!Array.isArray(intent?.mustNotShow)) {
    errors.push("missing-mustNotShow");
  }
  if (!Array.isArray(intent?.animationBeats)) {
    errors.push("missing-animationBeats");
  }
  if (intent?.production === true && intent.runtimeProofRequired !== true) {
    errors.push("production-runtimeProofRequired-missing");
  }
  if (
    intent?.production === true &&
    (!Number.isInteger(intent.humanVisualTarget) || intent.humanVisualTarget < 1)
  ) {
    errors.push("production-humanVisualTarget-missing");
  }
  return {
    format: "openclaw-snes-pcc-asset-intent-validation-v1",
    status: errors.length ? "fail" : "pass",
    ok: errors.length === 0,
    errors,
  };
}

export function validateMilestoneShape(milestone) {
  const errors = [];
  const required = [
    "milestoneId",
    "title",
    "ownerRole",
    "dependsOn",
    "parallelGroup",
    "allowedWriteSurfaces",
    "requiredProof",
    "passCriteria",
    "failCriteria",
    "retryPolicy",
    "humanApprovalRequired",
    "modelPolicy",
    "completionPercent",
  ];
  for (const field of required) {
    if (!(field in milestone)) {
      errors.push(`missing-${field}`);
    }
  }
  if (!PCC_STATUSES.has(milestone.status)) {
    errors.push("invalid-status");
  }
  if (!Array.isArray(milestone.dependsOn)) {
    errors.push("dependsOn-not-array");
  }
  if (
    !Array.isArray(milestone.allowedWriteSurfaces) ||
    milestone.allowedWriteSurfaces.length === 0
  ) {
    errors.push("allowedWriteSurfaces-empty");
  }
  if (!Array.isArray(milestone.requiredProof)) {
    errors.push("requiredProof-not-array");
  }
  if (typeof milestone.completionPercent !== "number") {
    errors.push("completionPercent-not-number");
  }
  if (
    milestone.status === "pass" &&
    milestone.workerRole &&
    milestone.judgeRole &&
    milestone.workerRole === milestone.judgeRole
  ) {
    errors.push("worker-self-approval-rejected");
  }
  return errors;
}

export function missingProofForMilestone(milestone, projectDir) {
  if (milestone.status !== "pass") {
    return [];
  }
  const proof = milestone.proof ?? {};
  const missing = [];
  for (const entry of milestone.requiredProof ?? []) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (!name) {
      continue;
    }
    const proofPath = proof[name];
    if (!proofPath) {
      missing.push(name);
      continue;
    }
    const resolved = path.isAbsolute(proofPath) ? proofPath : path.join(projectDir, proofPath);
    if (!fs.existsSync(resolved)) {
      missing.push(name);
    }
  }
  if (
    milestone.humanApprovalRequired &&
    !proof.humanVisualApproval &&
    milestone.status === "pass"
  ) {
    missing.push("humanVisualApproval");
  }
  return [...new Set(missing)];
}

export function validatePccProject({ project, root }) {
  const loaded = loadPccProject({ project, root });
  const errors = [];
  if (loaded.missingProject) {
    return {
      format: "openclaw-snes-pcc-validation-v1",
      status: "blocked",
      ok: false,
      project,
      errors: ["project-not-found"],
      missingFiles: PCC_STATE_FILES,
      gpt55Used: false,
      hostedGlmUsed: false,
      commercialMaterialUsed: false,
      fxpakWritePerformed: false,
    };
  }
  for (const missing of loaded.missingFiles ?? []) {
    errors.push(`missing-state-file:${missing}`);
  }
  const ledger = loaded.ledger;
  if (!ledger || !Array.isArray(ledger.milestones)) {
    errors.push("missing-or-invalid-ledger");
  } else {
    const ids = new Set();
    for (const milestone of ledger.milestones) {
      for (const error of validateMilestoneShape(milestone)) {
        errors.push(`${milestone.milestoneId ?? "unknown"}:${error}`);
      }
      if (ids.has(milestone.milestoneId)) {
        errors.push(`${milestone.milestoneId}:duplicate-id`);
      }
      ids.add(milestone.milestoneId);
      for (const dep of milestone.dependsOn ?? []) {
        if (!ledger.milestones.some((entry) => entry.milestoneId === dep)) {
          errors.push(`${milestone.milestoneId}:unknown-dependency:${dep}`);
        }
      }
      for (const missing of missingProofForMilestone(milestone, loaded.projectDir)) {
        errors.push(`${milestone.milestoneId}:missing-proof:${missing}`);
      }
    }
  }
  return {
    format: "openclaw-snes-pcc-validation-v1",
    generatedAt: nowIso(),
    status: errors.length ? "fail" : "pass",
    ok: errors.length === 0,
    project,
    errors,
    missingFiles: loaded.missingFiles ?? [],
    gpt55Used: false,
    hostedGlmUsed: false,
    commercialMaterialUsed: false,
    fxpakWritePerformed: false,
  };
}

function milestonePassMap(milestones) {
  return new Map(
    milestones.map((milestone) => [milestone.milestoneId, milestone.status === "pass"]),
  );
}

export function planParallelMilestones({ milestones, maxParallel = 4 }) {
  const passed = milestonePassMap(milestones);
  const candidates = milestones.filter(
    (milestone) =>
      ["pending", "ready"].includes(milestone.status) &&
      (milestone.dependsOn ?? []).every((dep) => passed.get(dep) === true),
  );
  const sequential = candidates.find((milestone) => milestone.sequentialOnly);
  if (sequential) {
    return {
      format: "openclaw-snes-pcc-parallel-plan-v1",
      maxParallel,
      readyMilestones: [sequential.milestoneId],
      parallelBatches: [[sequential.milestoneId]],
      serializedMilestones: candidates
        .filter((m) => m.milestoneId !== sequential.milestoneId)
        .map((m) => m.milestoneId),
    };
  }
  const batch = [];
  const surfaces = new Set();
  const serialized = [];
  for (const milestone of candidates) {
    const conflicts = (milestone.allowedWriteSurfaces ?? []).some((surface) =>
      surfaces.has(surface),
    );
    if (!conflicts && batch.length < maxParallel) {
      batch.push(milestone.milestoneId);
      for (const surface of milestone.allowedWriteSurfaces ?? []) {
        surfaces.add(surface);
      }
    } else {
      serialized.push(milestone.milestoneId);
    }
  }
  return {
    format: "openclaw-snes-pcc-parallel-plan-v1",
    maxParallel,
    readyMilestones: candidates.map((milestone) => milestone.milestoneId),
    parallelBatches: batch.length ? [batch] : [],
    serializedMilestones: serialized,
  };
}

export function pccNext({ project, root, maxParallel = 4 }) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) {
    return {
      format: "openclaw-snes-pcc-next-v1",
      status: "blocked",
      ok: false,
      project,
      blocker: "project-not-found",
    };
  }
  const milestones = loaded.ledger?.milestones ?? [];
  const plan = planParallelMilestones({ milestones, maxParallel });
  return {
    format: "openclaw-snes-pcc-next-v1",
    generatedAt: nowIso(),
    status: plan.readyMilestones.length ? "pass" : "blocked",
    ok: plan.readyMilestones.length > 0,
    project,
    ...plan,
    nextMilestone: plan.parallelBatches[0]?.[0] ?? null,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function judgeMilestone({ project, root, milestoneId }) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) {
    return {
      format: "openclaw-snes-pcc-milestone-judge-v1",
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      failReasons: ["project-not-found"],
    };
  }
  const milestone = loaded.ledger?.milestones?.find((entry) => entry.milestoneId === milestoneId);
  if (!milestone) {
    return {
      format: "openclaw-snes-pcc-milestone-judge-v1",
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      failReasons: ["milestone-not-found"],
    };
  }
  const shapeErrors = validateMilestoneShape(milestone);
  const missingProof = missingProofForMilestone(
    { ...milestone, status: "pass" },
    loaded.projectDir,
  );
  const selfApproval =
    milestone.workerRole && milestone.judgeRole && milestone.workerRole === milestone.judgeRole;
  const failReasons = [
    ...shapeErrors,
    ...missingProof.map((name) => `missing-proof:${name}`),
    ...(selfApproval ? ["worker-self-approval-rejected"] : []),
  ];
  const requiresHuman = Boolean(
    milestone.humanApprovalRequired && missingProof.includes("humanVisualApproval"),
  );
  return {
    format: "openclaw-snes-pcc-milestone-judge-v1",
    generatedAt: nowIso(),
    status: failReasons.length ? (requiresHuman ? "blocked" : "fail") : "pass",
    ok: failReasons.length === 0,
    project,
    milestoneId,
    proofChecked: (milestone.requiredProof ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    ),
    missingProof,
    failReasons,
    repairRecommendation: failReasons.length
      ? "create-repair-plan-for-missing-proof-or-invalid-milestone"
      : "none",
    canRetry: failReasons.length > 0 && !requiresHuman,
    requiresHuman,
    completionPercent: failReasons.length ? Math.min(milestone.completionPercent ?? 0, 99) : 100,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function createRepairPlan({ project, root, milestoneId, failureClass = "invalid-patch" }) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) {
    return {
      format: "openclaw-snes-pcc-repair-plan-v1",
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      blocker: "project-not-found",
    };
  }
  if (!PCC_FAILURE_CLASSES.has(failureClass)) {
    return {
      format: "openclaw-snes-pcc-repair-plan-v1",
      status: "fail",
      ok: false,
      project,
      milestoneId,
      blocker: `invalid-failure-class:${failureClass}`,
    };
  }
  const milestone = loaded.ledger?.milestones?.find((entry) => entry.milestoneId === milestoneId);
  if (!milestone) {
    return {
      format: "openclaw-snes-pcc-repair-plan-v1",
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      blocker: "milestone-not-found",
    };
  }
  const queue = loaded.repairQueue ?? { format: "openclaw-snes-pcc-repair-queue-v1", repairs: [] };
  const priorCount = (queue.repairs ?? []).filter(
    (entry) => entry.failedMilestoneId === milestoneId,
  ).length;
  const retryCount = priorCount + 1;
  const externalBlocker = failureClass === "external-blocker";
  const exceeded = retryCount >= DEFAULT_RETRY_POLICY.maxAttempts;
  const nextModel =
    retryCount === 1
      ? DEFAULT_ROUTING_POLICY.routineWorkers.model
      : retryCount === 2
        ? DEFAULT_ROUTING_POLICY.routineWorkers.fallbacks[0]
        : retryCount === 3
          ? "openai/gpt-5.5-high-diagnosis-required"
          : "none";
  const repair = {
    id: `${milestoneId}-repair-${retryCount}`,
    createdAt: nowIso(),
    failedMilestoneId: milestoneId,
    failureClass,
    failingReceipt: milestone.latestReceipt ?? null,
    ownerRole: milestone.ownerRole,
    allowedWriteSurface: milestone.allowedWriteSurfaces?.[0] ?? "unknown",
    retryCount,
    nextModel: externalBlocker || exceeded ? "none" : nextModel,
    stopCondition: externalBlocker
      ? "external-blocker-requires-user-or-hardware-action"
      : exceeded
        ? "retry-limit-reached-block-unless-user-approves-deeper-work"
        : "rerun-milestone-judge-after-repair",
  };
  queue.repairs = [...(queue.repairs ?? []), repair];
  queue.generatedAt = nowIso();
  writeJson(pccFile(loaded.projectDir, "repair-queue.json"), queue);
  if (externalBlocker || exceeded) {
    milestone.status = "blocked";
    milestone.blocker = repair.stopCondition;
    writeJson(pccFile(loaded.projectDir, "milestone-ledger.json"), loaded.ledger);
  }
  return {
    format: "openclaw-snes-pcc-repair-plan-v1",
    generatedAt: nowIso(),
    status: externalBlocker || exceeded ? "blocked" : "pass",
    ok: !(externalBlocker || exceeded),
    project,
    milestoneId,
    repair,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

function writeLedger(projectDir, ledger) {
  writeJson(pccFile(projectDir, "milestone-ledger.json"), ledger);
}

function loadedOrBlocked({ project, root, format }) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) {
    return {
      loaded,
      blocked: {
        format,
        generatedAt: nowIso(),
        status: "blocked",
        ok: false,
        project,
        blocker: "project-not-found",
        gpt55Used: false,
        hostedGlmUsed: false,
      },
    };
  }
  return { loaded, blocked: null };
}

export function listApprovals({ project, root }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-approvals-v1",
  });
  if (blocked) {
    return blocked;
  }
  const approvals = loaded.approvalQueue?.approvals ?? [];
  return {
    format: "openclaw-snes-pcc-approvals-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    approvals,
    pendingApprovals: approvals.filter((approval) => approval.status === "pending"),
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function requestApproval({
  project,
  root,
  approvalType,
  milestoneId,
  reason = "approval-required",
  risk = "approval-gated-action",
  requestedAction = "manual-approval-required",
}) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-approval-request-v1",
  });
  if (blocked) {
    return blocked;
  }
  if (!PCC_APPROVAL_TYPES.has(approvalType)) {
    return {
      format: "openclaw-snes-pcc-approval-request-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      blocker: `invalid-approval-type:${approvalType}`,
      validApprovalTypes: [...PCC_APPROVAL_TYPES],
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  const queue = loaded.approvalQueue ?? {
    format: "openclaw-snes-pcc-approval-queue-v1",
    approvals: [],
  };
  const existing = (queue.approvals ?? []).find(
    (approval) =>
      approval.status === "pending" &&
      approval.approvalType === approvalType &&
      approval.milestoneId === milestoneId,
  );
  if (existing) {
    return {
      format: "openclaw-snes-pcc-approval-request-v1",
      generatedAt: nowIso(),
      status: "pass",
      ok: true,
      project,
      approval: existing,
      duplicateSuppressed: true,
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  const approval = {
    id: `${milestoneId}-${approvalType}-${sha256Text(`${milestoneId}:${approvalType}`).slice(0, 12)}`,
    createdAt: nowIso(),
    milestoneId,
    approvalType,
    reason,
    risk,
    requestedAction,
    status: "pending",
  };
  queue.approvals = [...(queue.approvals ?? []), approval];
  queue.generatedAt = nowIso();
  writeJson(pccFile(loaded.projectDir, "approval-queue.json"), queue);
  return {
    format: "openclaw-snes-pcc-approval-request-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    approval,
    duplicateSuppressed: false,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function setRunControl({ project, root, action }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-run-control-update-v1",
  });
  if (blocked) {
    return blocked;
  }
  const stateByAction = { pause: "paused", resume: "running", cancel: "cancelled" };
  const nextState = stateByAction[action];
  if (!nextState) {
    return {
      format: "openclaw-snes-pcc-run-control-update-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      blocker: `invalid-run-control-action:${action}`,
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  const runControl = {
    format: "openclaw-snes-pcc-run-control-v1",
    generatedAt: nowIso(),
    state: nextState,
    reason: action === "pause" ? "user-paused" : action === "cancel" ? "run-cancelled" : null,
  };
  writeJson(pccFile(loaded.projectDir, "run-control.json"), runControl);
  return {
    format: "openclaw-snes-pcc-run-control-update-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    action,
    runControl,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

function writeRunSummary(projectDir, project, runRecord) {
  const lines = [
    `# SNES PCC Run Summary: ${project}`,
    "",
    `Status: ${runRecord.status}`,
    `Stop reason: ${runRecord.stopReason}`,
    `Started: ${runRecord.startedAt}`,
    `Ended: ${runRecord.endedAt}`,
    `Completed milestones: ${runRecord.completedMilestones.join(", ") || "none"}`,
    `Blocked milestones: ${runRecord.blockedMilestones.join(", ") || "none"}`,
    `Approvals requested: ${runRecord.approvalsRequested.join(", ") || "none"}`,
    `Receipts checked: ${runRecord.receiptsChecked.join(", ") || "none"}`,
    `Next action: ${runRecord.nextAction}`,
    "",
  ].join("\n");
  fs.writeFileSync(pccFile(projectDir, "latest-run-summary.md"), lines);
}

function appendRunHistory(loaded, project, runRecord) {
  const history = loaded.runHistory ?? { format: "openclaw-snes-pcc-run-history-v1", runs: [] };
  history.generatedAt = nowIso();
  history.runs = [...(history.runs ?? []), runRecord];
  writeJson(pccFile(loaded.projectDir, "run-history.json"), history);
  writeRunSummary(loaded.projectDir, project, runRecord);
}

export function exportWorkerPacket({ project, root, milestoneId, allowPassed = false }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-worker-packet-v1",
  });
  if (blocked) {
    return blocked;
  }
  const milestone = loaded.ledger?.milestones?.find((entry) => entry.milestoneId === milestoneId);
  if (!milestone) {
    return {
      format: "openclaw-snes-pcc-worker-packet-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      blocker: "milestone-not-found",
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  const passed = milestonePassMap(loaded.ledger?.milestones ?? []);
  const ready =
    (["pending", "ready"].includes(milestone.status) ||
      (allowPassed && milestone.status === "pass")) &&
    (milestone.dependsOn ?? []).every((dep) => passed.get(dep) === true);
  if (!ready) {
    return {
      format: "openclaw-snes-pcc-worker-packet-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      blocker: "milestone-not-ready",
      currentStatus: milestone.status,
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  return {
    format: "openclaw-snes-pcc-worker-packet-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    milestoneId,
    ownerRole: milestone.ownerRole,
    allowedWriteSurfaces: milestone.allowedWriteSurfaces,
    requiredProof: milestone.requiredProof,
    passCriteria: milestone.passCriteria,
    failCriteria: milestone.failCriteria,
    forbiddenActions: [
      "hosted-glm-without-approval",
      "commercial-snes-material",
      "fxpak-removable-write",
      "paid-tools-without-approval",
      "unrelated-file-edits",
    ],
    modelPolicy: milestone.modelPolicy,
    receiptPath: `receipts/${milestoneId}.json`,
    nextValidationCommand: `pnpm snes:team -- --mode judge --project ${project} --milestone ${milestoneId} --json`,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

function markMilestoneBlocked(loaded, milestone, blocker) {
  milestone.status = "blocked";
  milestone.blocker = blocker;
  milestone.completionPercent = Math.min(milestone.completionPercent ?? 0, 99);
  writeLedger(loaded.projectDir, loaded.ledger);
}

export function runPccUntilBlocked({ project, root, maxMilestones = 10, maxMinutes = 480 }) {
  const { blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-run-v1",
  });
  if (blocked) {
    return blocked;
  }
  const startedAt = nowIso();
  const completedMilestones = [];
  const blockedMilestones = [];
  const approvalsRequested = [];
  const receiptsChecked = [];
  let stopReason = "max-milestones-reached";
  let status = "blocked";
  const startedMs = Date.now();
  for (let count = 0; count < maxMilestones; count += 1) {
    const fresh = loadPccProject({ project, root });
    const runState = fresh.runControl?.state ?? "running";
    if (runState === "paused") {
      stopReason = "run-paused";
      break;
    }
    if (runState === "cancelled") {
      stopReason = "run-cancelled";
      break;
    }
    if ((Date.now() - startedMs) / 60000 > maxMinutes) {
      stopReason = "max-minutes-reached";
      break;
    }
    const validation = validatePccProject({ project, root });
    receiptsChecked.push("project-validation");
    if (validation.status !== "pass") {
      stopReason = "validation-failed";
      break;
    }
    const next = pccNext({ project, root });
    if (!next.nextMilestone) {
      stopReason = "all-milestones-complete-or-none-ready";
      status = "pass";
      break;
    }
    const active = loadPccProject({ project, root });
    const milestone = active.ledger?.milestones?.find(
      (entry) => entry.milestoneId === next.nextMilestone,
    );
    if (!milestone) {
      stopReason = "milestone-not-found";
      break;
    }
    if (milestone.humanApprovalRequired) {
      const approval = requestApproval({
        project,
        root,
        approvalType: "human-production-visual-approval",
        milestoneId: milestone.milestoneId,
        reason: "humanApprovalRequired",
        risk: "subjective-production-quality-gate",
        requestedAction: "human-review-and-approve-before-pass",
      });
      if (approval.approval?.id) {
        approvalsRequested.push(approval.approval.id);
      }
      markMilestoneBlocked(active, milestone, "approval-required:human-production-visual-approval");
      blockedMilestones.push(milestone.milestoneId);
      stopReason = "approval-required";
      break;
    }
    const judge = judgeMilestone({ project, root, milestoneId: milestone.milestoneId });
    receiptsChecked.push(`judge:${milestone.milestoneId}`);
    if (judge.status === "pass") {
      milestone.status = "pass";
      milestone.completionPercent = 100;
      writeLedger(active.projectDir, active.ledger);
      completedMilestones.push(milestone.milestoneId);
      continue;
    }
    const repair = createRepairPlan({
      project,
      root,
      milestoneId: milestone.milestoneId,
      failureClass: judge.requiresHuman ? "external-blocker" : "runtime-failure",
    });
    if (repair.status === "blocked") {
      blockedMilestones.push(milestone.milestoneId);
      stopReason = repair.repair?.stopCondition ?? repair.blocker ?? "repair-blocked";
      break;
    }
    stopReason = "repair-created";
    break;
  }
  const endedAt = nowIso();
  const after = loadPccProject({ project, root });
  const remaining = planParallelMilestones({ milestones: after.ledger?.milestones ?? [] });
  const runRecord = {
    id: `run-${sha256Text(`${project}:${startedAt}`).slice(0, 12)}`,
    startedAt,
    endedAt,
    status,
    stopReason,
    completedMilestones,
    blockedMilestones,
    approvalsRequested,
    receiptsChecked,
    nextAction:
      approvalsRequested.length > 0
        ? "review-pending-approvals"
        : remaining.parallelBatches[0]?.[0]
          ? `continue-with:${remaining.parallelBatches[0][0]}`
          : "none",
    gpt55Used: false,
    hostedGlmUsed: false,
  };
  appendRunHistory(after, project, runRecord);
  return {
    format: "openclaw-snes-pcc-run-v1",
    generatedAt: endedAt,
    ok: status === "pass",
    project,
    ...runRecord,
  };
}

function safeRelativePccPath(relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    return null;
  }
  if (path.isAbsolute(relativePath) || relativePath.includes("..")) {
    return null;
  }
  return relativePath.replace(/^\/+/, "");
}

function commercialMaterialIndicator(value) {
  const text = String(value ?? "");
  return /\b(super\s+mario\s+world|commercial\s+snes|source\s+leak|disassembl(?:y|ies)|\.sfc\b|\.smc\b|\.swc\b|\.fig\b|\.rom\b)\b/iu.test(
    text,
  );
}

function fxpakWriteIndicator(value) {
  return /(?:\/Volumes\/|\bFXPAK\b|\bSD2SNES\b|removable-media|flashcart)/iu.test(
    String(value ?? ""),
  );
}

function validateWorkerOutputObject({
  output,
  project,
  milestoneId,
  dispatchId,
  allowedWriteSurfaces = [],
  requiredProof = [],
}) {
  const errors = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    errors.push("output-not-object");
  }
  if (output?.format !== "openclaw-snes-pcc-worker-output-v1") {
    errors.push("invalid-format");
  }
  if (output?.status !== "pass") {
    errors.push("status-not-pass");
  }
  if (output?.project !== project) {
    errors.push("wrong-project");
  }
  if (output?.milestoneId !== milestoneId) {
    errors.push("wrong-milestone");
  }
  if (dispatchId && output?.dispatchId !== dispatchId) {
    errors.push("wrong-dispatch-id");
  }
  if (output?.patchType !== "receipt-only") {
    errors.push("unsupported-patch-type");
  }
  if (output?.hostedGlmUsed !== false) {
    errors.push("hosted-glm-rejected");
  }
  if (output?.gpt55Used !== false) {
    errors.push("gpt55-rejected-for-routine-worker");
  }
  if (output?.commercialMaterialUsed === true) {
    errors.push("commercial-material-rejected");
  }
  if (output?.fxpakWritePerformed === true) {
    errors.push("fxpak-write-rejected");
  }
  if (output?.paidToolsUsed === true || output?.paidToolUsed === true) {
    errors.push("paid-tool-rejected");
  }
  if (!Array.isArray(output?.writes)) {
    errors.push("writes-not-array");
  }
  if (!Array.isArray(output?.receipts)) {
    errors.push("receipts-not-array");
  }
  if (!Array.isArray(output?.assumptions)) {
    errors.push("assumptions-not-array");
  }
  if (!Array.isArray(output?.risks)) {
    errors.push("risks-not-array");
  }
  if (typeof output?.playtestHypothesis !== "string" || !output.playtestHypothesis.trim()) {
    errors.push("missing-playtest-hypothesis");
  }

  for (const write of Array.isArray(output?.writes) ? output.writes : []) {
    const writePath = write?.path ?? "";
    if (pathLooksSecret(writePath)) {
      errors.push(`secret-like-write:${writePath}`);
    }
    if (commercialMaterialIndicator(writePath)) {
      errors.push(`commercial-material-write:${writePath}`);
    }
    if (fxpakWriteIndicator(writePath)) {
      errors.push(`fxpak-removable-write:${writePath}`);
    }
    if (!writeSurfaceMatches(writePath, allowedWriteSurfaces)) {
      errors.push(`write-surface-rejected:${writePath}`);
    }
  }
  if ((output?.writes ?? []).length > 0) {
    errors.push("file-writes-not-supported-in-pcc-real-model-v1");
  }

  const requiredProofNames = (requiredProof ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter(Boolean);
  const proofNames = new Set();
  for (const receipt of Array.isArray(output?.receipts) ? output.receipts : []) {
    if (!receipt?.proofName) {
      errors.push("receipt-missing-proofName");
    } else {
      proofNames.add(receipt.proofName);
    }
    const receiptPath = safeRelativePccPath(receipt?.path);
    if (!receiptPath) {
      errors.push(`unsafe-receipt-path:${receipt?.path ?? "missing"}`);
    }
    if (receiptPath && !receiptPath.startsWith("receipts/")) {
      errors.push(`receipt-outside-receipts-dir:${receipt.path}`);
    }
    if (pathLooksSecret(receipt?.path ?? "")) {
      errors.push(`secret-like-receipt:${receipt.path}`);
    }
    if (!receipt?.content || typeof receipt.content !== "object") {
      errors.push("receipt-missing-content");
    }
    if (receipt?.content?.hostedGlmUsed !== false) {
      errors.push("receipt-hosted-glm-rejected");
    }
    if (receipt?.content?.gpt55Used !== false) {
      errors.push("receipt-gpt55-rejected");
    }
  }
  for (const proofName of requiredProofNames) {
    if (!proofNames.has(proofName)) {
      errors.push(`missing-required-proof:${proofName}`);
    }
  }
  return {
    format: "openclaw-snes-pcc-worker-output-validation-v1",
    generatedAt: nowIso(),
    status: errors.length ? "fail" : "pass",
    ok: errors.length === 0,
    errors,
    hostedGlmUsed: false,
    gpt55Used: false,
  };
}

export function validateWorkerOutput({
  output,
  project,
  milestoneId,
  dispatchId,
  allowedWriteSurfaces = [],
  requiredProof = [],
}) {
  return validateWorkerOutputObject({
    output,
    project,
    milestoneId,
    dispatchId,
    allowedWriteSurfaces,
    requiredProof,
  });
}

export function parseAndValidateWorkerOutputText({
  text,
  project,
  milestoneId,
  dispatchId,
  allowedWriteSurfaces = [],
  requiredProof = [],
}) {
  const output = extractJsonObject(text);
  if (!output) {
    return {
      format: "openclaw-snes-pcc-worker-output-validation-v1",
      generatedAt: nowIso(),
      status: "fail",
      ok: false,
      errors: ["invalid-json"],
      hostedGlmUsed: false,
      gpt55Used: false,
    };
  }
  return validateWorkerOutputObject({
    output,
    project,
    milestoneId,
    dispatchId,
    allowedWriteSurfaces,
    requiredProof,
  });
}

function createAdapterWorkerOutput({ packet, dispatch, generator = "local-pcc-worker-adapter" }) {
  const proofReceipts = (packet.requiredProof ?? []).map((entry) => {
    const proofName = typeof entry === "string" ? entry : entry.name;
    return {
      proofName,
      path: `receipts/${packet.milestoneId}-${proofName}.json`,
      content: {
        format: "openclaw-snes-pcc-worker-proof-receipt-v1",
        status: "pass",
        milestoneId: packet.milestoneId,
        proofName,
        generatedBy: generator,
        localOnly: true,
        hostedGlmUsed: false,
        gpt55Used: false,
      },
    };
  });
  return {
    format: "openclaw-snes-pcc-worker-output-v1",
    status: "pass",
    project: packet.project,
    milestoneId: packet.milestoneId,
    dispatchId: dispatch.id,
    patchType: "receipt-only",
    writes: [],
    receipts: proofReceipts,
    assumptions: ["local-only PCC worker output", "legal clean-room SNES constraints preserved"],
    risks: ["receipt-only output does not replace later runtime proof"],
    playtestHypothesis: `${packet.milestoneId} proof receipts should allow deterministic PCC judging to pass for this milestone only.`,
    commercialMaterialUsed: false,
    fxpakWritePerformed: false,
    hostedGlmUsed: false,
    gpt55Used: false,
  };
}

function buildWorkerPrompt({ packet, dispatch, previousErrors = [] }) {
  const template = createAdapterWorkerOutput({
    packet,
    dispatch,
    generator: "local-ollama-worker",
  });
  return [
    "You are a local-only SNES Studio PCC worker.",
    "Return JSON only. No markdown. No comments. No code fences.",
    "Do not use hosted GLM, paid tools, commercial SNES ROMs/code/assets, or FXPAK/removable writes.",
    "Your output must exactly match the openclaw-snes-pcc-worker-output-v1 schema.",
    previousErrors.length
      ? `Repair these prior validation errors: ${previousErrors.join(", ")}`
      : "No prior validation errors.",
    "Worker packet:",
    JSON.stringify(packet),
    "Return this JSON shape with the same project, milestoneId, dispatchId, required proof receipts, and false hosted/gpt flags:",
    JSON.stringify(template),
  ].join("\n");
}

function callOllamaJson({
  modelRef,
  prompt,
  timeoutSeconds = 120,
  maxOutputTokens = 900,
  spawn = spawnSync,
}) {
  const payload = JSON.stringify({
    format: "json",
    model: ollamaModelId(modelRef),
    options: { num_ctx: 4096, num_predict: maxOutputTokens, temperature: 0 },
    prompt,
    stream: false,
  });
  const started = Date.now();
  const result = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      "http://127.0.0.1:11434/api/generate",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
  );
  const stdout = spawnText(result, "stdout");
  const stderr = spawnText(result, "stderr");
  const api = extractJsonObject(stdout);
  const raw = typeof api?.response === "string" ? api.response : stdout;
  const parsed = extractJsonObject(raw);
  const error = result.error
    ? String(result.error.message ?? result.error)
    : api?.error
      ? String(api.error)
      : result.status === 0
        ? null
        : stderr || `ollama-curl-exit-${result.status}`;
  return {
    status: error ? "blocked" : "pass",
    ok: !error,
    modelRef,
    latencyMs: Date.now() - started,
    promptSha256: sha256Text(prompt),
    responseSha256: sha256Text(raw),
    raw,
    parsed,
    error,
    exitStatus: result.status ?? null,
  };
}

export function modelHealth({ project, root, spawn = spawnSync, timeoutSeconds = 45 }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-model-health-v1",
  });
  if (blocked) {
    return blocked;
  }
  const listResult = spawn("ollama", ["list"], {
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
  });
  if (listResult.error || listResult.status !== 0) {
    return {
      format: "openclaw-snes-pcc-model-health-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      blocker: listResult.error
        ? String(listResult.error.message ?? listResult.error)
        : spawnText(listResult, "stderr") || `ollama-list-exit-${listResult.status}`,
      downloadsAttempted: false,
      hostedGlmUsed: false,
      gpt55Used: false,
    };
  }
  const installedModels = parseOllamaList(spawnText(listResult, "stdout"));
  const installed = new Set(installedModels);
  const probes = [];
  for (const modelRef of configuredLocalWorkerModels()) {
    if (!installed.has(modelRef)) {
      probes.push({ modelRef, status: "blocked", ok: false, blocker: "model-not-installed" });
      continue;
    }
    const prompt = 'Return exactly this JSON object: {"status":"pass","ok":true}';
    const call = callOllamaJson({ modelRef, prompt, timeoutSeconds, maxOutputTokens: 64, spawn });
    probes.push({
      modelRef,
      status: call.parsed?.status === "pass" ? "pass" : "blocked",
      ok: call.parsed?.status === "pass",
      blocker: call.error ?? (call.parsed?.status === "pass" ? null : "invalid-json-probe-output"),
      latencyMs: call.latencyMs,
      promptSha256: call.promptSha256,
      responseSha256: call.responseSha256,
    });
  }
  const usage = loaded.modelUsage ?? { format: "openclaw-snes-pcc-model-usage-v1", usage: [] };
  usage.generatedAt = nowIso();
  usage.health = { generatedAt: usage.generatedAt, installedModels, probes };
  writeJson(pccFile(loaded.projectDir, "model-usage.json"), usage);
  appendTelemetry(loaded, {
    type: "model-health",
    status: probes.some((probe) => probe.status === "pass") ? "pass" : "blocked",
    healthyModels: probes.filter((probe) => probe.status === "pass").map((probe) => probe.modelRef),
  });
  return {
    format: "openclaw-snes-pcc-model-health-v1",
    generatedAt: nowIso(),
    status: probes.some((probe) => probe.status === "pass") ? "pass" : "blocked",
    ok: probes.some((probe) => probe.status === "pass"),
    project,
    installedModels,
    probes,
    downloadsAttempted: false,
    hostedGlmUsed: false,
    gpt55Used: false,
  };
}

export function runLocalModelWorker({
  loaded,
  packet,
  dispatch,
  route,
  spawn = spawnSync,
  timeoutSeconds = 120,
}) {
  const outputDir = path.join(loaded.projectDir, "worker-outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${dispatch.id}.json`);
  const attempts = [];
  const models = route?.candidates?.map((candidate) => candidate.model) ?? [route.selectedModel];
  let previousErrors = [];
  for (const modelRef of models) {
    for (let repairAttempt = 0; repairAttempt < 2; repairAttempt += 1) {
      const prompt = buildWorkerPrompt({ packet, dispatch, previousErrors });
      const call = callOllamaJson({ modelRef, prompt, timeoutSeconds, spawn });
      const validation = call.parsed
        ? validateWorkerOutputObject({
            output: call.parsed,
            project: packet.project,
            milestoneId: packet.milestoneId,
            dispatchId: dispatch.id,
            allowedWriteSurfaces: packet.allowedWriteSurfaces,
            requiredProof: packet.requiredProof,
          })
        : {
            format: "openclaw-snes-pcc-worker-output-validation-v1",
            status: "fail",
            ok: false,
            errors: [call.error ?? "invalid-json"],
          };
      const attempt = {
        modelRef,
        repairAttempt,
        status: validation.status,
        errors: validation.errors ?? [],
        latencyMs: call.latencyMs,
        promptSha256: call.promptSha256,
        responseSha256: call.responseSha256,
        exitStatus: call.exitStatus,
      };
      attempts.push(attempt);
      if (validation.ok) {
        const output = {
          ...call.parsed,
          modelInvocation: {
            modelRef,
            modelInvoked: true,
            latencyMs: call.latencyMs,
            promptSha256: call.promptSha256,
            responseSha256: call.responseSha256,
            timeoutSeconds,
            validationStatus: "pass",
          },
        };
        writeJson(outputPath, output);
        return {
          format: "openclaw-snes-pcc-local-model-worker-v1",
          generatedAt: nowIso(),
          status: "pass",
          ok: true,
          modelInvoked: true,
          modelRef,
          workerOutputPath: path.relative(loaded.projectDir, outputPath),
          attempts,
          hostedGlmUsed: false,
          gpt55Used: false,
        };
      }
      previousErrors = validation.errors ?? ["invalid-json"];
    }
  }
  const failedPath = path.join(outputDir, `${dispatch.id}.failed.json`);
  writeJson(failedPath, {
    format: "openclaw-snes-pcc-worker-output-failure-v1",
    status: "blocked",
    project: packet.project,
    milestoneId: packet.milestoneId,
    dispatchId: dispatch.id,
    attempts,
    hostedGlmUsed: false,
    gpt55Used: false,
  });
  return {
    format: "openclaw-snes-pcc-local-model-worker-v1",
    generatedAt: nowIso(),
    status: "blocked",
    ok: false,
    modelInvoked: attempts.length > 0,
    blocker: attempts.at(-1)?.errors?.join(",") || "local-model-worker-output-invalid",
    failedOutputPath: path.relative(loaded.projectDir, failedPath),
    attempts,
    hostedGlmUsed: false,
    gpt55Used: false,
  };
}

function appendTelemetry(loaded, event) {
  const telemetry = loaded.telemetry ?? { format: "openclaw-snes-pcc-telemetry-v1", events: [] };
  telemetry.generatedAt = nowIso();
  telemetry.events = [...(telemetry.events ?? []), { at: nowIso(), ...event }];
  writeJson(pccFile(loaded.projectDir, "telemetry.json"), telemetry);
}

function selectLocalModelForRole(loaded, role) {
  const events = loaded.telemetry?.events ?? [];
  const models = [
    DEFAULT_ROUTING_POLICY.routineWorkers.model,
    ...DEFAULT_ROUTING_POLICY.routineWorkers.fallbacks,
  ];
  const candidates = models
    .map((model) => {
      const relevant = events.filter(
        (event) => event.model === model && (!role || event.role === role),
      );
      const failures = relevant.filter(
        (event) => event.status === "fail" || event.status === "blocked",
      ).length;
      const passes = relevant.filter((event) => event.status === "pass").length;
      return { model, score: 100 + passes * 5 - failures * 25, passes, failures };
    })
    .toSorted((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  return {
    format: "openclaw-snes-pcc-model-route-v1",
    role,
    selectedModel: candidates[0].model,
    candidates,
    hostedGlmUsed: false,
  };
}

function pathLooksSecret(filePath) {
  return /(?:secret|token|key|credential|\.pem$|ed25519|id_rsa|id_dsa)/i.test(filePath);
}

function writeSurfaceMatches(filePath, surfaces) {
  return surfaces.some(
    (surface) => filePath.includes(surface) || filePath.includes(surface.replaceAll("-", "_")),
  );
}

export function guardWriteSurfaces({
  beforeFiles = [],
  afterFiles = [],
  allowedWriteSurfaces = [],
}) {
  const before = new Set(beforeFiles);
  const changedFiles = afterFiles.filter((filePath) => !before.has(filePath));
  const secretChanges = changedFiles.filter(pathLooksSecret);
  const unexpectedChanges = changedFiles.filter(
    (filePath) => !writeSurfaceMatches(filePath, allowedWriteSurfaces),
  );
  return {
    format: "openclaw-snes-pcc-write-surface-guard-v1",
    status: secretChanges.length || unexpectedChanges.length ? "blocked" : "pass",
    ok: secretChanges.length === 0 && unexpectedChanges.length === 0,
    changedFiles,
    secretChanges,
    unexpectedChanges,
  };
}

export function dispatchWorker({
  project,
  root,
  milestoneId,
  dryRun = true,
  localOnly = false,
  invokeLocalModels = false,
  spawn = spawnSync,
  timeoutSeconds = 120,
}) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-worker-dispatch-v1",
  });
  if (blocked) {
    return blocked;
  }
  const packet = exportWorkerPacket({ project, root, milestoneId, allowPassed: invokeLocalModels });
  if (packet.status !== "pass") {
    return { ...packet, format: "openclaw-snes-pcc-worker-dispatch-v1" };
  }
  if (invokeLocalModels && (!localOnly || dryRun)) {
    return {
      format: "openclaw-snes-pcc-worker-dispatch-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      milestoneId,
      blocker: "real-model-dispatch-requires-local-only-non-dry-run",
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  const route = selectLocalModelForRole(loaded, packet.ownerRole);
  const sandbox = {
    sandboxId: `${milestoneId}-${sha256Text(`${project}:${milestoneId}`).slice(0, 10)}`,
    project,
    milestoneId,
    allowedWriteSurfaces: packet.allowedWriteSurfaces,
    forbiddenPaths: [
      "music-creator-v1/",
      "trading-lab/",
      "local-video-lab/",
      ".git/",
      "**/*.pem",
      "**/*ed25519*",
    ],
    expectedReceiptPath: packet.receiptPath,
    stopConditions: [
      "unexpected-file-change",
      "secret-like-path-change",
      "validation-failure",
      "approval-required",
    ],
  };
  const dispatch = {
    id: `${sandbox.sandboxId}-${dryRun ? "dry" : invokeLocalModels ? "ollama" : "local"}`,
    createdAt: nowIso(),
    project,
    milestoneId,
    dryRun,
    localOnly,
    invokeLocalModels,
    role: packet.ownerRole,
    model: route.selectedModel,
    modelInvoked: false,
    dispatchPlan: packet,
    sandbox,
    status: "pass",
  };
  const log = loaded.workerDispatchLog ?? {
    format: "openclaw-snes-pcc-worker-dispatch-log-v1",
    dispatches: [],
  };
  log.generatedAt = nowIso();
  log.dispatches = [...(log.dispatches ?? []), dispatch];
  writeJson(pccFile(loaded.projectDir, "worker-dispatch-log.json"), log);
  const sandboxes = loaded.workerSandboxes ?? {
    format: "openclaw-snes-pcc-worker-sandboxes-v1",
    sandboxes: [],
  };
  sandboxes.generatedAt = nowIso();
  sandboxes.sandboxes = [...(sandboxes.sandboxes ?? []), sandbox];
  writeJson(pccFile(loaded.projectDir, "worker-sandboxes.json"), sandboxes);
  appendTelemetry(loaded, {
    type: "worker-dispatch",
    status: "pass",
    role: packet.ownerRole,
    model: route.selectedModel,
    milestoneId,
    dryRun,
    localOnly,
    invokeLocalModels,
  });
  if (!dryRun && localOnly) {
    if (invokeLocalModels) {
      const worker = runLocalModelWorker({
        loaded,
        packet,
        dispatch,
        route,
        spawn,
        timeoutSeconds,
      });
      dispatch.modelInvoked = worker.modelInvoked === true;
      dispatch.modelInvocation = worker;
      if (worker.status !== "pass") {
        dispatch.status = "blocked";
        log.dispatches[log.dispatches.length - 1] = dispatch;
        writeJson(pccFile(loaded.projectDir, "worker-dispatch-log.json"), log);
        appendTelemetry(loaded, {
          type: "worker-dispatch-model-result",
          status: "blocked",
          milestoneId,
          model: route.selectedModel,
          blocker: worker.blocker,
        });
        return {
          format: "openclaw-snes-pcc-worker-dispatch-v1",
          generatedAt: nowIso(),
          status: "blocked",
          ok: false,
          project,
          milestoneId,
          dispatch,
          route,
          sandbox,
          worker,
          blocker: worker.blocker,
          gpt55Used: false,
          hostedGlmUsed: false,
        };
      }
      dispatch.workerOutputPath = worker.workerOutputPath;
      log.dispatches[log.dispatches.length - 1] = dispatch;
      writeJson(pccFile(loaded.projectDir, "worker-dispatch-log.json"), log);
      appendTelemetry(loaded, {
        type: "worker-dispatch-model-result",
        status: "pass",
        milestoneId,
        model: worker.modelRef,
        modelInvoked: true,
      });
    } else {
      const outputDir = path.join(loaded.projectDir, "worker-outputs");
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${dispatch.id}.json`);
      writeJson(outputPath, createAdapterWorkerOutput({ packet, dispatch }));
      dispatch.workerOutputPath = path.relative(loaded.projectDir, outputPath);
      log.dispatches[log.dispatches.length - 1] = dispatch;
      writeJson(pccFile(loaded.projectDir, "worker-dispatch-log.json"), log);
    }
  }
  return {
    format: "openclaw-snes-pcc-worker-dispatch-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    milestoneId,
    dispatch,
    route,
    sandbox,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function applyWorkerOutput({ project, root, workerOutputPath }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-apply-worker-output-v1",
  });
  if (blocked) {
    return blocked;
  }
  const resolved = path.isAbsolute(workerOutputPath)
    ? workerOutputPath
    : path.join(loaded.projectDir, workerOutputPath);
  if (!fs.existsSync(resolved)) {
    return {
      format: "openclaw-snes-pcc-apply-worker-output-v1",
      status: "blocked",
      ok: false,
      project,
      blocker: "worker-output-not-found",
    };
  }
  let output;
  try {
    output = readJson(resolved);
  } catch (error) {
    return {
      format: "openclaw-snes-pcc-apply-worker-output-v1",
      status: "blocked",
      ok: false,
      project,
      blocker: `invalid-worker-output-json:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const milestone = loaded.ledger?.milestones?.find(
    (entry) => entry.milestoneId === output?.milestoneId,
  );
  const validation = validateWorkerOutputObject({
    output,
    project,
    milestoneId: output?.milestoneId,
    allowedWriteSurfaces: milestone?.allowedWriteSurfaces ?? [],
    requiredProof: milestone?.requiredProof ?? [],
  });
  if (!milestone) {
    validation.errors.push("milestone-not-found");
  }
  if (!validation.ok || !milestone) {
    validation.status = "fail";
    validation.ok = false;
    return {
      format: "openclaw-snes-pcc-apply-worker-output-v1",
      status: "blocked",
      ok: false,
      project,
      blocker: "worker-output-validation-failed",
      validation,
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }

  for (const receipt of output.receipts ?? []) {
    const receiptPath = safeRelativePccPath(receipt.path);
    if (!receiptPath) {
      return {
        format: "openclaw-snes-pcc-apply-worker-output-v1",
        status: "blocked",
        ok: false,
        project,
        blocker: "unsafe-receipt-path",
      };
    }
    writeJson(path.join(loaded.projectDir, receiptPath), receipt.content ?? { status: "pass" });
  }
  const ledgerDoc = loaded.ledger;
  milestone.proof = { ...milestone.proof };
  for (const receipt of output.receipts ?? []) {
    if (receipt.proofName) {
      milestone.proof[receipt.proofName] = receipt.path;
    }
  }
  milestone.status = "pass";
  milestone.completionPercent = 100;
  milestone.latestReceipt = output.receipts?.[0]?.path ?? milestone.latestReceipt ?? null;
  writeJson(pccFile(loaded.projectDir, "milestone-ledger.json"), ledgerDoc);

  const judge = judgeMilestone({ project, root, milestoneId: output.milestoneId });
  const patch = {
    id: sha256Text(fs.readFileSync(resolved, "utf8")).slice(0, 16),
    appliedAt: nowIso(),
    workerOutputPath: path.relative(loaded.projectDir, resolved),
    milestoneId: output.milestoneId,
    patchType: output.patchType,
    status: judge.status,
    modelInvoked: output.modelInvocation?.modelInvoked === true,
  };
  const ledger = loaded.patchLedger ?? { format: "openclaw-snes-pcc-patch-ledger-v1", patches: [] };
  ledger.generatedAt = nowIso();
  ledger.patches = [...(ledger.patches ?? []), patch];
  writeJson(pccFile(loaded.projectDir, "patch-ledger.json"), ledger);
  appendTelemetry(loaded, {
    type: "apply-worker-output",
    status: judge.status,
    milestoneId: output.milestoneId,
    modelInvoked: output.modelInvocation?.modelInvoked === true,
  });
  return {
    format: "openclaw-snes-pcc-apply-worker-output-v1",
    generatedAt: nowIso(),
    status: judge.status === "pass" ? "pass" : "blocked",
    ok: judge.status === "pass",
    project,
    patch,
    judge,
    validation,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function resolvePccConflicts({ patches = [] }) {
  const seenFiles = new Set();
  const conflicts = [];
  for (const patch of patches) {
    for (const filePath of patch.files ?? []) {
      if (seenFiles.has(filePath)) {
        conflicts.push({ type: "same-file-conflict", filePath });
      }
      seenFiles.add(filePath);
    }
  }
  return {
    format: "openclaw-snes-pcc-conflict-resolution-v1",
    status: conflicts.length ? "blocked" : "pass",
    ok: conflicts.length === 0,
    conflicts,
  };
}

export function updateArtifactCache({
  project,
  root,
  cacheKey,
  inputSha,
  outputPath,
  toolVersion = "unknown",
}) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-artifact-cache-update-v1",
  });
  if (blocked) {
    return blocked;
  }
  const cache = loaded.artifactCache ?? {
    format: "openclaw-snes-pcc-artifact-cache-v1",
    entries: [],
  };
  const entry = {
    cacheKey,
    inputSha,
    outputPath,
    toolVersion,
    updatedAt: nowIso(),
    status: "pass",
  };
  cache.entries = [...(cache.entries ?? []).filter((item) => item.cacheKey !== cacheKey), entry];
  cache.generatedAt = nowIso();
  writeJson(pccFile(loaded.projectDir, "artifact-cache.json"), cache);
  return {
    format: "openclaw-snes-pcc-artifact-cache-update-v1",
    status: "pass",
    ok: true,
    project,
    entry,
  };
}

export function createReviewerReceipt({
  project,
  root,
  milestoneId,
  reviewerRole = "domain-reviewer",
  status = "pass",
  reasons = [],
}) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-reviewer-receipt-v1",
  });
  if (blocked) {
    return blocked;
  }
  const milestone = loaded.ledger?.milestones?.find((m) => m.milestoneId === milestoneId);
  const receipt = {
    id: `${milestoneId}-${reviewerRole}-${sha256Text(reasons.join("|")).slice(0, 8)}`,
    createdAt: nowIso(),
    milestoneId,
    reviewerRole,
    status,
    reasons,
    workerSelfApprovalRejected: reviewerRole === milestone?.workerRole,
  };
  const receipts = loaded.reviewerReceipts ?? {
    format: "openclaw-snes-pcc-reviewer-receipts-v1",
    receipts: [],
  };
  receipts.generatedAt = nowIso();
  receipts.receipts = [...(receipts.receipts ?? []), receipt];
  writeJson(pccFile(loaded.projectDir, "reviewer-receipts.json"), receipts);
  return {
    format: "openclaw-snes-pcc-reviewer-receipt-v1",
    status: receipt.workerSelfApprovalRejected ? "blocked" : status,
    ok: !receipt.workerSelfApprovalRejected && status === "pass",
    project,
    receipt,
  };
}

export function compactMemoryCards({ project, root }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-memory-compact-v1",
  });
  if (blocked) {
    return blocked;
  }
  const cards =
    loaded.ledger?.milestones?.map((milestone) => ({
      id: `milestone-${milestone.milestoneId}`,
      status: milestone.status,
      text: `${milestone.milestoneId}: ${milestone.title} is ${milestone.status}.`,
      sha256: sha256Text(JSON.stringify(milestone)),
    })) ?? [];
  writeJson(pccFile(loaded.projectDir, "memory-cards.json"), {
    format: "openclaw-snes-pcc-memory-cards-v1",
    generatedAt: nowIso(),
    cards,
  });
  return {
    format: "openclaw-snes-pcc-memory-compact-v1",
    status: "pass",
    ok: true,
    project,
    cardCount: cards.length,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function pccTelemetry({ project, root }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-telemetry-report-v1",
  });
  if (blocked) {
    return blocked;
  }
  const events = loaded.telemetry?.events ?? [];
  return {
    format: "openclaw-snes-pcc-telemetry-report-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    eventCount: events.length,
    events,
    gpt55Used: false,
    hostedGlmUsed: false,
  };
}

export function pccDashboardSnapshot({ project, root }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-dashboard-snapshot-v1",
  });
  if (blocked) {
    return blocked;
  }
  const status = pccStatus({ project, root });
  const approvals = listApprovals({ project, root });
  const snapshot = {
    format: "openclaw-snes-pcc-dashboard-snapshot-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    projectId: project,
    activeRun: loaded.runHistory?.runs?.at?.(-1) ?? null,
    pendingApprovals: approvals.pendingApprovals ?? [],
    blockedMilestones: (loaded.ledger?.milestones ?? [])
      .filter((m) => m.status === "blocked")
      .map((m) => m.milestoneId),
    nextSafeAction: status.nextMilestone ? `continue-with:${status.nextMilestone}` : "none",
    completionPercent: status.completionPercentByMilestoneCount,
  };
  writeJson(pccFile(loaded.projectDir, "dashboard-snapshot.json"), snapshot);
  return snapshot;
}

export function runRegressionBenchmark({ project, root }) {
  const { loaded, blocked } = loadedOrBlocked({
    project,
    root,
    format: "openclaw-snes-pcc-regression-benchmark-v1",
  });
  if (blocked) {
    return blocked;
  }
  const bench = loaded.regressionBenchmarks ?? {
    format: "openclaw-snes-pcc-regression-benchmarks-v1",
    prompts: [],
    runs: [],
  };
  const run = {
    id: `benchmark-${sha256Text(`${project}:${nowIso()}`).slice(0, 10)}`,
    createdAt: nowIso(),
    promptCount: bench.prompts?.length ?? 0,
    status: (bench.prompts?.length ?? 0) >= 3 ? "pass" : "blocked",
    legalCleanRoom: true,
    hostedGlmUsed: false,
  };
  bench.runs = [...(bench.runs ?? []), run];
  writeJson(pccFile(loaded.projectDir, "regression-benchmarks.json"), bench);
  return {
    format: "openclaw-snes-pcc-regression-benchmark-v1",
    status: run.status,
    ok: run.status === "pass",
    project,
    run,
  };
}

export function runLivePcc({
  project,
  root,
  maxMilestones = 10,
  maxMinutes = 480,
  maxParallel = 4,
  localOnly = true,
  invokeLocalModels = false,
  spawn = spawnSync,
  timeoutSeconds = 120,
}) {
  if (!localOnly) {
    return {
      format: "openclaw-snes-pcc-live-run-v1",
      status: "blocked",
      ok: false,
      project,
      blocker: "only-local-live-worker-execution-approved",
    };
  }
  const startedAt = Date.now();
  const completedMilestones = [];
  const dispatches = [];
  const applications = [];
  for (let index = 0; index < maxMilestones; index += 1) {
    if ((Date.now() - startedAt) / 60000 > maxMinutes) {
      return {
        format: "openclaw-snes-pcc-live-run-v1",
        generatedAt: nowIso(),
        status: "blocked",
        ok: false,
        project,
        stopReason: "time-limit-reached",
        completedMilestones,
        dispatches,
        applications,
        localOnly: true,
        invokeLocalModels,
        maxParallel,
        hostedGlmUsed: false,
        gpt55Used: false,
      };
    }
    const loaded = loadPccProject({ project, root });
    if (loaded.missingProject) {
      return {
        format: "openclaw-snes-pcc-live-run-v1",
        status: "blocked",
        ok: false,
        project,
        blocker: "project-not-found",
      };
    }
    const next = pccNext({ project, root, maxParallel });
    const candidateMilestones = next.parallelBatches?.[0] ?? [];
    const targetMilestone =
      candidateMilestones.find((id) => {
        const entry = loaded.ledger?.milestones?.find((milestone) => milestone.milestoneId === id);
        return entry && !entry.humanApprovalRequired;
      }) ?? next.nextMilestone;
    if (!targetMilestone) {
      return {
        format: "openclaw-snes-pcc-live-run-v1",
        generatedAt: nowIso(),
        status: "pass",
        ok: true,
        project,
        stopReason: "no-ready-milestone",
        completedMilestones,
        dispatches,
        applications,
        localOnly: true,
        invokeLocalModels,
        maxParallel,
        hostedGlmUsed: false,
        gpt55Used: false,
      };
    }
    const milestone = loaded.ledger?.milestones?.find(
      (entry) => entry.milestoneId === targetMilestone,
    );
    if (milestone?.humanApprovalRequired) {
      const approval = requestApproval({
        project,
        root,
        approvalType: "human-production-visual-approval",
        milestoneId: milestone.milestoneId,
        reason: "Live local worker execution cannot self-approve human visual quality.",
        risk: "production-visual-approval-required",
        requestedAction: "Provide explicit human visual approval receipt.",
      });
      return {
        format: "openclaw-snes-pcc-live-run-v1",
        generatedAt: nowIso(),
        status: "blocked",
        ok: false,
        project,
        stopReason: "human-approval-required",
        approval,
        completedMilestones,
        dispatches,
        applications,
        localOnly: true,
        invokeLocalModels,
        maxParallel,
        hostedGlmUsed: false,
        gpt55Used: false,
      };
    }
    const dispatch = dispatchWorker({
      project,
      root,
      milestoneId: targetMilestone,
      dryRun: false,
      localOnly: true,
      invokeLocalModels,
      spawn,
      timeoutSeconds,
    });
    dispatches.push(dispatch);
    if (dispatch.status !== "pass") {
      return {
        ...dispatch,
        format: "openclaw-snes-pcc-live-run-v1",
        completedMilestones,
        dispatches,
        applications,
      };
    }
    const apply = applyWorkerOutput({
      project,
      root,
      workerOutputPath: dispatch.dispatch.workerOutputPath,
    });
    applications.push(apply);
    if (apply.status !== "pass") {
      return {
        format: "openclaw-snes-pcc-live-run-v1",
        generatedAt: nowIso(),
        status: "blocked",
        ok: false,
        project,
        stopReason: "apply-or-judge-failed",
        completedMilestones,
        dispatches,
        applications,
        localOnly: true,
        invokeLocalModels,
        maxParallel,
        hostedGlmUsed: false,
        gpt55Used: false,
      };
    }
    completedMilestones.push(targetMilestone);
  }
  return {
    format: "openclaw-snes-pcc-live-run-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    stopReason: "max-milestones-reached",
    completedMilestones,
    dispatches,
    applications,
    localOnly: true,
    invokeLocalModels,
    maxParallel,
    hostedGlmUsed: false,
    gpt55Used: false,
  };
}

export function recordLastKnownGood({ project, root, milestoneId, receipt }) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) {
    throw new Error("project not found");
  }
  const buildHistory = loaded.buildHistory ?? { builds: [] };
  const record = {
    milestoneId,
    recordedAt: nowIso(),
    sourceHash: receipt.sourceHash ?? null,
    romHash: receipt.romHash ?? null,
    assetHashes: receipt.assetHashes ?? [],
    emulatorScreenshotHash: receipt.emulatorScreenshotHash ?? null,
    passReceipts: receipt.passReceipts ?? [],
    buildTimestamp: receipt.buildTimestamp ?? nowIso(),
  };
  buildHistory.lastKnownGood = record;
  buildHistory.builds = [...(buildHistory.builds ?? []), record];
  writeJson(pccFile(loaded.projectDir, "build-history.json"), buildHistory);
  return record;
}

export function pccStatus({ project, root, initialized, note } = {}) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) {
    return {
      format: "openclaw-snes-pcc-status-v1",
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      project,
      blocker: "project-not-found",
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
  const milestones = loaded.ledger?.milestones ?? [];
  const total = milestones.length;
  const counts = Object.fromEntries([...PCC_STATUSES].map((status) => [status, 0]));
  for (const milestone of milestones) {
    counts[milestone.status] = (counts[milestone.status] ?? 0) + 1;
  }
  const next = planParallelMilestones({
    milestones,
    maxParallel: loaded.dag?.maxParallelWorkers ?? 4,
  });
  return {
    format: "openclaw-snes-pcc-status-v1",
    generatedAt: nowIso(),
    status: "pass",
    ok: true,
    project,
    initialized: Boolean(initialized),
    note,
    projectDir: loaded.projectDir,
    totalMilestones: total,
    statusCounts: counts,
    completionPercentByMilestoneCount: total ? Math.round((counts.pass / total) * 1000) / 10 : 0,
    nextMilestone: next.parallelBatches[0]?.[0] ?? null,
    parallelPlan: next,
    futureMilestonesPreserved:
      loaded.ledger?.futureMilestonesPreserved ?? futureMilestonesPreserved(),
    gpt55Used: false,
    hostedGlmUsed: false,
    commercialMaterialUsed: false,
    fxpakWritePerformed: false,
  };
}

export function parseSnesTeamArgs(argv) {
  const args = { mode: "status", json: false, maxParallel: 4, maxMilestones: 10, maxMinutes: 480 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--local-only") {
      args.localOnly = true;
    } else if (arg === "--invoke-local-models") {
      args.invokeLocalModels = true;
    } else if (arg === "--mode") {
      args.mode = argv[++index];
    } else if (arg === "--project") {
      args.project = argv[++index];
    } else if (arg === "--prompt") {
      args.promptPath = argv[++index];
    } else if (arg === "--milestone") {
      args.milestoneId = argv[++index];
    } else if (arg === "--failure-class") {
      args.failureClass = argv[++index];
    } else if (arg === "--approval-type") {
      args.approvalType = argv[++index];
    } else if (arg === "--reason") {
      args.reason = argv[++index];
    } else if (arg === "--risk") {
      args.risk = argv[++index];
    } else if (arg === "--requested-action") {
      args.requestedAction = argv[++index];
    } else if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--max-parallel") {
      args.maxParallel = Number(argv[++index]);
    } else if (arg === "--max-workers") {
      args.maxParallel = Number(argv[++index]);
    } else if (arg === "--max-milestones") {
      args.maxMilestones = Number(argv[++index]);
    } else if (arg === "--max-minutes") {
      args.maxMinutes = Number(argv[++index]);
    } else if (arg === "--model-timeout-seconds") {
      args.modelTimeoutSeconds = Number(argv[++index]);
    } else if (arg === "--asset-intent") {
      args.assetIntentPath = argv[++index];
    } else if (arg === "--worker-output") {
      args.workerOutputPath = argv[++index];
    } else if (arg === "--cache-key") {
      args.cacheKey = argv[++index];
    } else if (arg === "--input-sha") {
      args.inputSha = argv[++index];
    } else if (arg === "--output-path") {
      args.outputPath = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

export function snesTeamHelp() {
  return [
    "Usage: pnpm snes:team -- --mode <init|status|next|validate|judge|repair-plan|approvals|request-approval|run|run-live|resume-live|model-health|pause|resume|cancel|worker-packet|dispatch-worker|apply-worker-output|asset-intent-validate> --project <id> [--json]",
    "       pnpm snes:team -- --mode init --project demo --prompt fixtures/snes-demo-prompt.txt --json",
    "       pnpm snes:team -- --mode repair-plan --project demo --milestone PCC-010-level-plan --failure-class runtime-failure --json",
    "       pnpm snes:team -- --mode asset-intent-validate --asset-intent asset-intent.json --json",
  ].join("\n");
}

export function runSnesTeam(args) {
  if (args.help) {
    return { status: "pass", ok: true, help: snesTeamHelp() };
  }
  const mode = args.mode ?? "status";
  if (mode !== "asset-intent-validate" && !args.project) {
    return { format: PCC_FORMAT, status: "blocked", ok: false, blocker: "missing-project" };
  }
  try {
    if (mode === "init") {
      return initPccProject({
        project: args.project,
        promptPath: args.promptPath,
        root: args.root,
      });
    }
    if (mode === "status") {
      return pccStatus({ project: args.project, root: args.root });
    }
    if (mode === "next") {
      return pccNext({ project: args.project, root: args.root, maxParallel: args.maxParallel });
    }
    if (mode === "validate") {
      return validatePccProject({ project: args.project, root: args.root });
    }
    if (mode === "judge") {
      return judgeMilestone({
        project: args.project,
        root: args.root,
        milestoneId: args.milestoneId,
      });
    }
    if (mode === "repair-plan") {
      return createRepairPlan({
        project: args.project,
        root: args.root,
        milestoneId: args.milestoneId,
        failureClass: args.failureClass ?? "invalid-patch",
      });
    }
    if (mode === "approvals") {
      return listApprovals({ project: args.project, root: args.root });
    }
    if (mode === "request-approval") {
      return requestApproval({
        project: args.project,
        root: args.root,
        approvalType: args.approvalType,
        milestoneId: args.milestoneId,
        reason: args.reason,
        risk: args.risk,
        requestedAction: args.requestedAction,
      });
    }
    if (["pause", "resume", "cancel"].includes(mode)) {
      return setRunControl({ project: args.project, root: args.root, action: mode });
    }
    if (mode === "run") {
      return runPccUntilBlocked({
        project: args.project,
        root: args.root,
        maxMilestones: args.maxMilestones,
        maxMinutes: args.maxMinutes,
      });
    }
    if (mode === "worker-packet") {
      return exportWorkerPacket({
        project: args.project,
        root: args.root,
        milestoneId: args.milestoneId,
      });
    }
    if (mode === "model-health") {
      return modelHealth({
        project: args.project,
        root: args.root,
        timeoutSeconds: args.modelTimeoutSeconds ?? 45,
      });
    }
    if (mode === "dispatch-worker") {
      return dispatchWorker({
        project: args.project,
        root: args.root,
        milestoneId: args.milestoneId,
        dryRun: args.dryRun || !args.localOnly,
        localOnly: args.localOnly,
        invokeLocalModels: args.invokeLocalModels,
        timeoutSeconds: args.modelTimeoutSeconds ?? 120,
      });
    }
    if (mode === "apply-worker-output") {
      return applyWorkerOutput({
        project: args.project,
        root: args.root,
        workerOutputPath: args.workerOutputPath,
      });
    }
    if (mode === "telemetry") {
      return pccTelemetry({ project: args.project, root: args.root });
    }
    if (mode === "dashboard-snapshot") {
      return pccDashboardSnapshot({ project: args.project, root: args.root });
    }
    if (mode === "regression-benchmark") {
      return runRegressionBenchmark({ project: args.project, root: args.root });
    }
    if (mode === "run-live" || mode === "resume-live") {
      return runLivePcc({
        project: args.project,
        root: args.root,
        maxMilestones: args.maxMilestones,
        maxMinutes: args.maxMinutes,
        maxParallel: args.maxParallel,
        localOnly: args.localOnly,
        invokeLocalModels: args.invokeLocalModels,
        timeoutSeconds: args.modelTimeoutSeconds ?? 120,
      });
    }
    if (mode === "artifact-cache-update") {
      return updateArtifactCache({
        project: args.project,
        root: args.root,
        cacheKey: args.cacheKey,
        inputSha: args.inputSha,
        outputPath: args.outputPath,
      });
    }
    if (mode === "memory-compact") {
      return compactMemoryCards({ project: args.project, root: args.root });
    }
    if (mode === "asset-intent-validate") {
      return validateAssetIntentContract(readJson(args.assetIntentPath));
    }
    return { format: PCC_FORMAT, status: "blocked", ok: false, blocker: `unknown-mode:${mode}` };
  } catch (error) {
    return {
      format: PCC_FORMAT,
      generatedAt: nowIso(),
      status: "blocked",
      ok: false,
      blocker: error instanceof Error ? error.message : String(error),
      gpt55Used: false,
      hostedGlmUsed: false,
    };
  }
}

export function snesTeamSucceeded(report) {
  return report?.ok !== false && !["fail", "blocked", "rejected"].includes(report?.status);
}

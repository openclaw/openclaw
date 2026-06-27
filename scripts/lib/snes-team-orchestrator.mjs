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
  "model-usage.json",
  "build-history.json",
  "latest-summary.md",
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

export function loadPccProject({ project, root }) {
  const projectDir = pccProjectDir({ project, root });
  if (!fs.existsSync(projectDir)) {
    return { ok: false, projectDir, missingProject: true };
  }
  const files = Object.fromEntries(
    PCC_STATE_FILES.map((name) => [name, pccFile(projectDir, name)]),
  );
  const missingFiles = PCC_STATE_FILES.filter((name) => !fs.existsSync(files[name]));
  const loaded = { ok: missingFiles.length === 0, projectDir, files, missingFiles };
  if (fs.existsSync(files["project.intent.json"]))
    loaded.intent = readJson(files["project.intent.json"]);
  if (fs.existsSync(files["milestone-ledger.json"]))
    loaded.ledger = readJson(files["milestone-ledger.json"]);
  if (fs.existsSync(files["dependency-dag.json"]))
    loaded.dag = readJson(files["dependency-dag.json"]);
  if (fs.existsSync(files["repair-queue.json"]))
    loaded.repairQueue = readJson(files["repair-queue.json"]);
  if (fs.existsSync(files["build-history.json"]))
    loaded.buildHistory = readJson(files["build-history.json"]);
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
  if (!Number.isInteger(intent?.frames) || intent.frames < 1) errors.push("invalid-frames");
  if (
    !Number.isInteger(intent?.paletteLimit) ||
    intent.paletteLimit < 1 ||
    intent.paletteLimit > 16
  ) {
    errors.push("invalid-paletteLimit");
  }
  if (!Array.isArray(intent?.mustShow) || intent.mustShow.length === 0)
    errors.push("missing-mustShow");
  if (!Array.isArray(intent?.mustNotShow)) errors.push("missing-mustNotShow");
  if (!Array.isArray(intent?.animationBeats)) errors.push("missing-animationBeats");
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
    if (!(field in milestone)) errors.push(`missing-${field}`);
  }
  if (!PCC_STATUSES.has(milestone.status)) errors.push("invalid-status");
  if (!Array.isArray(milestone.dependsOn)) errors.push("dependsOn-not-array");
  if (
    !Array.isArray(milestone.allowedWriteSurfaces) ||
    milestone.allowedWriteSurfaces.length === 0
  ) {
    errors.push("allowedWriteSurfaces-empty");
  }
  if (!Array.isArray(milestone.requiredProof)) errors.push("requiredProof-not-array");
  if (typeof milestone.completionPercent !== "number") errors.push("completionPercent-not-number");
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
  if (milestone.status !== "pass") return [];
  const proof = milestone.proof ?? {};
  const missing = [];
  for (const entry of milestone.requiredProof ?? []) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (!name) continue;
    const proofPath = proof[name];
    if (!proofPath) {
      missing.push(name);
      continue;
    }
    const resolved = path.isAbsolute(proofPath) ? proofPath : path.join(projectDir, proofPath);
    if (!fs.existsSync(resolved)) missing.push(name);
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
  for (const missing of loaded.missingFiles ?? []) errors.push(`missing-state-file:${missing}`);
  const ledger = loaded.ledger;
  if (!ledger || !Array.isArray(ledger.milestones)) {
    errors.push("missing-or-invalid-ledger");
  } else {
    const ids = new Set();
    for (const milestone of ledger.milestones) {
      for (const error of validateMilestoneShape(milestone)) {
        errors.push(`${milestone.milestoneId ?? "unknown"}:${error}`);
      }
      if (ids.has(milestone.milestoneId)) errors.push(`${milestone.milestoneId}:duplicate-id`);
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
      for (const surface of milestone.allowedWriteSurfaces ?? []) surfaces.add(surface);
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

export function recordLastKnownGood({ project, root, milestoneId, receipt }) {
  const loaded = loadPccProject({ project, root });
  if (loaded.missingProject) throw new Error("project not found");
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
  for (const milestone of milestones)
    counts[milestone.status] = (counts[milestone.status] ?? 0) + 1;
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
  const args = { mode: "status", json: false, maxParallel: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--project") args.project = argv[++index];
    else if (arg === "--prompt") args.promptPath = argv[++index];
    else if (arg === "--milestone") args.milestoneId = argv[++index];
    else if (arg === "--failure-class") args.failureClass = argv[++index];
    else if (arg === "--root") args.root = argv[++index];
    else if (arg === "--max-parallel") args.maxParallel = Number(argv[++index]);
    else if (arg === "--asset-intent") args.assetIntentPath = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function snesTeamHelp() {
  return [
    "Usage: pnpm snes:team -- --mode <init|status|next|validate|judge|repair-plan|asset-intent-validate> --project <id> [--json]",
    "       pnpm snes:team -- --mode init --project demo --prompt fixtures/snes-demo-prompt.txt --json",
    "       pnpm snes:team -- --mode repair-plan --project demo --milestone PCC-010-level-plan --failure-class runtime-failure --json",
    "       pnpm snes:team -- --mode asset-intent-validate --asset-intent asset-intent.json --json",
  ].join("\n");
}

export function runSnesTeam(args) {
  if (args.help) return { status: "pass", ok: true, help: snesTeamHelp() };
  const mode = args.mode ?? "status";
  if (mode !== "asset-intent-validate" && !args.project) {
    return { format: PCC_FORMAT, status: "blocked", ok: false, blocker: "missing-project" };
  }
  try {
    if (mode === "init")
      return initPccProject({
        project: args.project,
        promptPath: args.promptPath,
        root: args.root,
      });
    if (mode === "status") return pccStatus({ project: args.project, root: args.root });
    if (mode === "next")
      return pccNext({ project: args.project, root: args.root, maxParallel: args.maxParallel });
    if (mode === "validate") return validatePccProject({ project: args.project, root: args.root });
    if (mode === "judge")
      return judgeMilestone({
        project: args.project,
        root: args.root,
        milestoneId: args.milestoneId,
      });
    if (mode === "repair-plan")
      return createRepairPlan({
        project: args.project,
        root: args.root,
        milestoneId: args.milestoneId,
        failureClass: args.failureClass ?? "invalid-patch",
      });
    if (mode === "asset-intent-validate")
      return validateAssetIntentContract(readJson(args.assetIntentPath));
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

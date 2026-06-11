import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
} from "openclaw/plugin-sdk/simple-completion-runtime";
import {
  applyAppBuilderPatchPlan,
  applyAppBuilderImplementationPass,
  captureIosSimulatorScreenshot,
  createBuildDryRunTask,
  createAppStorePublishPlan,
  createAppBuilderFinalVerifierReport,
  createDefaultAppBuilderScreenFlow,
  createIosNativeApp,
  evaluateAppBuilderModelReadiness,
  evaluateAppBuilderReadiness,
  evaluateAppStoreReadiness,
  normalizeAppBuilderScreenFlow,
  readProductSpec,
  repairIosApp,
  renderAppBuilderModelsSwift,
  renderAppBuilderTestsSwift,
  validateIosApp,
  type AppBuilderPatchChange,
  type AppBuilderPatchPlan,
  type AppBuilderScreenFlowEdge,
  type AppBuilderScreenFlow,
  type AppBuilderProductSpec,
} from "./app-builder.js";

const BUILDER_DIR = ".openclaw-app-builder";
const STUDIO_PROJECT_FILE = "app-studio-project.json";
const AI_BUILD_RAW_OUTPUT_FILE = "ai-build-raw-output.txt";
const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;
const APPROVAL_SCOPE = "operator.approvals" as const;
const APP_STUDIO_CODEX_MODEL_REF = "openai-codex/gpt-5.5";
const APP_STUDIO_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const APP_STUDIO_AI_BUILD_TIMEOUT_MS = 600_000;
const APP_STUDIO_QWEN_OPTIONS = {
  temperature: 0.1,
  top_p: 0.9,
  top_k: 20,
  repeat_penalty: 1.05,
  num_ctx: 32_768,
  num_predict: 6_144,
} as const;

export type AppStudioStageId =
  | "idea"
  | "blueprint"
  | "build"
  | "preview"
  | "testflight"
  | "app-store";

export type AppStudioGateId =
  | "model-check"
  | "validate-structure"
  | "validate-build"
  | "screenshots"
  | "app-store-ready"
  | "publish-plan"
  | "final-verify"
  | "ready"
  | "implement"
  | "repair"
  | "builder-task";

export type AppStudioBuildEngine = "local-qwen" | "codex";

export type AppStudioAgentWorkStatus = "idle" | "queued" | "running" | "blocked" | "done";

export type AppStudioAgentWorkItem = {
  id: string;
  label: string;
  role: string;
  modelRef: string;
  status: AppStudioAgentWorkStatus;
  currentTask: string;
  inputs: string[];
  outputs: string[];
  blockedOn: string[];
  lastEvent: string;
  updatedAt: string;
};

export type AppStudioBuildEngineOption = {
  id: AppStudioBuildEngine;
  label: string;
  modelRef: string;
  detail: string;
  privacy: "local" | "cloud";
};

export type AppStudioPromptEntry = {
  id: string;
  prompt: string;
  at: string;
  summary: string;
};

export type AppStudioVisualReference = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  importedAt: string;
  notes: string;
};

export type AppStudioProjectRecord = {
  schemaVersion: 1;
  appId: string;
  appDir: string;
  createdAt: string;
  updatedAt: string;
  buildEngine: AppStudioBuildEngine;
  promptHistory: AppStudioPromptEntry[];
  visualInputs: AppStudioVisualReference[];
  agentWorkboard: AppStudioAgentWorkItem[];
  approvals: Array<{
    id: string;
    label: string;
    status: "blocked" | "approved";
    approvedAt?: string;
  }>;
  appleFacts: {
    appStoreConnectAppId: string;
    sku: string;
    teamId: string;
    apiKeyProfileRef: string;
  };
  xcodeHandoff: {
    recommended: boolean;
    reason: string;
  };
};

export type AppStudioProjectSummary = {
  appId: string;
  appName: string;
  appDir: string;
  bundleId: string;
  updatedAt: string;
  stage: AppStudioStageId;
  completionGrade: number;
  criticality: number;
  nextAction: string;
  readyToBuild: boolean;
  readyForAppStore: boolean;
};

export type AppStudioActivityEvent = {
  at: string;
  stage: string;
  result: string;
  summary: string;
};

export type AppStudioSelectedProject = AppStudioProjectSummary & {
  spec: AppBuilderProductSpec;
  studio: AppStudioProjectRecord;
  screens: AppBuilderProductSpec["screens"];
  screenFlow: AppBuilderScreenFlow;
  dataModel: AppBuilderProductSpec["dataModel"];
  prompts: AppStudioPromptEntry[];
  visualInputs: AppStudioVisualReference[];
  activity: AppStudioActivityEvent[];
  appStoreConnect: Record<string, unknown>;
  metadata: Record<string, unknown>;
  latestReports: {
    readiness: Record<string, unknown> | null;
    gaps: Record<string, unknown> | null;
    validation: Record<string, unknown> | null;
    model: Record<string, unknown> | null;
    implementation: Record<string, unknown> | null;
    repair: Record<string, unknown> | null;
    aiBuild: Record<string, unknown> | null;
    patch: Record<string, unknown> | null;
    screenshot: Record<string, unknown> | null;
    appStore: Record<string, unknown> | null;
    publishPlan: Record<string, unknown> | null;
    finalVerifier: Record<string, unknown> | null;
  };
};

export type AppStudioDashboardSnapshot = {
  schemaVersion: 1;
  checkedAt: string;
  projects: AppStudioProjectSummary[];
  selectedProject: AppStudioSelectedProject | null;
  defaultPrompt: string;
  buildEngineOptions: AppStudioBuildEngineOption[];
  stages: Array<{ id: AppStudioStageId; label: string; detail: string }>;
  gates: Array<{ id: AppStudioGateId; label: string; detail: string; requiresApproval: boolean }>;
  nextAction: string;
};

export type AppStudioActionReceipt = {
  title: string;
  detail: string;
  next: string;
};

export type AppStudioActionResult = {
  snapshot: AppStudioDashboardSnapshot;
  receipt: AppStudioActionReceipt;
};

export type CreateAppStudioProjectOptions = {
  request: string;
  appName?: string;
  appId?: string;
  bundleId?: string;
  cwd?: string;
  outputDir?: string;
  force?: boolean;
  buildEngine?: AppStudioBuildEngine;
  now?: Date;
};

export type ApplyAppStudioPromptOptions = {
  appDir: string;
  prompt: string;
  now?: Date;
};

export type SetAppStudioBuildEngineOptions = {
  appDir: string;
  buildEngine: AppStudioBuildEngine;
  now?: Date;
};

export type AppStudioScreenFlowInput = {
  entryScreenId?: string;
  edges: AppBuilderScreenFlowEdge[];
};

export type AppStudioScreenImageUpload = {
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  dataUrl?: string;
  dataBase64?: string;
};

export type AppStudioScreenAnalysisInput = {
  screens?: Array<{
    title?: string;
    name?: string;
    purpose?: string;
    description?: string;
    visibleText?: string[];
    sourceImageIds?: string[];
  }>;
  connections?: Array<{
    fromTitle?: string;
    from?: string;
    toTitle?: string;
    to?: string;
    label?: string;
    trigger?: string;
  }>;
  questions?: string[];
};

export type AppStoreFactPatch = {
  appStoreConnectAppId?: string;
  sku?: string;
  teamId?: string;
  signingIdentity?: string;
  provisioningProfile?: string;
  apiKeyProfileRef?: string;
  supportUrl?: string;
  privacyUrl?: string;
  reviewContactName?: string;
  reviewContactEmail?: string;
  reviewContactPhone?: string;
};

export type AppStudioAiCompletionRequest = {
  engine: AppStudioBuildEngine;
  label: string;
  modelRef: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
};

export type AppStudioAiRuntime = {
  cfg?: OpenClawConfig;
  ollamaBaseUrl?: string;
  completeText?: (request: AppStudioAiCompletionRequest) => Promise<string>;
};

type GatewayMethodContext = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type GatewayRespond = GatewayMethodContext["respond"];

type UnknownRecord = Record<string, unknown>;

const DEFAULT_APP_PROMPT =
  "Create a polished, private, local-only iPhone app. No accounts, no analytics, no ads, no tracking, no location, no contacts, no health data, and no network dependency.";

const BUILD_ENGINE_OPTIONS: AppStudioBuildEngineOption[] = [
  {
    id: "local-qwen",
    label: "Local Qwen Q8",
    modelRef: "ollama/qwen3.6:27b-q8_0",
    detail: "Private local code generation on the Mac Studio. Best for local-first drafts.",
    privacy: "local",
  },
  {
    id: "codex",
    label: "Codex GPT-5.5",
    modelRef: "openai/gpt-5.5",
    detail: "Cloud Codex coding pass for harder SwiftUI changes, with the same local gates.",
    privacy: "cloud",
  },
];

const STAGES: AppStudioDashboardSnapshot["stages"] = [
  { id: "idea", label: "Idea", detail: "Say what the app should do in plain English." },
  { id: "blueprint", label: "Blueprint", detail: "Review screens, data, privacy, and App Store shape." },
  { id: "build", label: "Build", detail: "Generate app-local SwiftUI code and run validation." },
  { id: "preview", label: "Preview", detail: "Launch in simulator and capture screenshot evidence." },
  { id: "testflight", label: "TestFlight", detail: "Prepare signing, archive, export, and upload plan." },
  { id: "app-store", label: "App Store", detail: "Complete metadata, privacy labels, review notes, and approval." },
];

const GATES: AppStudioDashboardSnapshot["gates"] = [
  {
    id: "model-check",
    label: "Check AI coder",
    detail: "Verify the selected coding lane and local fallback evidence.",
    requiresApproval: false,
  },
  {
    id: "builder-task",
    label: "Run AI build pass",
    detail: "Ask the selected AI coder for an app-local patch plan, apply safeguards, and record evidence.",
    requiresApproval: false,
  },
  {
    id: "implement",
    label: "Implement app UI",
    detail: "Apply the constrained app-local SwiftUI implementation pass.",
    requiresApproval: false,
  },
  {
    id: "validate-structure",
    label: "Check project files",
    detail: "Validate the scaffold without running host Xcode.",
    requiresApproval: false,
  },
  {
    id: "validate-build",
    label: "Build and test",
    detail: "Run XcodeGen and xcodebuild tests on the simulator.",
    requiresApproval: false,
  },
  {
    id: "repair",
    label: "Repair validation failure",
    detail: "Run the app-local repair loop and rerun validation evidence.",
    requiresApproval: false,
  },
  {
    id: "screenshots",
    label: "Capture screenshot",
    detail: "Install, launch, and capture simulator screenshot evidence.",
    requiresApproval: false,
  },
  {
    id: "app-store-ready",
    label: "Check App Store evidence",
    detail: "Find missing signing, privacy, screenshot, and metadata evidence.",
    requiresApproval: false,
  },
  {
    id: "publish-plan",
    label: "Prepare publish plan",
    detail: "Write the gated archive, export, TestFlight, and rollback plan.",
    requiresApproval: true,
  },
  {
    id: "final-verify",
    label: "Run final verifier",
    detail: "Write the evidence-backed final verifier report before owner-controlled release actions.",
    requiresApproval: false,
  },
  {
    id: "ready",
    label: "Summarize readiness",
    detail: "Show completion grade, criticality, and the next highest-impact gap.",
    requiresApproval: false,
  },
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function stringParam(params: UnknownRecord, key: string): string | undefined;
function stringParam(params: UnknownRecord, key: string, required: true): string;
function stringParam(params: UnknownRecord, key: string, required = false): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (required) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return undefined;
}

function booleanParam(params: UnknownRecord, key: string): boolean | undefined {
  return typeof params[key] === "boolean" ? params[key] : undefined;
}

function stringArrayParam(params: UnknownRecord, key: string, required = false): string[] {
  const value = params[key];
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  if (required) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return [];
}

function normalizeBuildEngine(value: unknown): AppStudioBuildEngine {
  return value === "codex" ? "codex" : "local-qwen";
}

function buildEngineOption(engine: AppStudioBuildEngine): AppStudioBuildEngineOption {
  return BUILD_ENGINE_OPTIONS.find((option) => option.id === engine) ?? BUILD_ENGINE_OPTIONS[0];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorMessageWithCause(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof Error) || error.cause === undefined) {
    return message;
  }
  const cause =
    error.cause instanceof Error
      ? error.cause.message
      : typeof error.cause === "string"
        ? error.cause
        : "";
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

function respondError(respond: GatewayRespond, error: unknown) {
  respond(false, undefined, {
    code: "internal_error",
    message: errorMessage(error),
  });
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function relativeSummaryPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app-change"
  );
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt
    .replace(/\b(no|without|remove|disable)\b.*$/i, " ")
    .replace(/\b(add|create|make|please|screen|view|tab|feature|for|with|and|the|a|an)\b/gi, " ")
    .replace(/\b(no|analytics|tracking|ads|network|account|login|location|contacts|health)\b/gi, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (compact || "Requested Change").split(" ").slice(0, 4);
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string): Promise<UnknownRecord> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonObject(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendEvidence(appDir: string, event: UnknownRecord): Promise<void> {
  const ledgerPath = path.join(appDir, BUILDER_DIR, "evidence-ledger.json");
  const ledger = await readJsonObject(ledgerPath);
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  await writeJsonObject(ledgerPath, {
    schemaVersion: 1,
    appId: typeof ledger.appId === "string" ? ledger.appId : undefined,
    ...ledger,
    events: [...events, event],
  });
}

async function writeProductSpec(appDir: string, spec: AppBuilderProductSpec): Promise<void> {
  const nextSpec = { ...spec, screenFlow: normalizeAppBuilderScreenFlow(spec) };
  await writeJsonObject(path.join(appDir, BUILDER_DIR, "product-spec.json"), nextSpec);
  await writeFile(
    path.join(appDir, "Sources", "AppModels.swift"),
    renderAppBuilderModelsSwift(nextSpec),
    "utf8",
  );
  await writeFile(
    path.join(appDir, "Tests", "GeneratedAppTests.swift"),
    renderAppBuilderTestsSwift(nextSpec),
    "utf8",
  );
}

function defaultAgentWorkboard(params: {
  spec: AppBuilderProductSpec;
  buildEngine: AppStudioBuildEngine;
  now: string;
}): AppStudioAgentWorkItem[] {
  const engine = buildEngineOption(params.buildEngine);
  return [
    {
      id: "product-planner",
      label: "Product Planner",
      role: "Turns your prompt into screens, data, privacy, and acceptance criteria.",
      modelRef: "openai/gpt-5.5",
      status: "done",
      currentTask: `Maintain the blueprint for ${params.spec.appName}.`,
      inputs: ["Latest user prompt", "product-spec.json"],
      outputs: ["Product goal", "Screen list", "Acceptance criteria"],
      blockedOn: [],
      lastEvent: "Initial app blueprint created.",
      updatedAt: params.now,
    },
    {
      id: "app-builder",
      label: "App Builder",
      role: "Mutates app-local SwiftUI code from approved prompts.",
      modelRef: engine.modelRef,
      status: "idle",
      currentTask: `Ready to run ${engine.label} when you click Run AI build pass or Implement app UI.`,
      inputs: ["product-spec.json", "builder-task.md", "app-studio-agent-task.md"],
      outputs: ["SwiftUI source changes", "Evidence ledger entries"],
      blockedOn: [],
      lastEvent: `${engine.label} selected as the build engine.`,
      updatedAt: params.now,
    },
    {
      id: "visual-mapper",
      label: "Visual Mapper",
      role: "Turns optional uploaded screen pictures into screens and tap-flow links.",
      modelRef: "app-studio/visual-brief",
      status: "idle",
      currentTask: "Waiting for optional screen pictures or sketch notes.",
      inputs: ["Uploaded screen pictures", "Sketch notes", "product-spec.json"],
      outputs: ["DesignInputs/screens", "screen-image-brief.json", "screenFlow"],
      blockedOn: [],
      lastEvent: "Visual import is optional and not required for App Store readiness.",
      updatedAt: params.now,
    },
    {
      id: "local-validator",
      label: "Local Validator",
      role: "Runs project-file, XcodeGen, xcodebuild, and screenshot gates.",
      modelRef: "xcodebuild/xcodegen/simctl",
      status: "idle",
      currentTask: "Waiting for a validation gate.",
      inputs: ["Project files", "Simulator target"],
      outputs: ["ios-validation-report.json", "screenshot-report.json"],
      blockedOn: ["Run a validation gate"],
      lastEvent: "Validation lane initialized.",
      updatedAt: params.now,
    },
    {
      id: "app-store-verifier",
      label: "App Store Verifier",
      role: "Checks metadata, privacy, signing references, screenshots, and publish evidence.",
      modelRef: "openai/gpt-5.5",
      status: "idle",
      currentTask: "Waiting for Apple facts and App Store readiness gates.",
      inputs: ["AppStore metadata", "Apple reference IDs", "latest gate reports"],
      outputs: ["app-store-readiness.json", "app-store-publish-plan.json"],
      blockedOn: ["Apple facts", "Validation evidence"],
      lastEvent: "App Store verifier initialized.",
      updatedAt: params.now,
    },
    {
      id: "human-publisher",
      label: "Human Publisher",
      role: "Owns TestFlight upload and App Review submit approvals.",
      modelRef: "human/account-holder",
      status: "blocked",
      currentTask: "Waiting for owner approval before any publish action.",
      inputs: ["Publish plan", "Final readiness report"],
      outputs: ["Approval receipts"],
      blockedOn: ["Upload to TestFlight approval", "Submit to App Review approval"],
      lastEvent: "Publish actions are intentionally gated.",
      updatedAt: params.now,
    },
  ];
}

function normalizeAgentWorkboard(
  value: unknown,
  spec: AppBuilderProductSpec,
  buildEngine: AppStudioBuildEngine,
  now: string,
): AppStudioAgentWorkItem[] {
  const defaults = defaultAgentWorkboard({ spec, buildEngine, now });
  if (!Array.isArray(value)) {
    return defaults;
  }
  const existing = new Map(
    value.filter(isRecord).map((item) => [typeof item.id === "string" ? item.id : "", item]),
  );
  return defaults.map((item) => {
    const current = existing.get(item.id);
    if (!current) {
      return item;
    }
    return {
      id: item.id,
      label: typeof current.label === "string" ? current.label : item.label,
      role: typeof current.role === "string" ? current.role : item.role,
      modelRef: item.id === "app-builder" ? buildEngineOption(buildEngine).modelRef : item.modelRef,
      status:
        current.status === "idle" ||
        current.status === "queued" ||
        current.status === "running" ||
        current.status === "blocked" ||
        current.status === "done"
          ? current.status
          : item.status,
      currentTask: typeof current.currentTask === "string" ? current.currentTask : item.currentTask,
      inputs: stringList(current.inputs).length > 0 ? stringList(current.inputs) : item.inputs,
      outputs: stringList(current.outputs).length > 0 ? stringList(current.outputs) : item.outputs,
      blockedOn: stringList(current.blockedOn),
      lastEvent: typeof current.lastEvent === "string" ? current.lastEvent : item.lastEvent,
      updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : item.updatedAt,
    };
  });
}

function updateAgentWork(
  record: AppStudioProjectRecord,
  agentId: string,
  patch: Partial<Omit<AppStudioAgentWorkItem, "id" | "label" | "role">>,
  now: string,
): AppStudioProjectRecord {
  return {
    ...record,
    agentWorkboard: record.agentWorkboard.map((item) =>
      item.id === agentId
        ? {
            ...item,
            ...patch,
            updatedAt: now,
          }
        : item,
    ),
  };
}

async function writeAppStudioAgentTask(
  appDir: string,
  record: AppStudioProjectRecord,
  spec: AppBuilderProductSpec,
): Promise<void> {
  const engine = buildEngineOption(record.buildEngine);
  const workLines = record.agentWorkboard
    .map(
      (item) =>
        `- ${item.label}: ${item.status.toUpperCase()} — ${item.currentTask} Model/tool: ${item.modelRef}. Blocked on: ${item.blockedOn.join(", ") || "nothing"}.`,
    )
    .join("\n");
  const visualLines =
    record.visualInputs.length > 0
      ? record.visualInputs
          .map((input) => `- ${input.fileName}: ${input.storedPath} (${input.mimeType})`)
          .join("\n")
      : "- No optional screen pictures imported.";
  const task = `# App Studio Agent Task

App: ${spec.appName}
Bundle ID: ${spec.bundleId}
Build engine: ${engine.label}
Model/tool: ${engine.modelRef}
Privacy lane: ${engine.privacy}

## Contract

- Stay inside this app directory.
- Prefer prompt-driven, app-local SwiftUI edits.
- Keep generated code buildable before moving to screenshots or App Store gates.
- Do not upload to TestFlight or submit to App Review without human approval.
- Treat the App Store Connect API profile as a reference only; never write secrets into the app folder.

## Current agent workboard

${workLines}

## Optional visual inputs

${visualLines}

If visual inputs exist, read \`${BUILDER_DIR}/screen-vision-task.md\` before changing screens. Use it to map uploaded sketches or screenshots into product-spec screens, components, and tap-flow links.

## Next builder instruction

Use ${engine.label} for the next constrained implementation pass. If the selected engine is Codex, use Codex for the code mutation/review loop and keep the local Qwen lane as fallback evidence only.
`;
  await writeFile(path.join(appDir, BUILDER_DIR, "app-studio-agent-task.md"), task, "utf8");
}

function defaultProjectRecord(params: {
  appDir: string;
  spec: AppBuilderProductSpec;
  now: string;
}): AppStudioProjectRecord {
  return {
    schemaVersion: 1,
    appId: params.spec.appId,
    appDir: params.appDir,
    createdAt: params.now,
    updatedAt: params.now,
    buildEngine: "local-qwen",
    promptHistory: [
      {
        id: `${params.spec.appId}-initial`,
        prompt: params.spec.originalRequest,
        at: params.now,
        summary: "Initial app creation prompt.",
      },
    ],
    visualInputs: [],
    agentWorkboard: defaultAgentWorkboard({
      spec: params.spec,
      buildEngine: "local-qwen",
      now: params.now,
    }),
    approvals: [
      { id: "testflight-upload", label: "Upload to TestFlight", status: "blocked" },
      { id: "app-review-submit", label: "Submit to App Review", status: "blocked" },
    ],
    appleFacts: {
      appStoreConnectAppId: "",
      sku: "",
      teamId: "",
      apiKeyProfileRef: "",
    },
    xcodeHandoff: {
      recommended: false,
      reason: "Stay in App Studio until local validation fails repeatedly or manual signing/debugging is required.",
    },
  };
}

function normalizeStudioProjectRecord(
  parsed: UnknownRecord,
  appDir: string,
  spec: AppBuilderProductSpec,
): AppStudioProjectRecord {
  const now = spec.createdAt || nowIso();
  const fallback = defaultProjectRecord({ appDir, spec, now });
  const buildEngine = normalizeBuildEngine(parsed.buildEngine);
  const appleFacts = isRecord(parsed.appleFacts) ? parsed.appleFacts : {};
  const xcodeHandoff = isRecord(parsed.xcodeHandoff) ? parsed.xcodeHandoff : {};
  return {
    ...fallback,
    appId: typeof parsed.appId === "string" ? parsed.appId : fallback.appId,
    appDir: typeof parsed.appDir === "string" ? parsed.appDir : appDir,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : fallback.createdAt,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
    buildEngine,
    promptHistory: Array.isArray(parsed.promptHistory)
      ? parsed.promptHistory
          .filter(isRecord)
          .map((entry, index) => ({
            id:
              typeof entry.id === "string"
                ? entry.id
                : `${spec.appId}-prompt-${String(index).padStart(2, "0")}`,
            prompt: typeof entry.prompt === "string" ? entry.prompt : spec.originalRequest,
            at: typeof entry.at === "string" ? entry.at : fallback.createdAt,
            summary: typeof entry.summary === "string" ? entry.summary : "Prompt revision.",
          }))
          .slice(-100)
      : fallback.promptHistory,
    visualInputs: Array.isArray(parsed.visualInputs)
      ? parsed.visualInputs
          .filter(isRecord)
          .map((entry) => ({
            id: typeof entry.id === "string" ? entry.id : "visual-input",
            fileName: typeof entry.fileName === "string" ? entry.fileName : "screen-image",
            mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "application/octet-stream",
            sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0,
            storedPath: typeof entry.storedPath === "string" ? entry.storedPath : "",
            importedAt: typeof entry.importedAt === "string" ? entry.importedAt : fallback.updatedAt,
            notes: typeof entry.notes === "string" ? entry.notes : "",
          }))
          .slice(-50)
      : fallback.visualInputs,
    agentWorkboard: normalizeAgentWorkboard(
      parsed.agentWorkboard,
      spec,
      buildEngine,
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
    ),
    approvals: Array.isArray(parsed.approvals)
      ? parsed.approvals
          .filter(isRecord)
          .map((approval): AppStudioProjectRecord["approvals"][number] => {
            const normalized: AppStudioProjectRecord["approvals"][number] = {
              id: typeof approval.id === "string" ? approval.id : "approval",
              label: typeof approval.label === "string" ? approval.label : "Approval",
              status: approval.status === "approved" ? "approved" : "blocked",
            };
            if (typeof approval.approvedAt === "string") {
              normalized.approvedAt = approval.approvedAt;
            }
            return normalized;
          })
      : fallback.approvals,
    appleFacts: {
      appStoreConnectAppId: scalarString(appleFacts.appStoreConnectAppId),
      sku: scalarString(appleFacts.sku),
      teamId: scalarString(appleFacts.teamId),
      apiKeyProfileRef: scalarString(appleFacts.apiKeyProfileRef),
    },
    xcodeHandoff: {
      recommended:
        typeof xcodeHandoff.recommended === "boolean"
          ? xcodeHandoff.recommended
          : fallback.xcodeHandoff.recommended,
      reason:
        typeof xcodeHandoff.reason === "string"
          ? xcodeHandoff.reason
          : fallback.xcodeHandoff.reason,
    },
  };
}

async function readStudioProject(appDir: string, spec: AppBuilderProductSpec): Promise<AppStudioProjectRecord> {
  const projectPath = path.join(appDir, BUILDER_DIR, STUDIO_PROJECT_FILE);
  const parsed = await readJsonObject(projectPath);
  if (
    parsed.schemaVersion === 1 &&
    typeof parsed.appId === "string" &&
    typeof parsed.appDir === "string" &&
    Array.isArray(parsed.promptHistory)
  ) {
    const record = normalizeStudioProjectRecord(parsed, appDir, spec);
    if (!parsed.buildEngine || !parsed.agentWorkboard) {
      await writeJsonObject(projectPath, record);
    }
    return record;
  }
  const now = spec.createdAt || nowIso();
  const record = defaultProjectRecord({ appDir, spec, now });
  await writeJsonObject(projectPath, record);
  return record;
}

async function writeStudioProject(appDir: string, record: AppStudioProjectRecord): Promise<void> {
  await writeJsonObject(path.join(appDir, BUILDER_DIR, STUDIO_PROJECT_FILE), record);
}

async function discoverAppDirs(cwd: string): Promise<string[]> {
  const roots = [path.join(cwd, "generated-apps"), path.join(cwd, "openclaw-apps")];
  const appDirs: string[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue;
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const appDir = path.join(root, entry.name);
      if (await pathExists(path.join(appDir, BUILDER_DIR, "product-spec.json"))) {
        appDirs.push(appDir);
      }
    }
  }
  return appDirs;
}

async function readReport(appDir: string, fileName: string): Promise<UnknownRecord | null> {
  const report = await readJsonObject(path.join(appDir, BUILDER_DIR, fileName));
  return Object.keys(report).length > 0 ? report : null;
}

function stageFromReports(params: {
  readyToBuild: boolean;
  readyForAppStore: boolean;
  latestReports: AppStudioSelectedProject["latestReports"];
}): AppStudioStageId {
  if (params.readyForAppStore) {
    return "app-store";
  }
  if (params.latestReports.finalVerifier) {
    return "app-store";
  }
  if (params.latestReports.publishPlan) {
    return "testflight";
  }
  if (params.latestReports.screenshot) {
    return "preview";
  }
  if (
    params.readyToBuild ||
    params.latestReports.validation ||
    params.latestReports.repair ||
    params.latestReports.aiBuild ||
    params.latestReports.patch
  ) {
    return "build";
  }
  if (params.latestReports.gaps || params.latestReports.model) {
    return "blueprint";
  }
  return "blueprint";
}

function normalizeActivityEvent(value: unknown): AppStudioActivityEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const at = scalarString(value.at).trim();
  const stage = scalarString(value.stage).trim();
  const result = scalarString(value.result).trim();
  const summary = scalarString(value.summary).trim();
  if (!at || !stage || !summary) {
    return null;
  }
  return {
    at,
    stage,
    result: result || "updated",
    summary,
  };
}

async function readActivityEvents(appDir: string): Promise<AppStudioActivityEvent[]> {
  const ledger = await readJsonObject(path.join(appDir, BUILDER_DIR, "evidence-ledger.json"));
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  return events
    .map(normalizeActivityEvent)
    .filter((event): event is AppStudioActivityEvent => event !== null)
    .slice(-20)
    .toReversed();
}

function fallbackReadiness(spec: AppBuilderProductSpec): {
  completionGrade: number;
  criticality: number;
  nextMostImpactfulGap: string;
  why: string;
  readyToBuild: boolean;
  readyForAppStore: boolean;
} {
  return {
    completionGrade: 4,
    criticality: 10,
    nextMostImpactfulGap: "Run App Studio build gates",
    why: `${spec.appName} has a scaffold, but model, validation, screenshot, and App Store evidence gates have not all run yet.`,
    readyToBuild: false,
    readyForAppStore: false,
  };
}

async function summarizeProject(appDir: string): Promise<AppStudioSelectedProject | null> {
  const spec = await readProductSpec(appDir);
  if (!spec) {
    return null;
  }
  const studio = await readStudioProject(appDir, spec);
  const latestReports = {
    readiness: await readReport(appDir, "app-builder-readiness.json"),
    gaps: await readReport(appDir, "gap-report.json"),
    validation: await readReport(appDir, "ios-validation-report.json"),
    model: await readReport(appDir, "model-readiness-report.json"),
    implementation: await readReport(appDir, "implementation-report.json"),
    repair: await readReport(appDir, "repair-report.json"),
    aiBuild: await readReport(appDir, "ai-build-report.json"),
    patch: await readReport(appDir, "patch-report.json"),
    screenshot: await readReport(appDir, "screenshot-report.json"),
    appStore: await readReport(appDir, "app-store-readiness.json"),
    publishPlan: await readReport(appDir, "app-store-publish-plan.json"),
    finalVerifier: await readReport(appDir, "final-verifier-report.json"),
  };
  const readiness = isRecord(latestReports.readiness)
    ? {
        completionGrade:
          typeof latestReports.readiness.completionGrade === "number"
            ? latestReports.readiness.completionGrade
            : 4,
        criticality:
          typeof latestReports.readiness.criticalityOfNextGap === "number"
            ? latestReports.readiness.criticalityOfNextGap
            : 10,
        nextMostImpactfulGap:
          typeof latestReports.readiness.nextMostImpactfulGap === "string"
            ? latestReports.readiness.nextMostImpactfulGap
            : "Run App Studio build gates",
        why:
          typeof latestReports.readiness.why === "string"
            ? latestReports.readiness.why
            : "Run readiness to calculate the next gap.",
        readyToBuild: latestReports.readiness.readyToBuild === true,
        readyForAppStore: latestReports.readiness.readyForAppStore === true,
      }
    : fallbackReadiness(spec);
  const stage = stageFromReports({
    readyToBuild: readiness.readyToBuild,
    readyForAppStore: readiness.readyForAppStore,
    latestReports,
  });
  const summary: AppStudioProjectSummary = {
    appId: spec.appId,
    appName: spec.appName,
    appDir,
    bundleId: spec.bundleId,
    updatedAt: studio.updatedAt,
    stage,
    completionGrade: readiness.completionGrade,
    criticality: readiness.criticality,
    nextAction: readiness.nextMostImpactfulGap,
    readyToBuild: readiness.readyToBuild,
    readyForAppStore: readiness.readyForAppStore,
  };
  return {
    ...summary,
    spec,
    studio,
    screens: spec.screens,
    screenFlow: normalizeAppBuilderScreenFlow(spec),
    dataModel: spec.dataModel,
    prompts: studio.promptHistory,
    visualInputs: studio.visualInputs,
    activity: await readActivityEvents(appDir),
    appStoreConnect: await readJsonObject(path.join(appDir, "AppStore", "app-store-connect.json")),
    metadata: await readJsonObject(path.join(appDir, "AppStore", "metadata.json")),
    latestReports,
  };
}

export async function buildAppStudioSnapshot(params?: {
  cwd?: string;
  appDir?: string | null;
}): Promise<AppStudioDashboardSnapshot> {
  const cwd = path.resolve(params?.cwd ?? process.cwd());
  const discovered = await discoverAppDirs(cwd);
  const selectedInput = params?.appDir ? path.resolve(params.appDir) : null;
  const allDirs = selectedInput && !discovered.includes(selectedInput) ? [selectedInput, ...discovered] : discovered;
  const selectedProjects = (await Promise.all(allDirs.map((dir) => summarizeProject(dir)))).filter(
    (project): project is AppStudioSelectedProject => project !== null,
  );
  const projects = selectedProjects
    .map((project) => ({
      appId: project.appId,
      appName: project.appName,
      appDir: project.appDir,
      bundleId: project.bundleId,
      updatedAt: project.updatedAt,
      stage: project.stage,
      completionGrade: project.completionGrade,
      criticality: project.criticality,
      nextAction: project.nextAction,
      readyToBuild: project.readyToBuild,
      readyForAppStore: project.readyForAppStore,
    }))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selectedProject = selectedInput
    ? selectedProjects.find((project) => project.appDir === selectedInput) ?? selectedProjects[0] ?? null
    : selectedProjects.find((project) => project.appDir === projects[0]?.appDir) ?? null;

  return {
    schemaVersion: 1,
    checkedAt: nowIso(),
    projects,
    selectedProject,
    defaultPrompt: DEFAULT_APP_PROMPT,
    buildEngineOptions: BUILD_ENGINE_OPTIONS,
    stages: STAGES,
    gates: GATES,
    nextAction:
      selectedProject?.nextAction ??
      "Describe the app in one sentence, then let OpenClaw create the first SwiftUI scaffold.",
  };
}

export async function createAppStudioProject(
  options: CreateAppStudioProjectOptions,
): Promise<AppStudioActionResult> {
  const now = options.now ?? new Date();
  const result = await createIosNativeApp({
    request: options.request,
    appName: options.appName,
    appId: options.appId,
    bundleId: options.bundleId,
    cwd: options.cwd,
    outputDir: options.outputDir,
    force: options.force,
    now,
  });
  const buildEngine = normalizeBuildEngine(options.buildEngine);
  const engine = buildEngineOption(buildEngine);
  let record = defaultProjectRecord({
    appDir: result.appDir,
    spec: result.spec,
    now: now.toISOString(),
  });
  if (buildEngine !== "local-qwen") {
    record = updateAgentWork(
      {
        ...record,
        buildEngine,
        agentWorkboard: normalizeAgentWorkboard(record.agentWorkboard, result.spec, buildEngine, now.toISOString()),
      },
      "app-builder",
      {
        modelRef: engine.modelRef,
        status: "idle",
        currentTask: `Ready to run ${engine.label} for the first app-local SwiftUI implementation pass.`,
        blockedOn: [],
        lastEvent: `${engine.label} selected during app creation.`,
      },
      now.toISOString(),
    );
  }
  await writeStudioProject(result.appDir, record);
  await writeAppStudioAgentTask(result.appDir, record, result.spec);
  await appendEvidence(result.appDir, {
    at: now.toISOString(),
    stage: "app-studio-create",
    result: "created",
    summary: "Created App Studio project dashboard state.",
  });
  return {
    snapshot: await buildAppStudioSnapshot({ cwd: options.cwd, appDir: result.appDir }),
    receipt: {
      title: `${result.spec.appName} is ready for blueprint review.`,
      detail: "OpenClaw created the native SwiftUI scaffold, product spec, build packet, and dashboard state.",
      next: "Run Check AI coder, then Run AI build pass or Implement app UI.",
    },
  };
}

function updateSpecForPrompt(spec: AppBuilderProductSpec, prompt: string): AppBuilderProductSpec {
  const normalized = prompt.toLowerCase();
  const next: AppBuilderProductSpec = JSON.parse(JSON.stringify(spec)) as AppBuilderProductSpec;
  const title = titleFromPrompt(prompt);
  if (/\b(add|include|create|new)\b/.test(normalized)) {
    const id = slugify(title);
    if (!next.screens.some((screen) => screen.id === id)) {
      next.screens = [
        ...next.screens,
        {
          id,
          title,
          purpose: `Requested by prompt: ${relativeSummaryPrompt(prompt)}`,
        },
      ];
    }
  }
  if (/\b(no|without|remove|disable)\b.*\b(analytics|tracking|ads|network|account|login|location|contacts|health)\b/.test(normalized)) {
    next.privacyPosture = {
      ...next.privacyPosture,
      collectsPersonalData: false,
      tracking: false,
      networkAccess: false,
      notes: [
        ...new Set([
          ...next.privacyPosture.notes,
          `Prompt privacy constraint: ${relativeSummaryPrompt(prompt)}`,
        ]),
      ],
    };
  }
  const criterion = `Prompt revision applied: ${relativeSummaryPrompt(prompt)}`;
  if (!next.acceptanceCriteria.includes(criterion)) {
    next.acceptanceCriteria = [...next.acceptanceCriteria, criterion];
  }
  next.unresolvedQuestions = [
    ...new Set([
      ...next.unresolvedQuestions,
      "Review the prompt revision in App Studio and decide whether a deeper AI code mutation pass is required.",
    ]),
  ];
  return { ...next, screenFlow: createDefaultAppBuilderScreenFlow(next.screens) };
}

export async function applyAppStudioPrompt(
  options: ApplyAppStudioPromptOptions,
): Promise<AppStudioActionResult> {
  const appDir = path.resolve(options.appDir);
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const now = nowIso(options.now);
  const nextSpec = updateSpecForPrompt(spec, prompt);
  await writeProductSpec(appDir, nextSpec);
  const studio = await readStudioProject(appDir, nextSpec);
  const entry: AppStudioPromptEntry = {
    id: `${nextSpec.appId}-${Date.parse(now) || Date.now()}`,
    prompt,
    at: now,
    summary: relativeSummaryPrompt(prompt),
  };
  const engine = buildEngineOption(studio.buildEngine);
  let nextStudio: AppStudioProjectRecord = {
    ...studio,
    updatedAt: now,
    promptHistory: [...studio.promptHistory, entry].slice(-100),
  };
  nextStudio = updateAgentWork(
    nextStudio,
    "product-planner",
    {
      status: "done",
      currentTask: `Folded the latest prompt into ${nextSpec.appName}'s blueprint.`,
      outputs: ["product-spec.json", "Sources/AppModels.swift"],
      blockedOn: [],
      lastEvent: `Prompt summarized as: ${entry.summary}`,
    },
    now,
  );
  nextStudio = updateAgentWork(
    nextStudio,
    "app-builder",
    {
      modelRef: engine.modelRef,
      status: "running",
      currentTask: `${engine.label} is applying the app-local implementation pass for: ${entry.summary}`,
      inputs: ["Latest prompt revision", "product-spec.json", "builder-task.md"],
      outputs: ["SwiftUI source changes", "app-studio-agent-task.md"],
      blockedOn: [],
      lastEvent: `Started ${engine.label} implementation pass.`,
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-prompt",
    result: "created",
    summary: `Applied App Studio prompt: ${entry.summary}`,
  });
  await createBuildDryRunTask(appDir);
  const implementation = await applyAppBuilderImplementationPass(appDir, {
    engine: engine.label,
  });
  nextStudio = updateAgentWork(
    nextStudio,
    "app-builder",
    {
      modelRef: engine.modelRef,
      status: implementation.ready ? "done" : "blocked",
      currentTask: implementation.ready
        ? `${engine.label} implementation pass updated the app UI for: ${entry.summary}`
        : `${engine.label} implementation pass is blocked; review implementation-report.json.`,
      outputs: ["Sources/ContentView.swift", "Sources/AppModels.swift", "implementation-report.json"],
      blockedOn: implementation.ready ? [] : implementation.nextActions,
      lastEvent: implementation.ready
        ? "App-local SwiftUI implementation pass completed."
        : "App-local SwiftUI implementation pass was blocked.",
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, nextSpec);
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Prompt applied to the blueprint.",
      detail:
        "App Studio updated the product spec, visible feature list, prompt history, constrained builder task, and app-local SwiftUI implementation evidence.",
      next: "Run Check project files, then Build and test when the simulator toolchain is available.",
    },
  };
}

export async function setAppStudioBuildEngine(
  options: SetAppStudioBuildEngineOptions,
): Promise<AppStudioActionResult> {
  const appDir = path.resolve(options.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const now = nowIso(options.now);
  const buildEngine = normalizeBuildEngine(options.buildEngine);
  const engine = buildEngineOption(buildEngine);
  const studio = await readStudioProject(appDir, spec);
  let nextStudio: AppStudioProjectRecord = {
    ...studio,
    buildEngine,
    updatedAt: now,
    agentWorkboard: normalizeAgentWorkboard(studio.agentWorkboard, spec, buildEngine, now),
  };
  nextStudio = updateAgentWork(
    nextStudio,
    "app-builder",
    {
      modelRef: engine.modelRef,
      status: "idle",
      currentTask: `Ready to run ${engine.label} for the next app-local SwiftUI implementation pass.`,
      inputs: ["Latest prompt", "product-spec.json", "builder-task.md", "app-studio-agent-task.md"],
      outputs: ["SwiftUI source changes", "Evidence ledger entries"],
      blockedOn: [],
      lastEvent: `${engine.label} selected from the dashboard.`,
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, spec);
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-build-engine",
    result: "selected",
    summary: `${engine.label} selected as the dashboard build engine.`,
  });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: `${engine.label} selected.`,
      detail:
        engine.id === "codex"
          ? "App Studio will route the next code-mutation task to Codex while keeping local validation and human publish gates."
          : "App Studio will route the next code-mutation task to the local Qwen Q8 lane.",
      next: "Apply a prompt or run Run AI build pass to connect the selected coder and apply a guarded patch.",
    },
  };
}

export async function reorderAppStudioScreens(params: {
  appDir: string;
  screenIds: string[];
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const requested = new Set(params.screenIds);
  const ordered = params.screenIds
    .map((id) => spec.screens.find((screen) => screen.id === id))
    .filter((screen): screen is AppBuilderProductSpec["screens"][number] => Boolean(screen));
  const rest = spec.screens.filter((screen) => !requested.has(screen.id));
  const screens = [...ordered, ...rest];
  const nextSpec = { ...spec, screens, screenFlow: createDefaultAppBuilderScreenFlow(screens) };
  await writeProductSpec(appDir, nextSpec);
  const studio = await readStudioProject(appDir, nextSpec);
  await writeStudioProject(appDir, { ...studio, updatedAt: nowIso(params.now) });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Screen order saved.",
      detail: "The Swift feature list now follows the dashboard order.",
      next: "Run project file validation or continue editing the blueprint.",
    },
  };
}

function normalizeScreenFlowInput(
  spec: AppBuilderProductSpec,
  input: AppStudioScreenFlowInput,
): NonNullable<AppBuilderProductSpec["screenFlow"]> {
  const screenIds = new Set(spec.screens.map((screen) => screen.id));
  const entryScreenId =
    input.entryScreenId && screenIds.has(input.entryScreenId)
      ? input.entryScreenId
      : spec.screens[0]?.id ?? "home";
  const byId = new Map(spec.screens.map((screen) => [screen.id, screen]));
  const seen = new Set<string>();
  const edges = Array.isArray(input.edges)
    ? input.edges
        .filter(
          (edge) =>
            edge &&
            screenIds.has(edge.fromScreenId) &&
            screenIds.has(edge.toScreenId) &&
            edge.fromScreenId !== edge.toScreenId,
        )
        .map((edge) => {
          const to = byId.get(edge.toScreenId);
          const id = edge.id || `${edge.fromScreenId}-to-${edge.toScreenId}`;
          return {
            id,
            fromScreenId: edge.fromScreenId,
            toScreenId: edge.toScreenId,
            label: edge.label?.trim() || `Open ${to?.title ?? edge.toScreenId}`,
            trigger: edge.trigger?.trim() || `Tap “Open ${to?.title ?? edge.toScreenId}”`,
          };
        })
        .filter((edge) => {
          const key = `${edge.fromScreenId}->${edge.toScreenId}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .slice(0, 24)
    : [];
  return { entryScreenId, edges };
}

export async function updateAppStudioScreenFlow(params: {
  appDir: string;
  screenFlow: AppStudioScreenFlowInput;
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const nextFlow = normalizeScreenFlowInput(spec, params.screenFlow);
  const nextSpec = { ...spec, screenFlow: nextFlow };
  await writeProductSpec(appDir, nextSpec);
  const studio = await readStudioProject(appDir, nextSpec);
  const now = nowIso(params.now);
  const nextStudio = updateAgentWork(
    { ...studio, updatedAt: now },
    "visual-mapper",
    {
      status: "done",
      currentTask: `Updated ${nextFlow.edges.length} screen connection(s) in the flow map.`,
      outputs: ["product-spec.json", "Sources/AppModels.swift", "screenFlow"],
      blockedOn: [],
      lastEvent: "Screen connection map edited in App Studio.",
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, nextSpec);
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-screen-flow",
    result: "updated",
    summary: `Updated ${nextFlow.edges.length} App Studio screen connection(s).`,
  });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Screen flow saved.",
      detail: "App Studio updated the visible connection map and regenerated the Swift screen-flow model.",
      next: "Run Implement app UI so ContentView uses the latest links, then validate the project.",
    },
  };
}

function safeDesignFileName(fileName: string, index: number): string {
  const clean = fileName
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || `screen-${index + 1}.png`;
}

function screenTitleFromVisualName(value: string): string {
  const withoutExtension = value.replace(/\.[^.]+$/, "");
  const words = withoutExtension
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(screen|screens|mockup|wireframe|iphone|ios|app|view|page)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const title = words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
  return title || "Imported Screen";
}

function imagePayloadBase64(image: AppStudioScreenImageUpload): string {
  if (typeof image.dataBase64 === "string" && image.dataBase64.trim()) {
    return image.dataBase64.trim();
  }
  if (typeof image.dataUrl === "string") {
    const match = image.dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function uniqueVisualScreenTitles(
  images: AppStudioScreenImageUpload[],
  notes: string,
  existing: AppBuilderProductSpec["screens"],
): string[] {
  const existingTitles = new Set(existing.map((screen) => screen.title.toLowerCase()));
  const titles = new Map<string, string>();
  for (const image of images) {
    const title = screenTitleFromVisualName(image.fileName);
    if (!existingTitles.has(title.toLowerCase())) {
      titles.set(title.toLowerCase(), title);
    }
  }
  for (const line of notes.split(/\r?\n/)) {
    const arrowParts = line.split(/\s*(?:->|→)\s*/);
    for (const part of arrowParts) {
      const title = screenTitleFromVisualName(part);
      if (title !== "Imported Screen" && !existingTitles.has(title.toLowerCase())) {
        titles.set(title.toLowerCase(), title);
      }
    }
  }
  return [...titles.values()].slice(0, 8);
}

function flowEdgesFromNotes(
  notes: string,
  screens: AppBuilderProductSpec["screens"],
): AppBuilderScreenFlow["edges"] {
  const byTitle = new Map(screens.map((screen) => [screen.title.toLowerCase(), screen]));
  const edges: AppBuilderScreenFlow["edges"] = [];
  for (const line of notes.split(/\r?\n/)) {
    const [fromRaw, toRaw] = line.split(/\s*(?:->|→)\s*/);
    if (!fromRaw || !toRaw) {
      continue;
    }
    const from = byTitle.get(screenTitleFromVisualName(fromRaw).toLowerCase());
    const to = byTitle.get(screenTitleFromVisualName(toRaw).toLowerCase());
    if (!from || !to || from.id === to.id) {
      continue;
    }
    edges.push({
      id: `${from.id}-to-${to.id}`,
      fromScreenId: from.id,
      toScreenId: to.id,
      label: `Open ${to.title}`,
      trigger: `Tap “Open ${to.title}”`,
    });
  }
  return edges;
}

function renderScreenVisionTask(params: {
  spec: AppBuilderProductSpec;
  record: AppStudioProjectRecord;
  stored: AppStudioVisualReference[];
  notes: string;
  now: string;
}): string {
  const engine = buildEngineOption(params.record.buildEngine);
  const imageLines =
    params.stored.length > 0
      ? params.stored
          .map(
            (input, index) =>
              `${index + 1}. ${input.fileName}\n   - id: ${input.id}\n   - path: ${input.storedPath}\n   - type: ${input.mimeType}\n   - size: ${input.sizeBytes} bytes`,
          )
          .join("\n")
      : "No image bytes were stored; use the notes only.";
  const screenLines = params.spec.screens
    .map((screen) => `- ${screen.title} (${screen.id}): ${screen.purpose}`)
    .join("\n");
  const flowLines =
    params.spec.screenFlow?.edges.length
      ? params.spec.screenFlow.edges
          .map((edge) => `- ${edge.fromScreenId} -> ${edge.toScreenId}: ${edge.trigger}`)
          .join("\n")
      : "- No current links.";
  return `# App Studio Screen Vision Task

Generated: ${params.now}
App: ${params.spec.appName}
Bundle ID: ${params.spec.bundleId}
Selected build engine: ${engine.label} (${engine.modelRef})

## Purpose

Use the optional uploaded screen pictures to improve the app blueprint. This task is intentionally app-local and non-publishing. Do not install dependencies, read secrets, contact App Store Connect, upload, publish, or submit.

## Uploaded screen pictures

${imageLines}

## Operator notes

${params.notes || "No notes supplied."}

## Current screens

${screenLines}

## Current screen links

${flowLines}

## Required output shape

Return JSON only:

\`\`\`json
{
  "screens": [
    {
      "title": "Home",
      "purpose": "What the user can do on this screen",
      "visibleText": ["Primary visible labels or headings"],
      "sourceImageIds": ["image id from this task"]
    }
  ],
  "connections": [
    {
      "fromTitle": "Home",
      "toTitle": "Settings",
      "label": "Open Settings",
      "trigger": "Tap the Settings button"
    }
  ],
  "questions": ["Anything ambiguous that needs a human answer"]
}
\`\`\`

## Mapping rules

- Prefer explicit operator notes over visual inference when they conflict.
- Keep screen titles short and human-readable.
- Create one connection for every visible button, tab, or card that moves to another screen.
- If one picture contains multiple phone screens, split them into separate screen objects.
- If a link is uncertain, include it as a question instead of guessing.
`;
}

type NormalizedScreenAnalysis = {
  screens: Array<{
    title: string;
    purpose: string;
    visibleText: string[];
    sourceImageIds: string[];
  }>;
  connections: Array<{
    fromTitle: string;
    toTitle: string;
    label: string;
    trigger: string;
  }>;
  questions: string[];
};

function parseAnalysisJson(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = fenced?.[1] ?? trimmed;
  return JSON.parse(raw) as unknown;
}

function screenTitleFromAnalysis(value: unknown, fallback: string): string {
  const title = screenTitleFromVisualName(scalarString(value));
  return title === "Imported Screen" ? fallback : title;
}

function normalizeScreenAnalysis(value: unknown): NormalizedScreenAnalysis {
  const parsed = typeof value === "string" ? parseAnalysisJson(value) : value;
  if (!isRecord(parsed)) {
    throw new Error("Screen analysis must be a JSON object.");
  }
  const screens = (Array.isArray(parsed.screens) ? parsed.screens.filter(isRecord) : [])
    .map((screen, index) => {
      const title = screenTitleFromAnalysis(screen.title ?? screen.name, `Imported Screen ${index + 1}`);
      const visibleText = stringList(screen.visibleText).slice(0, 12);
      const sourceImageIds = stringList(screen.sourceImageIds).slice(0, 12);
      const purpose =
        scalarString(screen.purpose).trim() ||
        scalarString(screen.description).trim() ||
        (visibleText.length > 0
          ? `Imported from visual analysis. Visible text: ${visibleText.join(", ")}.`
          : "Imported from visual screen analysis.");
      return {
        title,
        purpose,
        visibleText,
        sourceImageIds,
      };
    })
    .filter((screen) => screen.title.length > 0)
    .slice(0, 24);
  const connections = (
    Array.isArray(parsed.connections) ? parsed.connections.filter(isRecord) : []
  )
    .map((connection) => {
      const fromTitle = screenTitleFromAnalysis(connection.fromTitle ?? connection.from, "");
      const toTitle = screenTitleFromAnalysis(connection.toTitle ?? connection.to, "");
      const label = scalarString(connection.label).trim() || `Open ${toTitle || "screen"}`;
      const trigger = scalarString(connection.trigger).trim() || `Tap “${label}”`;
      return { fromTitle, toTitle, label, trigger };
    })
    .filter((connection) => connection.fromTitle && connection.toTitle)
    .slice(0, 48);
  const questions = stringList(parsed.questions).slice(0, 24);
  if (screens.length === 0 && connections.length === 0 && questions.length === 0) {
    throw new Error("Screen analysis must include screens, connections, or questions.");
  }
  return { screens, connections, questions };
}

function uniqueScreenId(title: string, usedIds: Set<string>): string {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export async function applyAppStudioScreenAnalysis(params: {
  appDir: string;
  analysis: AppStudioScreenAnalysisInput | string;
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const now = nowIso(params.now);
  const analysis = normalizeScreenAnalysis(params.analysis);
  const screens = [...spec.screens];
  const usedIds = new Set(screens.map((screen) => screen.id));
  const byTitle = new Map(screens.map((screen) => [screen.title.toLowerCase(), screen]));
  const addedScreens: AppBuilderProductSpec["screens"] = [];
  for (const screen of analysis.screens) {
    const key = screen.title.toLowerCase();
    const existing = byTitle.get(key);
    if (existing) {
      existing.purpose = screen.purpose;
      continue;
    }
    const nextScreen = {
      id: uniqueScreenId(screen.title, usedIds),
      title: screen.title,
      purpose: screen.purpose,
    };
    screens.push(nextScreen);
    addedScreens.push(nextScreen);
    byTitle.set(key, nextScreen);
  }
  const edges: AppBuilderScreenFlowEdge[] = [];
  const seenEdges = new Set<string>();
  for (const connection of analysis.connections) {
    const from = byTitle.get(connection.fromTitle.toLowerCase());
    const to = byTitle.get(connection.toTitle.toLowerCase());
    if (!from || !to || from.id === to.id) {
      continue;
    }
    const key = `${from.id}->${to.id}`;
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    edges.push({
      id: `${from.id}-to-${to.id}`,
      fromScreenId: from.id,
      toScreenId: to.id,
      label: connection.label,
      trigger: connection.trigger,
    });
  }
  const currentFlow = normalizeAppBuilderScreenFlow(spec);
  const nextSpec: AppBuilderProductSpec = {
    ...spec,
    screens,
    screenFlow: {
      entryScreenId: currentFlow.entryScreenId || screens[0]?.id || "home",
      edges: edges.length > 0 ? edges : currentFlow.edges,
    },
    acceptanceCriteria: [
      ...new Set([
        ...spec.acceptanceCriteria,
        "Applied screen-picture analysis is reflected in the blueprint and screen connection map.",
      ]),
    ],
    unresolvedQuestions: [
      ...new Set([
        ...spec.unresolvedQuestions,
        ...analysis.questions.map((question) => `Visual analysis question: ${question}`),
      ]),
    ],
  };
  await writeProductSpec(appDir, nextSpec);
  const studio = await readStudioProject(appDir, nextSpec);
  const nextStudio = updateAgentWork(
    { ...studio, updatedAt: now },
    "visual-mapper",
    {
      status: "done",
      currentTask: `Applied visual analysis with ${analysis.screens.length} screen(s), ${edges.length} link(s), and ${analysis.questions.length} question(s).`,
      outputs: [
        "product-spec.json",
        "Sources/AppModels.swift",
        "Tests/GeneratedAppTests.swift",
        "screen-analysis-applied.json",
      ],
      blockedOn: analysis.questions,
      lastEvent: "Screen analysis JSON applied to the App Studio blueprint.",
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, nextSpec);
  await writeJsonObject(path.join(appDir, BUILDER_DIR, "screen-analysis-applied.json"), {
    schemaVersion: 1,
    appId: spec.appId,
    appliedAt: now,
    addedScreens,
    updatedScreenCount: screens.length,
    appliedConnections: edges,
    questions: analysis.questions,
    nextActions: [
      "Review the Screen connection map.",
      "Run Implement app UI so ContentView uses the latest analysis-driven screens and links.",
      "Run Check project files and Build and test.",
    ],
  });
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-screen-analysis",
    result: "updated",
    summary: `Applied screen analysis with ${analysis.screens.length} screen(s) and ${edges.length} connection(s).`,
  });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Picture analysis applied.",
      detail: "App Studio merged the analyzed screens, questions, and tap links into the blueprint.",
      next: "Review the screen connection map, then run Implement app UI and Build and test.",
    },
  };
}

export async function importAppStudioScreenImages(params: {
  appDir: string;
  images: AppStudioScreenImageUpload[];
  notes?: string;
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const notes = params.notes?.trim() ?? "";
  if (params.images.length === 0 && !notes) {
    throw new Error("Upload at least one screen image or add sketch notes.");
  }
  const now = nowIso(params.now);
  const inputDir = path.join(appDir, "DesignInputs", "screens");
  await mkdir(inputDir, { recursive: true });
  const stored: AppStudioVisualReference[] = [];
  for (const [index, image] of params.images.entries()) {
    const base64 = imagePayloadBase64(image);
    if (!base64) {
      continue;
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength > 4_000_000) {
      throw new Error(`Screen image is too large: ${image.fileName}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const fileName = `${String(index + 1).padStart(2, "0")}-${digest}-${safeDesignFileName(image.fileName, index)}`;
    const storedPath = path.join("DesignInputs", "screens", fileName);
    await writeFile(path.join(appDir, storedPath), bytes);
    stored.push({
      id: digest,
      fileName: image.fileName,
      mimeType: image.mimeType || "application/octet-stream",
      sizeBytes: image.sizeBytes ?? bytes.byteLength,
      storedPath,
      importedAt: now,
      notes,
    });
  }
  const visualTitles = uniqueVisualScreenTitles(params.images, notes, spec.screens);
  const visualScreens = visualTitles.map((title) => ({
    id: slugify(title),
    title,
    purpose: `Imported from optional screen picture or sketch note: ${relativeSummaryPrompt(notes || title)}`,
  }));
  const existingIds = new Set(spec.screens.map((screen) => screen.id));
  const screens = [
    ...spec.screens,
    ...visualScreens.filter((screen) => !existingIds.has(screen.id)),
  ];
  const notedEdges = flowEdgesFromNotes(notes, screens);
  const defaultFlow = createDefaultAppBuilderScreenFlow(screens);
  const nextSpec: AppBuilderProductSpec = {
    ...spec,
    screens,
    screenFlow: {
      entryScreenId: defaultFlow.entryScreenId,
      edges: notedEdges.length > 0 ? notedEdges : defaultFlow.edges,
    },
    acceptanceCriteria: [
      ...new Set([
        ...spec.acceptanceCriteria,
        "Optional uploaded screen pictures are reflected in the blueprint and screen connection map.",
      ]),
    ],
    unresolvedQuestions: [
      ...new Set([
        ...spec.unresolvedQuestions,
        "Review imported visual screens and connection map before running the next implementation pass.",
      ]),
    ],
  };
  await writeProductSpec(appDir, nextSpec);
  const studio = await readStudioProject(appDir, nextSpec);
  const nextStudio = updateAgentWork(
    {
      ...studio,
      updatedAt: now,
      visualInputs: [...studio.visualInputs, ...stored].slice(-50),
    },
    "visual-mapper",
    {
      status: "done",
      currentTask: `Mapped ${stored.length} optional screen picture(s) into the blueprint and flow map.`,
      outputs: [
        "DesignInputs/screens",
        "screen-image-brief.json",
        "screen-vision-task.md",
        "product-spec.json",
      ],
      blockedOn: [],
      lastEvent:
        notedEdges.length > 0
          ? "Imported explicit screen links from sketch notes."
          : "Imported screen pictures and generated a default tap flow.",
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, nextSpec);
  await writeFile(
    path.join(appDir, BUILDER_DIR, "screen-vision-task.md"),
    renderScreenVisionTask({ spec: nextSpec, record: nextStudio, stored, notes, now }),
    "utf8",
  );
  await writeJsonObject(path.join(appDir, BUILDER_DIR, "screen-image-brief.json"), {
    schemaVersion: 1,
    appId: spec.appId,
    importedAt: now,
    notes,
    images: stored,
    inferredScreens: visualScreens,
    screenFlow: nextSpec.screenFlow,
    nextActions: [
      "If pixel-level interpretation is needed, hand .openclaw-app-builder/screen-vision-task.md plus the uploaded images to the selected Visual Mapper model.",
      "Review the App Studio screen connection map.",
      "Drag screens into the preferred order if the flow is not right.",
      "Run Implement app UI so the SwiftUI screen flow is regenerated.",
    ],
  });
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-screen-images",
    result: "created",
    summary: `Imported ${stored.length} optional screen picture(s) into App Studio.`,
  });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Screen pictures imported.",
      detail: "App Studio stored the optional screen images, added inferred screens, and refreshed the connection map.",
      next: "Review the flow map, drag screens into order, then run Implement app UI.",
    },
  };
}

export async function importAppStudioAppleFacts(params: {
  appDir: string;
  facts: AppStoreFactPatch;
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const connectPath = path.join(appDir, "AppStore", "app-store-connect.json");
  const metadataPath = path.join(appDir, "AppStore", "metadata.json");
  const connect = await readJsonObject(connectPath);
  const metadata = await readJsonObject(metadataPath);
  const facts = params.facts;
  const nextConnect = {
    ...connect,
    appStoreConnectAppId: facts.appStoreConnectAppId ?? connect.appStoreConnectAppId ?? "",
    sku: facts.sku ?? connect.sku ?? "",
    teamId: facts.teamId ?? connect.teamId ?? "",
    signingIdentity: facts.signingIdentity ?? connect.signingIdentity ?? "",
    provisioningProfile: facts.provisioningProfile ?? connect.provisioningProfile ?? "",
    apiKeyProfileRef: facts.apiKeyProfileRef ?? connect.apiKeyProfileRef ?? "",
  };
  const reviewContact = isRecord(metadata.reviewContact) ? metadata.reviewContact : {};
  const nextReviewContact = {
    ...reviewContact,
    ...(facts.reviewContactName ? { name: facts.reviewContactName } : {}),
    ...(facts.reviewContactEmail ? { email: facts.reviewContactEmail } : {}),
    ...(facts.reviewContactPhone ? { phone: facts.reviewContactPhone } : {}),
  };
  const nextMetadata = {
    ...metadata,
    supportUrl: facts.supportUrl ?? metadata.supportUrl ?? "",
    privacyUrl: facts.privacyUrl ?? metadata.privacyUrl ?? "",
    reviewContact: nextReviewContact,
  };
  await writeJsonObject(connectPath, nextConnect);
  await writeJsonObject(metadataPath, nextMetadata);
  const studio = await readStudioProject(appDir, spec);
  const now = nowIso(params.now);
  const nextStudio = updateAgentWork(
    {
      ...studio,
      updatedAt: now,
      appleFacts: {
        appStoreConnectAppId: scalarString(nextConnect.appStoreConnectAppId),
        sku: scalarString(nextConnect.sku),
        teamId: scalarString(nextConnect.teamId),
        apiKeyProfileRef: scalarString(nextConnect.apiKeyProfileRef),
      },
    },
    "app-store-verifier",
    {
      status: "idle",
      currentTask: "Check App Store metadata, privacy URL, support URL, signing references, and review contacts.",
      inputs: ["AppStore/app-store-connect.json", "AppStore/metadata.json"],
      outputs: ["app-store-readiness.json"],
      blockedOn: [],
      lastEvent: "Apple/App Store reference facts saved.",
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, spec);
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-apple-facts",
    result: "created",
    summary: "Imported Apple/App Store evidence references without storing credential material.",
  });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Apple facts saved.",
      detail: "App Studio updated App Store Connect, signing, support, privacy, and review-contact references.",
      next: "Run Check App Store evidence.",
    },
  };
}

export async function approveAppStudioGate(params: {
  appDir: string;
  approvalId: string;
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const studio = await readStudioProject(appDir, spec);
  const now = nowIso(params.now);
  const nextApprovals = studio.approvals.map((approval) =>
    approval.id === params.approvalId
      ? { ...approval, status: "approved" as const, approvedAt: now }
      : approval,
  );
  const nextStudio = updateAgentWork(
    { ...studio, updatedAt: now, approvals: nextApprovals },
    "human-publisher",
    {
      status: nextApprovals.every((approval) => approval.status === "approved") ? "done" : "blocked",
      currentTask: "Track remaining human-only publish approvals.",
      outputs: ["Approval receipt"],
      blockedOn: nextApprovals
        .filter((approval) => approval.status !== "approved")
        .map((approval) => approval.label),
      lastEvent: `Human approval recorded for ${params.approvalId}.`,
    },
    now,
  );
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, spec);
  await appendEvidence(appDir, {
    at: now,
    stage: "app-studio-approval",
    result: "passed",
    summary: `Human approval recorded for ${params.approvalId}.`,
  });
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: "Approval recorded.",
      detail: `App Studio recorded human approval for ${params.approvalId}.`,
      next: "Continue only if the publish plan and final verifier are green.",
    },
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function collectCompletionText(response: unknown): string {
  if (typeof response === "string") {
    return response.trim();
  }
  if (!isRecord(response)) {
    return "";
  }
  const content = response.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
      )
      .join("")
      .trim();
  }
  const message = response.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content.trim();
  }
  return "";
}

function firstBalancedJsonObjectText(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function normalizeEscapedWhitespaceOutsideJsonStrings(text: string): string {
  let normalized = "";
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      normalized += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      normalized += char;
      continue;
    }
    if (char === "\\" && ["n", "r", "t"].includes(text[index + 1] ?? "")) {
      normalized += text[index + 1] === "t" ? "\t" : "\n";
      index += 1;
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function parseJsonObjectFromModelText(text: string): UnknownRecord {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const rawCandidates = [
    fenced?.[1],
    trimmed,
    firstBalancedJsonObjectText(trimmed),
    trimmed.includes("{") && trimmed.includes("}")
      ? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
      : undefined,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  const candidates = rawCandidates.flatMap((candidate) => {
    const normalized = normalizeEscapedWhitespaceOutsideJsonStrings(candidate);
    return normalized === candidate ? [candidate] : [candidate, normalized];
  });
  for (const candidate of candidates) {
    let current = candidate.trim();
    for (let depth = 0; depth < 3; depth += 1) {
      try {
        const parsed = JSON.parse(current) as unknown;
        if (isRecord(parsed)) {
          return parsed;
        }
        if (typeof parsed === "string" && parsed.trim() && parsed.trim() !== current) {
          current = parsed.trim();
          continue;
        }
        break;
      } catch {
        // Try the next candidate; models sometimes wrap JSON in prose.
        break;
      }
    }
  }
  throw new Error("The selected AI did not return a JSON object patch plan.");
}

function normalizeAiPatchChange(value: unknown): AppBuilderPatchChange | null {
  if (!isRecord(value)) {
    return null;
  }
  const pathValue = scalarString(value.path).trim();
  const contents = typeof value.contents === "string" ? value.contents : undefined;
  if (!pathValue || contents === undefined) {
    return null;
  }
  const change: AppBuilderPatchChange = {
    path: pathValue,
    action: "write",
    contents,
  };
  const oldContentSha256 = scalarString(value.oldContentSha256).trim();
  if (oldContentSha256) {
    change.oldContentSha256 = oldContentSha256;
  }
  return change;
}

function normalizeAiPatchPlan(params: {
  parsed: UnknownRecord;
  engine: AppStudioBuildEngineOption;
  objective: string;
}): AppBuilderPatchPlan {
  const changes = Array.isArray(params.parsed.changes)
    ? params.parsed.changes
        .map(normalizeAiPatchChange)
        .filter((change): change is AppBuilderPatchChange => change !== null)
        .slice(0, 12)
    : [];
  if (changes.length === 0) {
    throw new Error("The selected AI patch plan did not include any writable app-local changes.");
  }
  const validation = isRecord(params.parsed.validation) ? params.parsed.validation : {};
  return {
    schemaVersion: 1,
    engine: params.engine.label,
    objective: scalarString(params.parsed.objective).trim() || params.objective,
    changes,
    validation: {
      checkToolchain: false,
      ...(validation.runXcodegen === true ? { runXcodegen: true } : {}),
      ...(validation.runXcodebuild === true ? { runXcodebuild: true } : {}),
      ...(typeof validation.simulator === "string" && validation.simulator.trim()
        ? { simulator: validation.simulator.trim() }
        : {}),
    },
  };
}

function modelNameFromOllamaRef(modelRef: string): string {
  return modelRef.startsWith("ollama/") ? modelRef.slice("ollama/".length) : modelRef;
}

async function collectOllamaStreamText(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error("Ollama returned an empty app-builder stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let sawFinalChunk = false;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return;
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      throw new Error(`Ollama stream error: ${parsed.error.trim()}`);
    }
    const message = parsed.message;
    if (isRecord(message) && typeof message.content === "string") {
      accumulated += message.content;
    }
    if (typeof parsed.response === "string") {
      accumulated += parsed.response;
    }
    if (parsed.done === true) {
      sawFinalChunk = true;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      consumeLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeLine(buffer);
  }

  if (!sawFinalChunk) {
    throw new Error("Ollama stream ended before the app-builder patch plan completed.");
  }
  return accumulated.trim();
}

async function completeWithLocalQwen(params: {
  request: AppStudioAiCompletionRequest;
  baseUrl: string;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.request.timeoutMs);
  try {
    const response = await fetch(`${params.baseUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelNameFromOllamaRef(params.request.modelRef),
        stream: true,
        format: "json",
        think: false,
        keep_alive: "10m",
        options: APP_STUDIO_QWEN_OPTIONS,
        messages: [
          { role: "system", content: params.request.systemPrompt },
          { role: "user", content: params.request.prompt },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }
    const text = await collectOllamaStreamText(response);
    if (!text) {
      throw new Error("Ollama returned no text for the app-builder patch plan.");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function completeWithCodex(params: {
  request: AppStudioAiCompletionRequest;
  cfg: OpenClawConfig | undefined;
}): Promise<string> {
  if (!params.cfg) {
    throw new Error("Codex AI build requires Gateway runtime config.");
  }
  const prepared = await prepareSimpleCompletionModel({
    cfg: params.cfg,
    provider: "openai-codex",
    modelId: "gpt-5.5",
    allowBundledStaticCatalogFallback: true,
    skipPiDiscovery: true,
  });
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }
  const result = await completeWithPreparedSimpleCompletionModel({
    model: prepared.model,
    auth: prepared.auth,
    cfg: params.cfg,
    context: {
      systemPrompt: params.request.systemPrompt,
      messages: [
        {
          role: "user",
          content: params.request.prompt,
          timestamp: Date.now(),
        },
      ],
    },
    options: {
      maxTokens: 8_192,
      temperature: 0.1,
      reasoning: "high",
    },
  });
  const text = collectCompletionText(result);
  if (!text) {
    throw new Error("Codex returned no text for the app-builder patch plan.");
  }
  return text;
}

async function completeAppStudioAiText(
  runtime: AppStudioAiRuntime | undefined,
  request: AppStudioAiCompletionRequest,
): Promise<string> {
  if (runtime?.completeText) {
    return await runtime.completeText(request);
  }
  if (request.engine === "local-qwen") {
    return await completeWithLocalQwen({
      request,
      baseUrl: runtime?.ollamaBaseUrl ?? APP_STUDIO_OLLAMA_BASE_URL,
    });
  }
  return await completeWithCodex({ request, cfg: runtime?.cfg });
}

async function buildAiPatchPrompt(params: {
  appDir: string;
  spec: AppBuilderProductSpec;
  studio: AppStudioProjectRecord;
  engine: AppStudioBuildEngineOption;
}): Promise<{ systemPrompt: string; prompt: string; objective: string }> {
  const files = await Promise.all(
    ["Sources/AppModels.swift", "Sources/ContentView.swift", "Tests/GeneratedAppTests.swift", "README.md"].map(
      async (relativePath) => {
        const contents = await readTextIfExists(path.join(params.appDir, relativePath));
        return {
          relativePath,
          contents,
          sha256: sha256Text(contents),
        };
      },
    ),
  );
  const latestPrompt =
    params.studio.promptHistory.at(-1)?.prompt.trim() || params.spec.originalRequest;
  const objective = `Make ${params.spec.appName} visibly match this request: ${latestPrompt}`;
  const screenTitles = params.spec.screens.map((screen) => screen.title).join(", ");
  const systemPrompt = `You are OpenClaw App Studio's approved app-local SwiftUI builder.
Return only one JSON object. No markdown. No prose.
You may only write app-local files allowed by the patch executor: Sources/*, Tests/*, README.md, Privacy/*, AppStore/metadata.json, or AppStore/review-notes.md.
Do not install dependencies. Do not read or write secrets. Do not contact App Store Connect. Do not upload, publish, or submit.
Prefer SwiftUI and Foundation only. Keep code compile-safe for iOS 18+ and Swift 6.
The app must feel specific to the user's requested app, not like a generic scaffold.
Do not remove baseline validation hooks. A ready patch must preserve every exact product-spec screen title and local CRUD/persistence symbol listed in the user prompt.
Required JSON shape:
{"schemaVersion":1,"objective":"short objective","changes":[{"path":"Sources/ContentView.swift","action":"write","oldContentSha256":"optional current file hash","contents":"complete file contents"}],"validation":{"checkToolchain":false}}`;
  const fileBlocks = files
    .map(
      (file) => `### ${file.relativePath}
sha256: ${file.sha256}
\`\`\`
${file.contents}
\`\`\``,
    )
    .join("\n\n");
  const prompt = `Selected build engine: ${params.engine.label} (${params.engine.modelRef})

Objective: ${objective}

Product spec JSON:
\`\`\`json
${JSON.stringify(params.spec, null, 2)}
\`\`\`

Current app-local files:

${fileBlocks}

Mandatory ready-state checks your patch must satisfy:
- Sources/ContentView.swift must contain these exact screen titles: ${screenTitles}.
- Sources/ContentView.swift must contain ProductSpecSummary.originalRequest.
- Keep Dashboard, Records, Insights, and Settings as the product-spec surfaces; make their contents birdwatching-specific rather than renaming the surfaces away.
- Preserve these exact local CRUD hooks unless you are extending them: @State private var records, addRecord, toggleRecord, deleteRecords.
- Preserve these exact local persistence hooks unless you are extending them: LocalDraftRecord.load(for: AppFeature.defaults), LocalDraftRecord.save(newRecords).
- Sources/AppModels.swift must preserve struct LocalDraftRecord, recordsStorageKey, load(for features), save(_ records), Codable, and AppFeature.defaults.

Create a small, safe patch plan now. Prefer one coherent rewrite of Sources/ContentView.swift only. Avoid rewriting Sources/AppModels.swift unless absolutely necessary, and if you do, preserve the mandatory hooks exactly. Keep the app local-only and privacy-safe.`;
  return { systemPrompt, prompt, objective };
}

type AppStudioAiBuildReport = {
  schemaVersion: 1;
  appId: string;
  appDir: string;
  generatedAt: string;
  engine: string;
  modelRef: string;
  ready: boolean;
  connectedToAi: boolean;
  objective: string;
  changedFiles: string[];
  rejectedChanges: AppBuilderPatchReportLike["rejectedChanges"];
  rawOutputSha256: string | null;
  error: string | null;
  nextActions: string[];
};

type AppBuilderPatchReportLike = Awaited<ReturnType<typeof applyAppBuilderPatchPlan>>;

async function writeAppBuilderProgress(params: {
  appDir: string;
  spec: AppBuilderProductSpec;
  modelRef: string;
  currentTask: string;
  lastEvent: string;
  inputs?: string[];
  outputs?: string[];
  blockedOn?: string[];
}): Promise<void> {
  const updatedAt = nowIso();
  const studio = await readStudioProject(params.appDir, params.spec);
  const nextStudio = updateAgentWork(
    { ...studio, updatedAt },
    "app-builder",
    {
      modelRef: params.modelRef,
      status: "running",
      currentTask: params.currentTask,
      ...(params.inputs ? { inputs: params.inputs } : {}),
      ...(params.outputs ? { outputs: params.outputs } : {}),
      blockedOn: params.blockedOn ?? [],
      lastEvent: params.lastEvent,
    },
    updatedAt,
  );
  await writeStudioProject(params.appDir, nextStudio);
}

async function runAppStudioAiBuildPass(params: {
  appDir: string;
  spec: AppBuilderProductSpec;
  studio: AppStudioProjectRecord;
  ai?: AppStudioAiRuntime;
  now?: Date;
}): Promise<AppStudioAiBuildReport> {
  const generatedAt = nowIso(params.now);
  const engine = buildEngineOption(params.studio.buildEngine);
  const reportPath = path.join(params.appDir, BUILDER_DIR, "ai-build-report.json");
  const rawOutputPath = path.join(params.appDir, BUILDER_DIR, AI_BUILD_RAW_OUTPUT_FILE);
  await writeAppBuilderProgress({
    appDir: params.appDir,
    spec: params.spec,
    modelRef: engine.modelRef,
    currentTask: "Preparing the app-builder task packet and safe write scope.",
    lastEvent: "AI build pass started.",
    inputs: ["product-spec.json", "build-packet.json"],
    outputs: ["builder-task.md", "app-studio-agent-task.md"],
  });
  await createBuildDryRunTask(params.appDir);
  await writeAppBuilderProgress({
    appDir: params.appDir,
    spec: params.spec,
    modelRef: engine.modelRef,
    currentTask: "Applying the deterministic SwiftUI baseline before AI customization.",
    lastEvent: "Baseline implementation pass started.",
    inputs: ["product-spec.json", "current Swift files"],
    outputs: ["implementation-report.json"],
  });
  await applyAppBuilderImplementationPass(params.appDir, { engine: `${engine.label} baseline` });
  const prompt = await buildAiPatchPrompt({
    appDir: params.appDir,
    spec: params.spec,
    studio: params.studio,
    engine,
  });
  const request: AppStudioAiCompletionRequest = {
    engine: params.studio.buildEngine,
    label: engine.label,
    modelRef: params.studio.buildEngine === "codex" ? APP_STUDIO_CODEX_MODEL_REF : engine.modelRef,
    systemPrompt: prompt.systemPrompt,
    prompt: prompt.prompt,
    timeoutMs: APP_STUDIO_AI_BUILD_TIMEOUT_MS,
  };
  let raw: string | undefined;
  try {
    await writeAppBuilderProgress({
      appDir: params.appDir,
      spec: params.spec,
      modelRef: request.modelRef,
      currentTask: `${engine.label} is generating a guarded app-local SwiftUI patch plan.`,
      lastEvent: `${engine.label} request sent to the selected AI coder.`,
      inputs: ["product-spec.json", "current Swift files", "validator contract"],
      outputs: [AI_BUILD_RAW_OUTPUT_FILE, "ai-build-report.json"],
      blockedOn: ["Waiting for selected AI coder response"],
    });
    raw = await completeAppStudioAiText(params.ai, request);
    await writeFile(rawOutputPath, raw, "utf8");
    await writeAppBuilderProgress({
      appDir: params.appDir,
      spec: params.spec,
      modelRef: request.modelRef,
      currentTask: "AI returned a patch plan; applying app-local safeguards and validation.",
      lastEvent: `${engine.label} returned patch output.`,
      inputs: [AI_BUILD_RAW_OUTPUT_FILE],
      outputs: ["patch-report.json", "patch-transcript.json"],
    });
    const parsed = parseJsonObjectFromModelText(raw);
    const plan = normalizeAiPatchPlan({
      parsed,
      engine,
      objective: prompt.objective,
    });
    const patchReport = await applyAppBuilderPatchPlan(params.appDir, plan);
    const report: AppStudioAiBuildReport = {
      schemaVersion: 1,
      appId: params.spec.appId,
      appDir: params.appDir,
      generatedAt,
      engine: engine.label,
      modelRef: request.modelRef,
      ready: patchReport.ready,
      connectedToAi: true,
      objective: plan.objective,
      changedFiles: patchReport.changedFiles,
      rejectedChanges: patchReport.rejectedChanges,
      rawOutputSha256: sha256Text(raw),
      error: null,
      nextActions: patchReport.ready
        ? ["Run Build and test to prove the AI-generated SwiftUI patch in the simulator."]
        : patchReport.nextActions,
    };
    await writeJsonObject(reportPath, report);
    await appendEvidence(params.appDir, {
      at: generatedAt,
      stage: "app-studio-ai-build",
      result: report.ready ? "passed" : "blocked",
      summary: report.ready
        ? `${engine.label} generated and applied a guarded app-local patch.`
        : `${engine.label} generated a patch, but validation or safeguards blocked readiness.`,
      details: {
        engine: report.engine,
        modelRef: report.modelRef,
        changedFiles: report.changedFiles,
        rejectedChanges: report.rejectedChanges,
      },
    });
    return report;
  } catch (error) {
    if (raw !== undefined) {
      await writeFile(rawOutputPath, raw, "utf8");
    }
    const report: AppStudioAiBuildReport = {
      schemaVersion: 1,
      appId: params.spec.appId,
      appDir: params.appDir,
      generatedAt,
      engine: engine.label,
      modelRef: request.modelRef,
      ready: false,
      connectedToAi: raw !== undefined,
      objective: prompt.objective,
      changedFiles: [],
      rejectedChanges: [],
      rawOutputSha256: raw ? sha256Text(raw) : null,
      error: errorMessageWithCause(error),
      nextActions: [
        errorMessageWithCause(error),
        "Check AI coder/model readiness, then rerun Run AI build pass.",
      ],
    };
    await writeJsonObject(reportPath, report);
    await appendEvidence(params.appDir, {
      at: generatedAt,
      stage: "app-studio-ai-build",
      result: "blocked",
      summary: `${engine.label} AI build pass failed before an app-local patch could be applied.`,
      details: {
        engine: report.engine,
        modelRef: report.modelRef,
        error: report.error,
      },
    });
    return report;
  }
}

function runningAgentPatchForGate(
  gate: AppStudioGateId,
  studio: AppStudioProjectRecord,
): {
  agentId: string;
  patch: Partial<Omit<AppStudioAgentWorkItem, "id" | "label" | "role">>;
} {
  const engine = buildEngineOption(studio.buildEngine);
  switch (gate) {
    case "model-check":
      return {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: "running",
          currentTask: "Checking selected AI coder and local fallback model evidence.",
          blockedOn: [],
          lastEvent: "AI coder check started.",
        },
      };
    case "builder-task":
      return {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: "running",
          currentTask: `${engine.label} is generating a guarded app-local SwiftUI patch plan.`,
          inputs: ["product-spec.json", "current Swift files", "app-studio-agent-task.md"],
          outputs: ["ai-build-report.json", "patch-report.json", "patch-transcript.json"],
          blockedOn: [],
          lastEvent: `${engine.label} AI build pass started.`,
        },
      };
    case "implement":
    case "repair":
      return {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: "running",
          currentTask:
            gate === "repair"
              ? "Repairing app-local SwiftUI code from validation evidence."
              : "Applying the deterministic app-local SwiftUI implementation pass.",
          blockedOn: [],
          lastEvent: `${gate === "repair" ? "Repair" : "Implementation"} gate started.`,
        },
      };
    case "validate-structure":
    case "validate-build":
    case "screenshots":
      return {
        agentId: "local-validator",
        patch: {
          status: "running",
          currentTask:
            gate === "screenshots"
              ? "Building, launching, and capturing simulator screenshot evidence."
              : gate === "validate-build"
                ? "Running XcodeGen and xcodebuild simulator validation."
                : "Checking generated project structure.",
          blockedOn: [],
          lastEvent: "Local validation gate started.",
        },
      };
    case "app-store-ready":
    case "publish-plan":
    case "final-verify":
    case "ready":
      return {
        agentId: "app-store-verifier",
        patch: {
          status: "running",
          currentTask:
            gate === "ready"
              ? "Summarizing readiness and next highest-impact gap."
              : "Checking App Store, privacy, signing, publish, or verifier evidence.",
          blockedOn: [],
          lastEvent: "App Store evidence gate started.",
        },
      };
  }
  throw new Error("Unsupported app studio gate.");
}

export async function runAppStudioGate(params: {
  appDir: string;
  gate: AppStudioGateId;
  ai?: AppStudioAiRuntime;
  now?: Date;
}): Promise<AppStudioActionResult> {
  const appDir = path.resolve(params.appDir);
  const spec = await readProductSpec(appDir);
  if (!spec) {
    throw new Error("Missing app builder product spec.");
  }
  const now = nowIso(params.now);
  const studio = await readStudioProject(appDir, spec);
  const running = runningAgentPatchForGate(params.gate, studio);
  const activeStudio = updateAgentWork(
    { ...studio, updatedAt: now },
    running.agentId,
    running.patch,
    now,
  );
  await writeStudioProject(appDir, activeStudio);
  await writeAppStudioAgentTask(appDir, activeStudio, spec);
  let agentUpdate:
    | {
        agentId: string;
        patch: Partial<Omit<AppStudioAgentWorkItem, "id" | "label" | "role">>;
      }
    | null = null;
  let detail = "Gate completed.";
  switch (params.gate) {
    case "model-check": {
      const report = await evaluateAppBuilderModelReadiness(appDir);
      const engine = buildEngineOption(activeStudio.buildEngine);
      detail = report.ready
        ? `${engine.label} is selected and local Qwen fallback evidence passed.`
        : `${engine.label} is selected, but local Qwen fallback evidence is blocked.`;
      agentUpdate = {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: report.ready || activeStudio.buildEngine === "codex" ? "idle" : "blocked",
          currentTask: `Use ${engine.label} for app-local code changes; keep Qwen fallback evidence visible.`,
          outputs: ["model-readiness-report.json"],
          blockedOn: report.ready ? [] : ["Local Qwen fallback readiness"],
          lastEvent: detail,
        },
      };
      break;
    }
    case "validate-structure": {
      const report = await validateIosApp(appDir, { checkToolchain: false });
      detail = report.readyForLocalBuild
        ? "Project structure is locally build-ready."
        : "Project structure has blocking validation gaps.";
      agentUpdate = {
        agentId: "local-validator",
        patch: {
          status: report.readyForLocalBuild ? "done" : "blocked",
          currentTask: "Check project-file structure before Xcode build.",
          outputs: ["ios-validation-report.json"],
          blockedOn: report.readyForLocalBuild ? [] : ["Project structure validation gaps"],
          lastEvent: detail,
        },
      };
      break;
    }
    case "validate-build": {
      const report = await validateIosApp(appDir, { runXcodegen: true, runXcodebuild: true });
      detail = report.readyForLocalBuild
        ? "XcodeGen and xcodebuild validation passed."
        : "Xcode validation found blocking gaps.";
      agentUpdate = {
        agentId: "local-validator",
        patch: {
          status: report.readyForLocalBuild ? "done" : "blocked",
          currentTask: "Run XcodeGen and xcodebuild simulator validation.",
          outputs: ["ios-validation-report.json"],
          blockedOn: report.readyForLocalBuild ? [] : ["Xcode validation gaps"],
          lastEvent: detail,
        },
      };
      break;
    }
    case "repair": {
      const engine = buildEngineOption(activeStudio.buildEngine);
      const report = await repairIosApp(appDir, {
        engine: engine.label,
        checkToolchain: false,
      });
      detail = report.ready
        ? `${engine.label} repair loop completed and validation passed.`
        : `${engine.label} repair loop is still blocked by ${report.nextActions.length} action(s).`;
      agentUpdate = {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: report.ready ? "done" : "blocked",
          currentTask: report.ready
            ? "Repair loop restored app-local SwiftUI code; run build/test next if needed."
            : "Repair loop is blocked; review repair-report.json.",
          outputs: ["repair-report.json", "implementation-report.json", "ios-validation-report.json"],
          blockedOn: report.ready ? [] : report.nextActions,
          lastEvent: detail,
        },
      };
      break;
    }
    case "screenshots": {
      const report = await captureIosSimulatorScreenshot(appDir, {});
      detail = report.ready ? "Simulator screenshot evidence captured." : "Screenshot capture is blocked.";
      agentUpdate = {
        agentId: "local-validator",
        patch: {
          status: report.ready ? "done" : "blocked",
          currentTask: "Capture simulator screenshot evidence.",
          outputs: ["screenshot-report.json"],
          blockedOn: report.ready ? [] : ["Simulator screenshot capture"],
          lastEvent: detail,
        },
      };
      break;
    }
    case "app-store-ready": {
      const report = await evaluateAppStoreReadiness(appDir);
      detail = report.readyForAppReviewSubmission
        ? "App Store evidence is complete."
        : `App Store evidence blocked by ${report.blockedGates.length} gate(s).`;
      agentUpdate = {
        agentId: "app-store-verifier",
        patch: {
          status: report.readyForAppReviewSubmission ? "done" : "blocked",
          currentTask: "Check App Store metadata, privacy, signing, screenshots, and review evidence.",
          outputs: ["app-store-readiness.json"],
          blockedOn: report.blockedGates,
          lastEvent: detail,
        },
      };
      break;
    }
    case "publish-plan": {
      const plan = await createAppStorePublishPlan(appDir);
      detail = plan.actionable
        ? "Publish plan is actionable after human approval."
        : `Publish plan is blocked by ${plan.blockedGates.length} gate(s).`;
      agentUpdate = {
        agentId: "app-store-verifier",
        patch: {
          status: plan.actionable ? "done" : "blocked",
          currentTask: "Prepare archive/export/TestFlight/App Review publish plan.",
          outputs: ["app-store-publish-plan.json"],
          blockedOn: plan.blockedGates,
          lastEvent: detail,
        },
      };
      break;
    }
    case "final-verify": {
      const report = await createAppBuilderFinalVerifierReport(appDir, {
        requireXcodebuild: false,
        checkToolchain: false,
      });
      detail = report.readyForAppReview
        ? "Final verifier is green for App Review."
        : report.readyForTestFlight
          ? "Final verifier is green for TestFlight and blocked for App Review evidence."
          : `Final verifier is blocked by ${report.blockedGates.length} gate(s).`;
      agentUpdate = {
        agentId: "app-store-verifier",
        patch: {
          status: report.readyForAppReview ? "done" : "blocked",
          currentTask: "Review final build, privacy, App Store, and release evidence.",
          outputs: ["final-verifier-report.json"],
          blockedOn: report.readyForAppReview ? [] : report.blockedGates,
          lastEvent: detail,
        },
      };
      break;
    }
    case "ready": {
      const report = await evaluateAppBuilderReadiness(appDir);
      await writeJsonObject(path.join(appDir, BUILDER_DIR, "app-builder-readiness.json"), report);
      detail = report.why;
      agentUpdate = {
        agentId: "app-store-verifier",
        patch: {
          status: report.readyForAppStore ? "done" : report.readyToBuild ? "idle" : "blocked",
          currentTask: "Summarize readiness and next highest-impact gap.",
          outputs: ["app-builder-readiness.json"],
          blockedOn: report.readyForAppStore ? [] : [report.nextMostImpactfulGap],
          lastEvent: detail,
        },
      };
      break;
    }
    case "implement": {
      const engine = buildEngineOption(activeStudio.buildEngine);
      const report = await applyAppBuilderImplementationPass(appDir, { engine: engine.label });
      detail = report.ready
        ? `${engine.label} implementation pass updated app-local SwiftUI code.`
        : `${engine.label} implementation pass is blocked by ${report.nextActions.length} safeguard(s).`;
      agentUpdate = {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: report.ready ? "done" : "blocked",
          currentTask: report.ready
            ? "App UI implementation pass is complete; run validation next."
            : "Implementation pass is blocked; review implementation-report.json.",
          outputs: ["Sources/ContentView.swift", "Sources/AppModels.swift", "implementation-report.json"],
          blockedOn: report.ready ? [] : report.nextActions,
          lastEvent: detail,
        },
      };
      break;
    }
    case "builder-task": {
      const engine = buildEngineOption(activeStudio.buildEngine);
      const report = await runAppStudioAiBuildPass({
        appDir,
        spec,
        studio: activeStudio,
        ai: params.ai,
        now: params.now,
      });
      detail = report.ready
        ? `${engine.label} connected to AI, generated a guarded app-local patch, and changed ${report.changedFiles.length} file(s).`
        : `${engine.label} AI build pass is blocked: ${report.error ?? report.nextActions[0] ?? "review ai-build-report.json"}.`;
      agentUpdate = {
        agentId: "app-builder",
        patch: {
          modelRef: engine.modelRef,
          status: report.ready ? "done" : "blocked",
          currentTask: report.ready
            ? "AI build pass applied an app-local SwiftUI patch; run Build and test next."
            : "AI build pass is blocked; review ai-build-report.json.",
          outputs: [
            "builder-task.md",
            "app-studio-agent-task.md",
            "ai-build-report.json",
            AI_BUILD_RAW_OUTPUT_FILE,
            "patch-report.json",
            "patch-transcript.json",
          ],
          blockedOn: report.ready ? [] : report.nextActions,
          lastEvent: detail,
        },
      };
      break;
    }
    default: {
      const exhaustive: never = params.gate;
      void exhaustive;
      throw new Error("Unsupported App Studio gate.");
    }
  }
  const finishedAt = nowIso();
  const nextStudio = agentUpdate
    ? updateAgentWork(
        { ...activeStudio, updatedAt: finishedAt },
        agentUpdate.agentId,
        agentUpdate.patch,
        finishedAt,
      )
    : { ...activeStudio, updatedAt: finishedAt };
  await writeStudioProject(appDir, nextStudio);
  await writeAppStudioAgentTask(appDir, nextStudio, spec);
  return {
    snapshot: await buildAppStudioSnapshot({ appDir }),
    receipt: {
      title: GATES.find((gate) => gate.id === params.gate)?.label ?? "Gate finished",
      detail,
      next: "Review the updated next gap and run the next gate.",
    },
  };
}

function factPatchFromParams(params: UnknownRecord): AppStoreFactPatch {
  return {
    appStoreConnectAppId: stringParam(params, "appStoreConnectAppId"),
    sku: stringParam(params, "sku"),
    teamId: stringParam(params, "teamId"),
    signingIdentity: stringParam(params, "signingIdentity"),
    provisioningProfile: stringParam(params, "provisioningProfile"),
    apiKeyProfileRef: stringParam(params, "apiKeyProfileRef"),
    supportUrl: stringParam(params, "supportUrl"),
    privacyUrl: stringParam(params, "privacyUrl"),
    reviewContactName: stringParam(params, "reviewContactName"),
    reviewContactEmail: stringParam(params, "reviewContactEmail"),
    reviewContactPhone: stringParam(params, "reviewContactPhone"),
  };
}

export function registerAppStudioGatewayMethods(api: OpenClawPluginApi) {
  api.registerGatewayMethod(
    "apps.dashboard.snapshot",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await buildAppStudioSnapshot({
            appDir: stringParam(requestParams, "appDir"),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.create",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await createAppStudioProject({
            request: stringParam(requestParams, "request", true),
            appName: stringParam(requestParams, "appName"),
            appId: stringParam(requestParams, "appId"),
            bundleId: stringParam(requestParams, "bundleId"),
            outputDir: stringParam(requestParams, "outputDir"),
            force: booleanParam(requestParams, "force"),
            buildEngine: normalizeBuildEngine(stringParam(requestParams, "buildEngine")),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.applyPrompt",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await applyAppStudioPrompt({
            appDir: stringParam(requestParams, "appDir", true),
            prompt: stringParam(requestParams, "prompt", true),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.setBuildEngine",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await setAppStudioBuildEngine({
            appDir: stringParam(requestParams, "appDir", true),
            buildEngine: normalizeBuildEngine(stringParam(requestParams, "buildEngine", true)),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.reorderScreens",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await reorderAppStudioScreens({
            appDir: stringParam(requestParams, "appDir", true),
            screenIds: stringArrayParam(requestParams, "screenIds", true),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.importScreenImages",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await importAppStudioScreenImages({
            appDir: stringParam(requestParams, "appDir", true),
            images: Array.isArray(requestParams.images)
              ? (requestParams.images.filter(isRecord) as AppStudioScreenImageUpload[])
              : [],
            notes: stringParam(requestParams, "notes"),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.applyScreenAnalysis",
    async ({ params: requestParams, respond }) => {
      try {
        const analysis =
          requestParams.analysis ??
          stringParam(requestParams, "analysisJson") ??
          stringParam(requestParams, "analysis", true);
        respond(
          true,
          await applyAppStudioScreenAnalysis({
            appDir: stringParam(requestParams, "appDir", true),
            analysis: analysis as AppStudioScreenAnalysisInput | string,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.updateScreenFlow",
    async ({ params: requestParams, respond }) => {
      try {
        const screenFlow = isRecord(requestParams.screenFlow)
          ? {
              entryScreenId:
                typeof requestParams.screenFlow.entryScreenId === "string"
                  ? requestParams.screenFlow.entryScreenId
                  : undefined,
              edges: Array.isArray(requestParams.screenFlow.edges)
                ? (requestParams.screenFlow.edges.filter(isRecord) as AppBuilderScreenFlowEdge[])
                : [],
            }
          : { edges: [] };
        respond(
          true,
          await updateAppStudioScreenFlow({
            appDir: stringParam(requestParams, "appDir", true),
            screenFlow,
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.importAppleFacts",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await importAppStudioAppleFacts({
            appDir: stringParam(requestParams, "appDir", true),
            facts: factPatchFromParams(requestParams),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.runGate",
    async ({ params: requestParams, respond, context }) => {
      try {
        const cfg =
          typeof context.getRuntimeConfig === "function" ? context.getRuntimeConfig() : undefined;
        respond(
          true,
          await runAppStudioGate({
            appDir: stringParam(requestParams, "appDir", true),
            gate: stringParam(requestParams, "gate", true) as AppStudioGateId,
            ai: { cfg },
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "apps.project.approveGate",
    async ({ params: requestParams, respond }) => {
      try {
        respond(
          true,
          await approveAppStudioGate({
            appDir: stringParam(requestParams, "appDir", true),
            approvalId: stringParam(requestParams, "approvalId", true),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: APPROVAL_SCOPE },
  );
}

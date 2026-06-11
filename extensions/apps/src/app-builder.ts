import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AppBuilderTarget = "ios-native" | "plugin";

export type AppBuilderScreenFlowEdge = {
  id: string;
  fromScreenId: string;
  toScreenId: string;
  label: string;
  trigger: string;
};

export type AppBuilderScreenFlow = {
  entryScreenId: string;
  edges: AppBuilderScreenFlowEdge[];
};

export type AppBuilderProductSpec = {
  schemaVersion: 1;
  templateVersion: string;
  target: AppBuilderTarget;
  appId: string;
  appName: string;
  moduleName: string;
  bundleId: string;
  originalRequest: string;
  platform: {
    kind: "ios-native";
    minimumIOS: string;
    swiftVersion: string;
    appStoreOnly: boolean;
  };
  goal: string;
  audience: string;
  appleCategory: string;
  coreUserJourneys: string[];
  screens: Array<{
    id: string;
    title: string;
    purpose: string;
  }>;
  screenFlow?: AppBuilderScreenFlow;
  dataModel: Array<{
    name: string;
    purpose: string;
    fields: string[];
  }>;
  permissions: Array<{
    permission: string;
    reason: string;
    required: boolean;
  }>;
  privacyPosture: {
    collectsPersonalData: boolean;
    tracking: boolean;
    networkAccess: boolean;
    notes: string[];
  };
  monetization: string;
  offlineBehavior: string;
  integrations: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  unresolvedQuestions: string[];
  createdAt: string;
};

export type AppBuildPacket = {
  schemaVersion: 1;
  appId: string;
  appDir: string;
  target: AppBuilderTarget;
  acceptedRequest: string;
  allowedWriteRoot: string;
  forbiddenActions: string[];
  requiredArtifacts: string[];
  requiredValidationCommands: string[];
  approvalGates: Array<{
    id: string;
    requiredBefore: string;
    status: "blocked" | "not-required" | "approved";
  }>;
  modelRouting: AppBuilderModelRouting;
  riskSignals: string[];
};

export type AppBuilderModelRouting = {
  planner: AppBuilderModelProfile;
  builder: AppBuilderModelProfile;
  localFallback: AppBuilderModelProfile;
  repairFallback: AppBuilderModelProfile;
  finalVerifier: AppBuilderModelProfile;
  disallowedReviewers: string[];
};

export type AppBuilderModelProfile = {
  role: "planner" | "builder" | "local-fallback" | "repair-fallback" | "final-verifier";
  provider: "openai" | "ollama";
  modelRef: string;
  runtime: "codex" | "ollama-native";
  authProvider: string | null;
  modelFamily: string;
  quantization: string | null;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | null;
  contextWindowTokens: number;
  maxOutputTokens: number;
  parameters: AppBuilderModelParameters | null;
  requiresLocalAvailability: boolean;
  requiresModelDigestBeforeMutation: boolean;
  digest: string | null;
  failClosedIfUnavailable: boolean;
  purpose: string;
  mutationPolicy: string;
  requiredBefore: string[];
  allowedWhen: string[];
};

export type AppBuilderModelParameters = {
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  numCtx: number;
  numPredict: number;
  think: boolean;
};

export type EvidenceLedger = {
  schemaVersion: 1;
  appId: string;
  events: EvidenceLedgerEvent[];
};

export type EvidenceLedgerEvent = {
  at: string;
  stage: string;
  result: "created" | "passed" | "failed" | "blocked";
  summary: string;
  details?: Record<string, unknown>;
};

export type IosValidationReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  readyForLocalBuild: boolean;
  checkedAt: string;
  checks: ValidationCheck[];
  commands: CommandResult[];
  nextActions: string[];
};

export type ValidationCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  message: string;
};

export type CommandResult = {
  command: string;
  skipped: boolean;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
};

export type AppStoreReadinessReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  readyForTestFlightUpload: boolean;
  readyForAppReviewSubmission: boolean;
  checkedAt: string;
  requiredEvidence: Array<{
    id: string;
    label: string;
    present: boolean;
    criticality: number;
    remediation: string;
  }>;
  blockedGates: string[];
  nextActions: string[];
};

export type IosScreenshotReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  ready: boolean;
  checkedAt: string;
  simulator: {
    requestedName: string;
    resolvedName: string | null;
    udid: string | null;
    runtime: string | null;
  };
  appBundlePath: string | null;
  screenshotPath: string | null;
  commands: CommandResult[];
  nextActions: string[];
};

export type AppStorePublishPlan = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  generatedAt: string;
  actionable: boolean;
  blockedGates: string[];
  prerequisites: string[];
  commands: Array<{
    id: string;
    purpose: string;
    command: string;
    requiresHumanApproval: boolean;
  }>;
  manualSteps: string[];
  rollbackPlan: string[];
  notes: string[];
};

export type AppBuilderGapReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  checkedAt: string;
  score: number;
  readyForAutonomousBuild: boolean;
  readyForPublishPlanning: boolean;
  strengths: string[];
  gaps: AppBuilderGap[];
  nextActions: string[];
};

export type AppBuilderModelReadinessReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  checkedAt: string;
  ready: boolean;
  checks: ValidationCheck[];
  builder: {
    modelRef: string | null;
    ollamaModel: string | null;
    digest: string | null;
    baseUrl: string;
  };
  localFallback: {
    modelRef: string | null;
    ollamaModel: string | null;
    digest: string | null;
    baseUrl: string;
  };
  nextActions: string[];
};

export type AppBuilderImplementationReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  generatedAt: string;
  engine: string;
  ready: boolean;
  filesChanged: string[];
  safeguards: string[];
  checks: ValidationCheck[];
  nextActions: string[];
};

export type AppBuilderRepairReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  generatedAt: string;
  engine: string;
  repaired: boolean;
  ready: boolean;
  sourceChecksBefore: ValidationCheck[];
  sourceChecksAfter: ValidationCheck[];
  validationBefore: IosValidationReport;
  validationAfter: IosValidationReport;
  implementation: AppBuilderImplementationReport | null;
  safeguards: string[];
  nextActions: string[];
};

export type AppBuilderFinalVerifierReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  generatedAt: string;
  verifier: AppBuilderModelProfile | null;
  readyForTestFlight: boolean;
  readyForAppReview: boolean;
  checks: ValidationCheck[];
  blockedGates: string[];
  evidence: {
    validationReady: boolean;
    xcodebuildTested: boolean;
    implementationReady: boolean;
    repairReady: boolean | null;
    screenshotReady: boolean;
    appStoreReadyForTestFlight: boolean;
    appStoreReadyForAppReview: boolean;
    publishPlanActionable: boolean;
    modelReadinessReady: boolean;
    secretHits: string[];
  };
  safeguards: string[];
  nextActions: string[];
};

export type AppBuilderPatchPlan = {
  schemaVersion: 1;
  engine: string;
  objective: string;
  changes: AppBuilderPatchChange[];
  validation?: {
    runXcodegen?: boolean;
    runXcodebuild?: boolean;
    simulator?: string;
    checkToolchain?: boolean;
  };
};

export type AppBuilderPatchChange = {
  path: string;
  action: "write";
  contents: string;
  oldContentSha256?: string | null;
};

export type AppBuilderPatchReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  generatedAt: string;
  engine: string;
  objective: string;
  ready: boolean;
  applied: boolean;
  changedFiles: string[];
  rejectedChanges: Array<{
    path: string;
    reason: string;
  }>;
  checks: ValidationCheck[];
  validationAfter: IosValidationReport;
  transcriptPath: string;
  safeguards: string[];
  nextActions: string[];
};

export type AppBuilderGap = {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  impact: number;
  remediation: string;
};

export type AppBuilderReadinessReport = {
  schemaVersion: 1;
  appId: string | null;
  appDir: string;
  readyToBuild: boolean;
  readyForAppStore: boolean;
  completionGrade: number;
  criticalityOfNextGap: number;
  nextMostImpactfulGap: string;
  why: string;
  validation: IosValidationReport;
  appStore: AppStoreReadinessReport;
  gaps: AppBuilderGapReport;
};

export type CreateIosNativeAppOptions = {
  request: string;
  appName?: string;
  appId?: string;
  bundleId?: string;
  outputDir?: string;
  cwd?: string;
  force?: boolean;
  now?: Date;
};

export type CreateIosNativeAppResult = {
  appDir: string;
  spec: AppBuilderProductSpec;
  buildPacket: AppBuildPacket;
  filesWritten: string[];
};

const TEMPLATE_VERSION = "ios-native-swiftui-xcodegen-2026.5.8.1";
const BUILDER_DIR = ".openclaw-app-builder";
const APP_BUILDER_PLANNER_MODEL_REF = "openai/gpt-5.5";
const APP_BUILDER_BUILDER_MODEL_REF = "ollama/qwen3.6:27b-q8_0";
const APP_BUILDER_LOCAL_FALLBACK_MODEL_REF =
  "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest";
const APP_BUILDER_VERIFIER_MODEL_REF = "openai/gpt-5.5";
const APP_BUILDER_QWEN_PARAMS: AppBuilderModelParameters = {
  temperature: 0.15,
  topP: 0.9,
  topK: 20,
  repeatPenalty: 1.05,
  numCtx: 65_536,
  numPredict: 8_192,
  think: false,
};

type ProductBlueprint = {
  audience: string;
  appleCategory: string;
  coreUserJourneys: string[];
  screens: AppBuilderProductSpec["screens"];
  dataModel: AppBuilderProductSpec["dataModel"];
  permissions: AppBuilderProductSpec["permissions"];
  privacyNotes: string[];
  acceptanceCriteria: string[];
  unresolvedQuestions: string[];
};

export function inferAppBuilderTarget(request: string): AppBuilderTarget {
  const normalized = request.toLowerCase();
  if (/app store|apple store|ios|iphone|ipad|swiftui|testflight/.test(normalized)) {
    return "ios-native";
  }
  return "ios-native";
}

export function slugifyAppId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "generated-app";
}

export function createDefaultAppBuilderScreenFlow(
  screens: AppBuilderProductSpec["screens"],
): AppBuilderScreenFlow {
  const entryScreenId = screens[0]?.id ?? "home";
  const edges: AppBuilderScreenFlowEdge[] = [];
  for (let index = 0; index < screens.length - 1; index += 1) {
    const from = screens[index];
    const to = screens[index + 1];
    edges.push({
      id: `${from.id}-to-${to.id}`,
      fromScreenId: from.id,
      toScreenId: to.id,
      label: `Open ${to.title}`,
      trigger: `Tap “Open ${to.title}”`,
    });
  }
  if (screens.length > 1) {
    const last = screens[screens.length - 1];
    const first = screens[0];
    edges.push({
      id: `${last.id}-to-${first.id}`,
      fromScreenId: last.id,
      toScreenId: first.id,
      label: `Back to ${first.title}`,
      trigger: `Tap “Back to ${first.title}”`,
    });
  }
  return { entryScreenId, edges };
}

export function normalizeAppBuilderScreenFlow(spec: AppBuilderProductSpec): AppBuilderScreenFlow {
  const screenIds = new Set(spec.screens.map((screen) => screen.id));
  const fallback = createDefaultAppBuilderScreenFlow(spec.screens);
  const current = spec.screenFlow;
  if (!current || !screenIds.has(current.entryScreenId)) {
    return fallback;
  }
  const edges = Array.isArray(current.edges)
    ? current.edges
        .filter(
          (edge): edge is AppBuilderScreenFlowEdge =>
            typeof edge?.id === "string" &&
            screenIds.has(edge.fromScreenId) &&
            screenIds.has(edge.toScreenId) &&
            edge.fromScreenId !== edge.toScreenId,
        )
        .map((edge) => ({
          id: edge.id || `${edge.fromScreenId}-to-${edge.toScreenId}`,
          fromScreenId: edge.fromScreenId,
          toScreenId: edge.toScreenId,
          label: edge.label || `Open ${edge.toScreenId}`,
          trigger: edge.trigger || `Tap “${edge.label || "Open"}”`,
        }))
    : [];
  return {
    entryScreenId: current.entryScreenId,
    edges,
  };
}

export function toPascalIdentifier(input: string): string {
  const words = input.match(/[A-Za-z0-9]+/g) ?? ["Generated", "App"];
  const value = words
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join("")
    .replace(/^[0-9]+/, "");
  return value || "GeneratedApp";
}

export function deriveAppName(request: string): string {
  const cleaned = request
    .replace(
      /\b(build|create|make|generate|please|an?|ios|iphone|ipad|app|for|the|apple|store)\b/gi,
      " ",
    )
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (cleaned || "Generated App").split(" ").slice(0, 4);
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

export async function createIosNativeApp(
  options: CreateIosNativeAppOptions,
): Promise<CreateIosNativeAppResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const appName = options.appName?.trim() || deriveAppName(options.request);
  const appId = slugifyAppId(options.appId ?? appName);
  const moduleName = toPascalIdentifier(appName);
  const bundleId = options.bundleId?.trim() || `ai.openclaw.generated.${appId.replace(/-/g, ".")}`;
  const appDir = path.resolve(options.outputDir ?? path.join(cwd, "generated-apps", appId));
  const now = options.now ?? new Date();

  await assertWritableTarget(appDir, Boolean(options.force));

  const spec = buildProductSpec({
    appId,
    appName,
    moduleName,
    bundleId,
    request: options.request,
    now,
  });
  const buildPacket = buildAppBuildPacket({ appDir, spec });
  const filesWritten: string[] = [];

  const write = async (relativePath: string, content: string) => {
    await writeTextFile(path.join(appDir, relativePath), content);
    filesWritten.push(relativePath);
  };
  const writeJson = async (relativePath: string, value: unknown) => {
    await write(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  };

  await mkdir(appDir, { recursive: true });
  await write("README.md", renderReadme(spec));
  await write("project.yml", renderProjectYml(spec));
  await write("Sources/AppMain.swift", renderAppMainSwift(spec));
  await write("Sources/ContentView.swift", renderContentViewSwift(spec));
  await write("Sources/AppModels.swift", renderAppBuilderModelsSwift(spec));
  await write("Sources/Info.plist", renderInfoPlist(spec));
  await write("Sources/PrivacyInfo.xcprivacy", renderPrivacyManifest());
  await write("Tests/GeneratedAppTests.swift", renderAppBuilderTestsSwift(spec));
  await write("Assets.xcassets/Contents.json", '{"info":{"author":"xcode","version":1}}\n');
  await write("Assets.xcassets/AppIcon.appiconset/Contents.json", renderAppIconContents());
  await write("AppStore/metadata.json", renderAppStoreMetadata(spec));
  await write("AppStore/review-notes.md", renderReviewNotes(spec));
  await write("AppStore/app-store-connect.json", renderAppStoreConnectStub(spec));
  await write("AppStore/ExportOptions.plist", renderExportOptionsPlist(spec));
  await write("Privacy/privacy-evidence.md", renderPrivacyEvidence(spec));
  await write("Screenshots/.gitkeep", "");
  await writeJson(`${BUILDER_DIR}/product-spec.json`, spec);
  await writeJson(`${BUILDER_DIR}/build-packet.json`, buildPacket);
  await writeJson(`${BUILDER_DIR}/evidence-ledger.json`, {
    schemaVersion: 1,
    appId: spec.appId,
    events: [
      {
        at: now.toISOString(),
        stage: "create",
        result: "created",
        summary: "Generated native iOS SwiftUI scaffold and app-builder evidence artifacts.",
        details: {
          templateVersion: TEMPLATE_VERSION,
          target: spec.target,
          filesWritten,
        },
      },
    ],
  } satisfies EvidenceLedger);

  return { appDir, spec, buildPacket, filesWritten };
}

export async function readProductSpec(appDir: string): Promise<AppBuilderProductSpec | null> {
  const specPath = path.join(appDir, BUILDER_DIR, "product-spec.json");
  try {
    const parsed = JSON.parse(await readFile(specPath, "utf8")) as Partial<AppBuilderProductSpec>;
    if (
      parsed.schemaVersion === 1 &&
      parsed.target === "ios-native" &&
      typeof parsed.appId === "string" &&
      typeof parsed.appName === "string" &&
      typeof parsed.moduleName === "string" &&
      typeof parsed.bundleId === "string"
    ) {
      return parsed as AppBuilderProductSpec;
    }
    return null;
  } catch {
    return null;
  }
}

export async function readBuildPacket(appDir: string): Promise<AppBuildPacket | null> {
  try {
    const value = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "build-packet.json"), "utf8"),
    ) as AppBuildPacket;
    return value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export async function validateIosApp(
  appDirInput: string,
  options: {
    runXcodegen?: boolean;
    runXcodebuild?: boolean;
    simulator?: string;
    checkToolchain?: boolean;
    writeReport?: boolean;
  } = {},
): Promise<IosValidationReport> {
  const appDir = path.resolve(appDirInput);
  const checkedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const checks: ValidationCheck[] = [];
  const commands: CommandResult[] = [];

  const requirePath = async (id: string, relativePath: string, message: string) => {
    const exists = await pathExists(path.join(appDir, relativePath));
    checks.push({ id, ok: exists, severity: "critical", message });
  };

  checks.push({
    id: "product-spec",
    ok: spec !== null,
    severity: "critical",
    message: spec ? "Product spec is present and parseable." : "Missing product spec.",
  });
  await requirePath("project-yml", "project.yml", "XcodeGen project.yml is present.");
  await requirePath("sources", "Sources/AppMain.swift", "SwiftUI app entry point is present.");
  await requirePath("tests", "Tests/GeneratedAppTests.swift", "Generated Swift tests are present.");
  await requirePath(
    "privacy-manifest",
    "Sources/PrivacyInfo.xcprivacy",
    "Apple privacy manifest is present.",
  );
  await requirePath("build-packet", `${BUILDER_DIR}/build-packet.json`, "Build packet is present.");
  await requirePath(
    "evidence-ledger",
    `${BUILDER_DIR}/evidence-ledger.json`,
    "Evidence ledger is present.",
  );

  const packet = await readBuildPacket(appDir);
  const modelRouting = packet ? validateAppBuilderModelRouting(packet) : null;
  checks.push({
    id: "model-routing",
    ok: Boolean(modelRouting?.ok),
    severity: "critical",
    message: modelRouting?.ok
      ? "Build packet pins Qwen Q8 primary builder, Qwen Q6 local fallback, Codex planner, Codex repair fallback, and Codex final verifier."
      : `Build packet model routing is invalid: ${modelRouting?.messages.join("; ") || "missing build packet"}.`,
  });

  if (options.checkToolchain !== false) {
    for (const tool of ["xcodebuild", "xcrun", "xcodegen"]) {
      const available = await commandAvailable(tool);
      checks.push({
        id: `tool-${tool}`,
        ok: available,
        severity: "critical",
        message: available ? `${tool} is available.` : `${tool} is not available on PATH.`,
      });
    }
  } else {
    checks.push({
      id: "toolchain-skipped",
      ok: true,
      severity: "warning",
      message: "Toolchain checks skipped by caller.",
    });
  }

  if (spec) {
    const projectText = await safeReadText(path.join(appDir, "project.yml"));
    checks.push({
      id: "traceability-project",
      ok: projectText.includes(spec.moduleName) && projectText.includes(spec.bundleId),
      severity: "critical",
      message: "project.yml traces to the product spec module name and bundle id.",
    });
  }

  const shouldRunXcodegen = options.runXcodegen === true || options.runXcodebuild === true;
  if (shouldRunXcodegen) {
    commands.push(await runCommand("xcodegen", ["generate"], { cwd: appDir, timeoutMs: 120_000 }));
  }
  if (options.runXcodebuild === true && spec) {
    const simulator = options.simulator ?? "iPhone 17 Pro";
    commands.push(
      await runCommand(
        "xcodebuild",
        [
          "test",
          "-scheme",
          spec.moduleName,
          "-destination",
          `platform=iOS Simulator,name=${simulator}`,
          "CODE_SIGNING_ALLOWED=NO",
        ],
        { cwd: appDir, timeoutMs: 240_000 },
      ),
    );
  }

  const criticalChecksPassed = checks.every((check) => check.severity !== "critical" || check.ok);
  const commandsPassed = commands.every((command) => command.ok || command.skipped);
  const readyForLocalBuild = criticalChecksPassed && commandsPassed;
  const nextActions = buildValidationNextActions({ checks, commands, readyForLocalBuild });
  const report: IosValidationReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    readyForLocalBuild,
    checkedAt,
    checks,
    commands,
    nextActions,
  };
  if (options.writeReport !== false) {
    await writeJsonFile(path.join(appDir, BUILDER_DIR, "ios-validation-report.json"), report);
    await appendEvidence(appDir, {
      at: checkedAt,
      stage: "ios-validate",
      result: readyForLocalBuild ? "passed" : "failed",
      summary: readyForLocalBuild
        ? "iOS scaffold validation passed."
        : "iOS scaffold validation found blocking gaps.",
      details: {
        runXcodegen: Boolean(options.runXcodegen),
        runXcodebuild: Boolean(options.runXcodebuild),
      },
    });
  }
  return report;
}

export async function evaluateAppStoreReadiness(
  appDirInput: string,
): Promise<AppStoreReadinessReport> {
  const appDir = path.resolve(appDirInput);
  const checkedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const metadata = await readJsonObject(path.join(appDir, "AppStore", "metadata.json"));
  const connect = await readJsonObject(path.join(appDir, "AppStore", "app-store-connect.json"));
  const screenshots = await listFiles(path.join(appDir, "Screenshots"));

  const evidence = [
    evidenceItem(
      "app-record",
      "App Store Connect app record id",
      stringPresent(connect.appStoreConnectAppId),
      10,
      "Create or link the App Store Connect app record, then fill AppStore/app-store-connect.json.",
    ),
    evidenceItem(
      "bundle-id",
      "Apple bundle identifier",
      Boolean(spec?.bundleId),
      10,
      "Set the bundle id in the product spec and Apple Developer portal.",
    ),
    evidenceItem(
      "team-id",
      "Apple team id",
      stringPresent(connect.teamId),
      9,
      "Fill teamId in AppStore/app-store-connect.json.",
    ),
    evidenceItem(
      "sku",
      "App Store SKU",
      stringPresent(connect.sku),
      8,
      "Fill sku in AppStore/app-store-connect.json.",
    ),
    evidenceItem(
      "signing",
      "Signing identity and profile references",
      stringPresent(connect.signingIdentity) && stringPresent(connect.provisioningProfile),
      10,
      "Fill signingIdentity and provisioningProfile references without storing secrets.",
    ),
    evidenceItem(
      "api-key-profile",
      "App Store Connect API key profile reference",
      stringPresent(connect.apiKeyProfileRef),
      9,
      "Create an App Store Connect API key profile outside the app directory, then fill apiKeyProfileRef.",
    ),
    evidenceItem(
      "screenshots",
      "At least one App Store screenshot",
      screenshots.some((file) => /\.(png|jpg|jpeg)$/i.test(file)),
      8,
      "Add App Store screenshots under Screenshots/.",
    ),
    evidenceItem(
      "description",
      "App description",
      stringPresent(metadata.description),
      7,
      "Fill AppStore/metadata.json description.",
    ),
    evidenceItem(
      "privacy-url",
      "Privacy policy URL",
      stringPresent(metadata.privacyUrl),
      10,
      "Fill AppStore/metadata.json privacyUrl.",
    ),
    evidenceItem(
      "support-url",
      "Support URL",
      stringPresent(metadata.supportUrl),
      8,
      "Fill AppStore/metadata.json supportUrl.",
    ),
    evidenceItem(
      "age-rating",
      "Age rating answers",
      objectHasValues(metadata.ageRating),
      8,
      "Fill AppStore/metadata.json ageRating.",
    ),
    evidenceItem(
      "privacy-nutrition",
      "Privacy nutrition labels",
      objectHasValues(metadata.privacyNutritionLabels),
      10,
      "Fill AppStore/metadata.json privacyNutritionLabels.",
    ),
    evidenceItem(
      "review-contact",
      "App Review contact",
      objectHasValues(metadata.reviewContact),
      8,
      "Fill AppStore/metadata.json reviewContact.",
    ),
    evidenceItem(
      "accessibility",
      "Accessibility notes",
      stringPresent(metadata.accessibilityNotes),
      6,
      "Document VoiceOver, Dynamic Type, contrast, and reduced-motion coverage.",
    ),
  ];
  const blockedGates = evidence.filter((item) => !item.present).map((item) => item.id);
  const readyForTestFlightUpload = blockedGates.every(
    (gate) =>
      !["app-record", "bundle-id", "team-id", "sku", "signing", "api-key-profile"].includes(gate),
  );
  const readyForAppReviewSubmission = blockedGates.length === 0;
  const report: AppStoreReadinessReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    readyForTestFlightUpload,
    readyForAppReviewSubmission,
    checkedAt,
    requiredEvidence: evidence,
    blockedGates,
    nextActions:
      blockedGates.length === 0
        ? ["Run final human approval and Codex final verifier before upload/submission."]
        : evidence.filter((item) => !item.present).map((item) => item.remediation),
  };
  await writeJsonFile(path.join(appDir, BUILDER_DIR, "app-store-readiness.json"), report);
  await appendEvidence(appDir, {
    at: checkedAt,
    stage: "app-store-ready",
    result: readyForAppReviewSubmission ? "passed" : "blocked",
    summary: readyForAppReviewSubmission
      ? "App Store readiness evidence is complete."
      : "App Store readiness is blocked by missing evidence.",
    details: { blockedGates },
  });
  return report;
}

export async function captureIosSimulatorScreenshot(
  appDirInput: string,
  options: { simulator?: string; writeReport?: boolean } = {},
): Promise<IosScreenshotReport> {
  const appDir = path.resolve(appDirInput);
  const checkedAt = new Date().toISOString();
  const simulatorName = options.simulator ?? "iPhone 17 Pro";
  const spec = await readProductSpec(appDir);
  const commands: CommandResult[] = [];
  let resolvedSimulator: ResolvedSimulator | null = null;
  let appBundlePath: string | null = null;
  let screenshotPath: string | null = null;

  if (!spec) {
    return await finishScreenshotReport({
      appDir,
      checkedAt,
      spec,
      simulatorName,
      resolvedSimulator,
      appBundlePath,
      screenshotPath,
      commands,
      writeReport: options.writeReport,
      nextActions: ["Create the app scaffold first so product-spec.json exists."],
    });
  }

  commands.push(await runCommand("xcodegen", ["generate"], { cwd: appDir, timeoutMs: 120_000 }));
  if (commands.some((command) => !command.ok)) {
    return await finishScreenshotReport({
      appDir,
      checkedAt,
      spec,
      simulatorName,
      resolvedSimulator,
      appBundlePath,
      screenshotPath,
      commands,
      writeReport: options.writeReport,
      nextActions: ["Fix XcodeGen generation before simulator launch."],
    });
  }

  const derivedDataPath = path.join(appDir, BUILDER_DIR, "DerivedData");
  commands.push(
    await runCommand(
      "xcodebuild",
      [
        "build",
        "-scheme",
        spec.moduleName,
        "-destination",
        `platform=iOS Simulator,name=${simulatorName}`,
        "-derivedDataPath",
        derivedDataPath,
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { cwd: appDir, timeoutMs: 300_000 },
    ),
  );
  if (commands.some((command) => !command.ok)) {
    return await finishScreenshotReport({
      appDir,
      checkedAt,
      spec,
      simulatorName,
      resolvedSimulator,
      appBundlePath,
      screenshotPath,
      commands,
      writeReport: options.writeReport,
      nextActions: ["Fix xcodebuild simulator build before launch/screenshot capture."],
    });
  }

  appBundlePath = await findAppBundle(
    path.join(derivedDataPath, "Build", "Products"),
    spec.moduleName,
  );
  if (!appBundlePath) {
    return await finishScreenshotReport({
      appDir,
      checkedAt,
      spec,
      simulatorName,
      resolvedSimulator,
      appBundlePath,
      screenshotPath,
      commands,
      writeReport: options.writeReport,
      nextActions: [`Expected built app bundle for ${spec.moduleName}, but none was found.`],
    });
  }

  const listDevices = await runCommand(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { cwd: appDir, timeoutMs: 60_000, tailMax: 120_000 },
  );
  commands.push(listDevices);
  if (!listDevices.ok) {
    return await finishScreenshotReport({
      appDir,
      checkedAt,
      spec,
      simulatorName,
      resolvedSimulator,
      appBundlePath,
      screenshotPath,
      commands,
      writeReport: options.writeReport,
      nextActions: ["Fix xcrun simctl device listing before simulator launch."],
    });
  }

  resolvedSimulator = resolveSimulator(listDevices.stdoutTail, simulatorName);
  if (!resolvedSimulator) {
    return await finishScreenshotReport({
      appDir,
      checkedAt,
      spec,
      simulatorName,
      resolvedSimulator,
      appBundlePath,
      screenshotPath,
      commands,
      writeReport: options.writeReport,
      nextActions: [`Install or select an available iOS simulator named ${simulatorName}.`],
    });
  }

  if (resolvedSimulator.state === "Booted") {
    commands.push(skippedCommand(`xcrun simctl boot ${resolvedSimulator.udid}`, "already booted"));
  } else {
    commands.push(
      await runCommand("xcrun", ["simctl", "boot", resolvedSimulator.udid], {
        cwd: appDir,
        timeoutMs: 120_000,
      }),
    );
  }
  commands.push(
    await runCommand("xcrun", ["simctl", "bootstatus", resolvedSimulator.udid, "-b"], {
      cwd: appDir,
      timeoutMs: 180_000,
    }),
  );
  commands.push(
    await runCommand("xcrun", ["simctl", "install", resolvedSimulator.udid, appBundlePath], {
      cwd: appDir,
      timeoutMs: 120_000,
    }),
  );
  commands.push(
    await runCommand("xcrun", ["simctl", "launch", resolvedSimulator.udid, spec.bundleId], {
      cwd: appDir,
      timeoutMs: 60_000,
    }),
  );
  commands.push(await waitCommand("wait 2000ms for app launch settle", 2_000));

  const screenshotName = `simulator-${slugifyAppId(resolvedSimulator.name)}-${checkedAt.replace(/[:.]/g, "-")}.png`;
  screenshotPath = path.join(appDir, "Screenshots", screenshotName);
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  commands.push(
    await runCommand(
      "xcrun",
      ["simctl", "io", resolvedSimulator.udid, "screenshot", screenshotPath],
      {
        cwd: appDir,
        timeoutMs: 60_000,
      },
    ),
  );

  const screenshotExists = await pathExists(screenshotPath);
  return await finishScreenshotReport({
    appDir,
    checkedAt,
    spec,
    simulatorName,
    resolvedSimulator,
    appBundlePath,
    screenshotPath: screenshotExists ? screenshotPath : null,
    commands,
    writeReport: options.writeReport,
    nextActions: screenshotExists
      ? ["Run openclaw apps app-store-ready <app-dir> to consume screenshot evidence."]
      : ["Fix simulator screenshot capture before using App Store screenshot evidence."],
  });
}

export async function createAppStorePublishPlan(appDirInput: string): Promise<AppStorePublishPlan> {
  const appDir = path.resolve(appDirInput);
  const generatedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const connect = await readJsonObject(path.join(appDir, "AppStore", "app-store-connect.json"));
  const appStore = await evaluateAppStoreReadiness(appDir);
  const moduleName = spec?.moduleName ?? "<module-name>";
  const teamId = stringOrPlaceholder(connect.teamId, "<APPLE_TEAM_ID>");
  const bundleId = spec?.bundleId ?? stringOrPlaceholder(connect.bundleId, "<BUNDLE_ID>");
  const archivePath = path.join(appDir, BUILDER_DIR, "archives", `${moduleName}.xcarchive`);
  const exportPath = path.join(appDir, BUILDER_DIR, "export");
  const exportOptionsPath = path.join(appDir, "AppStore", "ExportOptions.plist");
  const ipaPath = path.join(exportPath, `${moduleName}.ipa`);
  const actionable = appStore.readyForTestFlightUpload;
  const plan: AppStorePublishPlan = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    generatedAt,
    actionable,
    blockedGates: appStore.blockedGates,
    prerequisites: [
      "Run openclaw apps ios-validate <app-dir> --run-xcodegen --run-xcodebuild.",
      "Run openclaw apps screenshots <app-dir> and review the captured screenshot evidence.",
      "Create or link the App Store Connect app record manually before first upload.",
      "Store App Store Connect API key material outside the generated app directory.",
      "Obtain explicit human approval before uploading to TestFlight or submitting to App Review.",
    ],
    commands: [
      {
        id: "generate-project",
        purpose: "Regenerate the Xcode project from the deterministic project.yml.",
        command: "xcodegen generate",
        requiresHumanApproval: false,
      },
      {
        id: "archive",
        purpose: "Create a signed device archive for App Store distribution.",
        command: formatCommand("xcodebuild", [
          "archive",
          "-scheme",
          moduleName,
          "-destination",
          "generic/platform=iOS",
          "-archivePath",
          archivePath,
          "CODE_SIGNING_ALLOWED=YES",
          "CODE_SIGN_STYLE=Automatic",
          `DEVELOPMENT_TEAM=${teamId}`,
          `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
        ]),
        requiresHumanApproval: true,
      },
      {
        id: "export",
        purpose: "Export an IPA using the app-local ExportOptions.plist.",
        command: formatCommand("xcodebuild", [
          "-exportArchive",
          "-archivePath",
          archivePath,
          "-exportOptionsPlist",
          exportOptionsPath,
          "-exportPath",
          exportPath,
          "-allowProvisioningUpdates",
        ]),
        requiresHumanApproval: true,
      },
      {
        id: "upload-testflight",
        purpose: "Upload the exported IPA using App Store Connect JWT credentials.",
        command: formatCommand("xcrun", [
          "altool",
          "--upload-app",
          "--type",
          "ios",
          "--file",
          ipaPath,
          "--apiKey",
          "$APP_STORE_CONNECT_API_KEY_ID",
          "--apiIssuer",
          "$APP_STORE_CONNECT_ISSUER_ID",
        ]),
        requiresHumanApproval: true,
      },
    ],
    manualSteps: [
      "Confirm the App Store Connect app record, bundle id, SKU, and team id match the product spec.",
      "Complete App Store metadata, screenshots, privacy labels, age rating, export compliance, review contact, and support/privacy URLs.",
      "Wait for App Store Connect processing and TestFlight validation to finish.",
      "Run a final OpenClaw/Codex verification pass before App Review submission.",
      "Submit to App Review manually only after final human approval.",
    ],
    rollbackPlan: [
      "If a TestFlight build is bad, stop external testing for that build and remove it from tester groups.",
      "Do not submit the bad build to App Review.",
      "Increment the build number, upload a corrected build, and update the evidence ledger.",
      "If metadata is wrong before review, edit it in App Store Connect before submission.",
    ],
    notes: [
      "The App Store Connect API manages existing apps but does not create new app records or directly upload builds.",
      "Xcode/Transporter-compatible upload remains a separate human-approved release action.",
      "This plan is non-executing and must fail closed when blockedGates is non-empty.",
    ],
  };

  await writeJsonFile(path.join(appDir, BUILDER_DIR, "app-store-publish-plan.json"), plan);
  await appendEvidence(appDir, {
    at: generatedAt,
    stage: "publish-plan",
    result: actionable ? "passed" : "blocked",
    summary: actionable
      ? "Generated actionable TestFlight publish plan."
      : "Generated blocked publish plan with missing App Store gates.",
    details: { blockedGates: plan.blockedGates },
  });
  return plan;
}

export async function evaluateAppBuilderGaps(appDirInput: string): Promise<AppBuilderGapReport> {
  const appDir = path.resolve(appDirInput);
  const checkedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const packet = await readBuildPacket(appDir);
  const metadata = await readJsonObject(path.join(appDir, "AppStore", "metadata.json"));
  const appStore = await evaluateAppStoreReadiness(appDir);
  const screenshot = await readScreenshotReport(appDir);
  const publishPlan = await readPublishPlan(appDir);
  const modelReadiness = await readModelReadinessReport(appDir);
  const implementation = await readImplementationReport(appDir);
  const repair = await readRepairReport(appDir);
  const patch = await readPatchReport(appDir);
  const finalVerifier = await readFinalVerifierReport(appDir);
  const validation = await readIosValidationReport(appDir);
  const ledger = await readJsonObject(path.join(appDir, BUILDER_DIR, "evidence-ledger.json"));
  const gaps: AppBuilderGap[] = [];
  const strengths: string[] = [];

  const addGap = (gap: AppBuilderGap) => gaps.push(gap);
  const addStrength = (value: string) => strengths.push(value);

  if (spec) {
    addStrength("Product spec is present and parseable.");
    if (!isProductSpecHighSignal(spec)) {
      addGap({
        id: "product-spec-quality",
        title: "Product spec still looks generic",
        severity: "high",
        impact: 8,
        remediation:
          "Add app-specific audience, core journeys, screens, data model, acceptance criteria, and non-goals before autonomous implementation.",
      });
    }
  } else {
    addGap({
      id: "product-spec-missing",
      title: "Product spec is missing",
      severity: "critical",
      impact: 10,
      remediation: "Create the app with openclaw apps create so product-spec.json exists.",
    });
  }

  if (packet && spec) {
    const allowedRootMatches = path.resolve(packet.allowedWriteRoot) === appDir;
    if (allowedRootMatches) {
      addStrength("Build packet constrains writes to the generated app directory.");
    } else {
      addGap({
        id: "allowed-root-drift",
        title: "Build packet allowed write root drifted",
        severity: "critical",
        impact: 10,
        remediation:
          "Regenerate build-packet.json so allowedWriteRoot exactly matches the app directory.",
      });
    }
    const forbidden = packet.forbiddenActions.join("\n").toLowerCase();
    for (const required of ["outside allowedwriteroot", "plaintext secrets", "app store connect"]) {
      if (!forbidden.includes(required)) {
        addGap({
          id: `forbidden-action-${slugifyAppId(required)}`,
          title: "Build packet is missing a key forbidden action",
          severity: "critical",
          impact: 9,
          remediation: `Add a forbidden action covering ${required}.`,
        });
      }
    }
    const modelRouting = validateAppBuilderModelRouting(packet);
    if (modelRouting.ok) {
      addStrength(
        "Model routing pins Qwen Q8 for primary app-local implementation, Qwen Q6 for local fallback, and Codex for planning, repair fallback, and final verification.",
      );
    } else {
      addGap({
        id: "model-routing",
        title:
          "Builder model routing is not pinned to the approved Qwen Q8/Qwen Q6/Codex profile",
        severity: "critical",
        impact: 10,
        remediation: `Regenerate build-packet.json with the approved model profile: ${modelRouting.messages.join("; ")}.`,
      });
    }
  } else if (!packet) {
    addGap({
      id: "build-packet-missing",
      title: "Build packet is missing",
      severity: "critical",
      impact: 10,
      remediation:
        "Regenerate the app scaffold or build packet before letting an agent write code.",
    });
  }

  if (packet) {
    const missingArtifacts: string[] = [];
    for (const artifact of packet.requiredArtifacts) {
      if (!(await pathExists(path.join(appDir, artifact)))) {
        missingArtifacts.push(artifact);
      }
    }
    if (missingArtifacts.length === 0) {
      addStrength("All required build-packet artifacts are present.");
    } else {
      addGap({
        id: "required-artifacts-missing",
        title: "Required app artifacts are missing",
        severity: "critical",
        impact: 10,
        remediation: `Restore or regenerate missing artifacts: ${missingArtifacts.join(", ")}.`,
      });
    }
  }

  if (spec) {
    const projectText = await safeReadText(path.join(appDir, "project.yml"));
    const exportText = await safeReadText(path.join(appDir, "AppStore", "ExportOptions.plist"));
    if (projectText.includes(spec.moduleName) && projectText.includes(spec.bundleId)) {
      addStrength("XcodeGen project traces to module name and bundle id.");
    } else {
      addGap({
        id: "project-traceability",
        title: "Xcode project no longer traces to the product spec",
        severity: "critical",
        impact: 10,
        remediation: "Fix project.yml so module name and bundle id match product-spec.json.",
      });
    }
    if (exportText.includes(spec.bundleId) && exportText.includes("app-store-connect")) {
      addStrength("Export options are present for App Store Connect distribution.");
    } else {
      addGap({
        id: "export-options-invalid",
        title: "Export options are missing or invalid",
        severity: "high",
        impact: 8,
        remediation:
          "Restore AppStore/ExportOptions.plist with app-store-connect export method and the app bundle id.",
      });
    }
  }

  const secretHits = await scanForSecretLikeContent(appDir);
  if (secretHits.length === 0) {
    addStrength("No obvious secret-like content was found in generated app text files.");
  } else {
    addGap({
      id: "secret-like-content",
      title: "Generated app contains secret-like content",
      severity: "critical",
      impact: 10,
      remediation: `Remove secret-like content from: ${secretHits.slice(0, 5).join(", ")}.`,
    });
  }

  if (screenshot?.ready && screenshot.screenshotPath) {
    addStrength("Simulator launch and screenshot evidence are present.");
  } else {
    addGap({
      id: "screenshot-evidence",
      title: "Simulator screenshot evidence is missing",
      severity: "high",
      impact: 8,
      remediation: "Run openclaw apps screenshots <app-dir> and review the captured app UI.",
    });
  }

  if (publishPlan) {
    const dangerousUngatedCommand = publishPlan.commands.some(
      (command) =>
        /upload|archive|export/i.test(command.id) && !command.requiresHumanApproval,
    );
    if (dangerousUngatedCommand) {
      addGap({
        id: "publish-plan-approval-gates",
        title: "Publish plan has an ungated release command",
        severity: "critical",
        impact: 10,
        remediation: "Require human approval on archive, export, upload, and submit commands.",
      });
    } else {
      addStrength("Publish plan is non-executing and human-gated.");
    }
  } else {
    addGap({
      id: "publish-plan-missing",
      title: "Publish plan is missing",
      severity: "medium",
      impact: 6,
      remediation: "Run openclaw apps publish-plan <app-dir> to write release and rollback steps.",
    });
  }

  if (modelReadiness?.ready) {
    addStrength("Qwen Q8 primary and Qwen Q6 local fallback model readiness evidence is present.");
  } else {
    addGap({
      id: "model-runtime-readiness",
      title: "Qwen Q8 primary or Qwen Q6 fallback runtime evidence is missing or blocked",
      severity: "high",
      impact: 9,
      remediation:
        "Run openclaw apps model-check <app-dir> after Ollama can serve ollama/qwen3.6:27b-q8_0 and ollama/openclaw-control-qwen3-30b-q6-chatfix:latest and record their digests.",
    });
  }

  if (implementation?.ready) {
    addStrength("App-local SwiftUI implementation pass evidence is present.");
  } else {
    addGap({
      id: "implementation-pass",
      title: "App-local SwiftUI implementation pass is missing or blocked",
      severity: "high",
      impact: 9,
      remediation:
        "Run openclaw apps build <app-dir> --apply so ContentView.swift renders all product-spec screens and records implementation evidence.",
    });
  }
  const localCrudCheck = implementation?.checks.find((check) => check.id === "local-crud-scaffold");
  if (localCrudCheck?.ok) {
    addStrength("Implemented app includes local create, toggle, and delete interactions.");
  } else {
    addGap({
      id: "local-crud-scaffold",
      title: "Functional app-local CRUD scaffold is missing",
      severity: "high",
      impact: 8,
      remediation:
        "Run openclaw apps build <app-dir> --apply after updating the implementation renderer so generated screens can create, toggle, and delete local records.",
    });
  }
  const localPersistenceCheck = implementation?.checks.find((check) => check.id === "local-persistence");
  if (localPersistenceCheck?.ok) {
    addStrength("Implemented app persists local records across launches.");
  } else {
    addGap({
      id: "local-persistence",
      title: "Persistent app-local data storage is missing",
      severity: "high",
      impact: 8,
      remediation:
        "Run openclaw apps build <app-dir> --apply after updating the implementation renderer so generated records persist locally across launches.",
    });
  }
  if (repair?.ready) {
    addStrength("Repair loop evidence is present and validation passed after repair.");
  } else if (validation && !validation.readyForLocalBuild) {
    addGap({
      id: "repair-loop-evidence",
      title: "Validation failed and repair loop evidence is missing or blocked",
      severity: "high",
      impact: 9,
      remediation:
        "Run openclaw apps repair <app-dir> so failed validation gets an app-local repair pass, rerun validation, and repair-report.json evidence.",
    });
  }
  if (patch?.ready) {
    addStrength("Guarded app-local patch executor evidence is present.");
  } else {
    addGap({
      id: "guarded-patch-executor",
      title: "Guarded Qwen/Codex patch executor evidence is missing or blocked",
      severity: "high",
      impact: 9,
      remediation:
        "Run openclaw apps patch <app-dir> --plan <patch-plan.json> with an approved engine so model patch output is scope-checked, applied, validated, and recorded.",
    });
  }
  if (finalVerifier?.readyForAppReview) {
    addStrength("Final verifier evidence is present and green for App Review.");
  } else if (finalVerifier?.readyForTestFlight) {
    addStrength("Final verifier evidence is present and green for TestFlight.");
    addGap({
      id: "final-verifier-app-review",
      title: "Final verifier is blocked for App Review",
      severity: "high",
      impact: 8,
      remediation:
        "Complete all App Review evidence, then rerun openclaw apps final-verify <app-dir>.",
    });
  } else {
    addGap({
      id: "final-verifier-report",
      title: "Final verifier evidence is missing or blocked",
      severity: "high",
      impact: 9,
      remediation:
        "Run openclaw apps final-verify <app-dir> after implementation, validation, screenshot, metadata, and publish-plan evidence is available.",
    });
  }

  if (Array.isArray(ledger.events) && ledger.events.length > 0) {
    addStrength("Evidence ledger has build history.");
  } else {
    addGap({
      id: "evidence-ledger-empty",
      title: "Evidence ledger is empty",
      severity: "medium",
      impact: 6,
      remediation:
        "Regenerate or validate the app so the evidence ledger records lifecycle events.",
    });
  }

  for (const blockedGate of appStore.blockedGates) {
    const evidence = appStore.requiredEvidence.find((entry) => entry.id === blockedGate);
    addGap({
      id: `app-store-${blockedGate}`,
      title: evidence?.label ?? `Missing App Store evidence: ${blockedGate}`,
      severity: evidence && evidence.criticality >= 10 ? "critical" : "high",
      impact: evidence?.criticality ?? 8,
      remediation: evidence?.remediation ?? "Fill the missing App Store readiness evidence.",
    });
  }

  if (!stringPresent(metadata.subtitle)) {
    addGap({
      id: "metadata-subtitle",
      title: "App Store subtitle is still a placeholder",
      severity: "medium",
      impact: 5,
      remediation: "Replace the TODO subtitle with a concise product-specific App Store subtitle.",
    });
  }

  const score = Math.max(0, 10 - gaps.reduce((sum, gap) => sum + gapWeight(gap), 0));
  const report: AppBuilderGapReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    checkedAt,
    score: Number(score.toFixed(1)),
    readyForAutonomousBuild: gaps
      .filter(isAutonomousBuildBlockingGap)
      .every((gap) => !["critical", "high"].includes(gap.severity)),
    readyForPublishPlanning: publishPlan !== null && appStore.readyForTestFlightUpload,
    strengths,
    gaps: gaps.toSorted((a, b) => b.impact - a.impact || a.id.localeCompare(b.id)),
    nextActions: gaps
      .toSorted((a, b) => b.impact - a.impact || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((gap) => gap.remediation),
  };
  await writeJsonFile(path.join(appDir, BUILDER_DIR, "gap-report.json"), report);
  await appendEvidence(appDir, {
    at: checkedAt,
    stage: "gap-report",
    result: report.gaps.some((gap) => gap.severity === "critical") ? "blocked" : "passed",
    summary: `Gap report completed with score ${report.score}/10.`,
    details: {
      gapCount: report.gaps.length,
      readyForAutonomousBuild: report.readyForAutonomousBuild,
      readyForPublishPlanning: report.readyForPublishPlanning,
    },
  });
  return report;
}

export async function evaluateAppBuilderReadiness(
  appDirInput: string,
): Promise<AppBuilderReadinessReport> {
  const structuralValidation = await validateIosApp(appDirInput, { writeReport: false });
  const priorValidation = await readIosValidationReport(appDirInput);
  const validation = chooseStrongestValidationReport(structuralValidation, priorValidation);
  const appStore = await evaluateAppStoreReadiness(appDirInput);
  const gaps = await evaluateAppBuilderGaps(appDirInput);
  const readyToBuild = validation.readyForLocalBuild && gaps.readyForAutonomousBuild;
  const readyForAppStore = validation.readyForLocalBuild && appStore.readyForAppReviewSubmission;
  const next = chooseNextGap(validation, appStore, gaps);
  return {
    schemaVersion: 1,
    appId: validation.appId,
    appDir: validation.appDir,
    readyToBuild,
    readyForAppStore,
    completionGrade: next.completionGrade,
    criticalityOfNextGap: next.criticality,
    nextMostImpactfulGap: next.gap,
    why: next.why,
    validation,
    appStore,
    gaps,
  };
}

export async function evaluateAppBuilderModelReadiness(
  appDirInput: string,
  options: {
    writeReport?: boolean;
    ollamaBaseUrl?: string;
  } = {},
): Promise<AppBuilderModelReadinessReport> {
  const appDir = path.resolve(appDirInput);
  const checkedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const packet = await readBuildPacket(appDir);
  const checks: ValidationCheck[] = [];
  const baseUrl = options.ollamaBaseUrl ?? "http://127.0.0.1:11434";
  let ollamaModel: string | null = null;
  let digest: string | null = null;
  let localFallbackModel: string | null = null;
  let localFallbackDigest: string | null = null;

  checks.push({
    id: "build-packet",
    ok: packet !== null,
    severity: "critical",
    message: packet ? "Build packet is present." : "Build packet is missing.",
  });

  const routing = packet ? validateAppBuilderModelRouting(packet) : null;
  checks.push({
    id: "model-routing",
    ok: Boolean(routing?.ok),
    severity: "critical",
    message: routing?.ok
      ? "Model routing matches the approved Qwen Q8 primary, Qwen Q6 local fallback, and Codex verifier app-builder profile."
      : `Model routing is invalid: ${routing?.messages.join("; ") || "missing build packet"}.`,
  });

  if (packet) {
    ollamaModel = ollamaModelNameFromRef(packet.modelRouting.builder.modelRef);
    if (ollamaModel) {
      const availability = await checkOllamaModelAvailability(baseUrl, ollamaModel);
      digest = availability.digest;
      checks.push({
        id: "qwen-q8-primary-local",
        ok: availability.ok,
        severity: "critical",
        message: availability.message,
      });
      checks.push({
        id: "qwen-q8-primary-digest",
        ok: typeof availability.digest === "string" && availability.digest.length > 0,
        severity: "critical",
        message: availability.digest
          ? `Primary builder model digest captured: ${availability.digest}.`
          : "Primary builder model digest is missing; autonomous mutation must fail closed.",
      });
    } else {
      checks.push({
        id: "qwen-q8-primary-model-ref",
        ok: false,
        severity: "critical",
        message: "Primary builder modelRef is not an Ollama model ref.",
      });
    }

    const localFallbackProfile = packet.modelRouting.localFallback;
    localFallbackModel = isRecord(localFallbackProfile)
      ? ollamaModelNameFromRef(localFallbackProfile.modelRef ?? "")
      : null;
    if (localFallbackModel) {
      const availability = await checkOllamaModelAvailability(baseUrl, localFallbackModel);
      localFallbackDigest = availability.digest;
      checks.push({
        id: "qwen-q6-local-fallback",
        ok: availability.ok,
        severity: "critical",
        message: availability.message,
      });
      checks.push({
        id: "qwen-q6-local-fallback-digest",
        ok: typeof availability.digest === "string" && availability.digest.length > 0,
        severity: "critical",
        message: availability.digest
          ? `Local fallback model digest captured: ${availability.digest}.`
          : "Local fallback model digest is missing; fallback mutation must fail closed.",
      });
    } else {
      checks.push({
        id: "qwen-q6-local-fallback-model-ref",
        ok: false,
        severity: "critical",
        message: "Local fallback modelRef is not an Ollama model ref.",
      });
    }
  }

  const ready = checks.every((check) => check.severity !== "critical" || check.ok);
  const report: AppBuilderModelReadinessReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    checkedAt,
    ready,
    checks,
    builder: {
      modelRef: packet?.modelRouting.builder.modelRef ?? null,
      ollamaModel,
      digest,
      baseUrl,
    },
    localFallback: {
      modelRef: isRecord(packet?.modelRouting.localFallback)
        ? packet.modelRouting.localFallback.modelRef ?? ""
        : null,
      ollamaModel: localFallbackModel,
      digest: localFallbackDigest,
      baseUrl,
    },
    nextActions: ready
      ? [
          "Qwen Q8 primary builder and Qwen Q6 local fallback are ready for a future approved app-local mutation loop.",
        ]
      : checks
          .filter((check) => check.severity === "critical" && !check.ok)
          .map((check) => `${check.id}: ${check.message}`),
  };

  if (options.writeReport !== false) {
    await writeJsonFile(path.join(appDir, BUILDER_DIR, "model-readiness-report.json"), report);
    await appendEvidence(appDir, {
      at: checkedAt,
      stage: "model-check",
      result: ready ? "passed" : "blocked",
      summary: ready
        ? "Qwen Q8 primary and Qwen Q6 fallback model readiness passed."
        : "Qwen Q8 primary and Qwen Q6 fallback model readiness is blocked.",
      details: {
        modelRef: report.builder.modelRef,
        ollamaModel: report.builder.ollamaModel,
        digest: report.builder.digest,
        localFallbackModelRef: report.localFallback.modelRef,
        localFallbackOllamaModel: report.localFallback.ollamaModel,
        localFallbackDigest: report.localFallback.digest,
      },
    });
  }

  return report;
}

export async function readIosValidationReport(
  appDirInput: string,
): Promise<IosValidationReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "ios-validation-report.json"), "utf8"),
    ) as Partial<IosValidationReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.readyForLocalBuild === "boolean" &&
      Array.isArray(parsed.checks) &&
      Array.isArray(parsed.commands)
    ) {
      return parsed as IosValidationReport;
    }
  } catch {
    // Missing prior validation report is expected before the first validation run.
  }
  return null;
}

export async function readScreenshotReport(
  appDirInput: string,
): Promise<IosScreenshotReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "screenshot-report.json"), "utf8"),
    ) as Partial<IosScreenshotReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.ready === "boolean" &&
      Array.isArray(parsed.commands)
    ) {
      return parsed as IosScreenshotReport;
    }
  } catch {
    // Missing screenshot report is expected before simulator screenshot capture.
  }
  return null;
}

export async function readModelReadinessReport(
  appDirInput: string,
): Promise<AppBuilderModelReadinessReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "model-readiness-report.json"), "utf8"),
    ) as Partial<AppBuilderModelReadinessReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.ready === "boolean" &&
      Array.isArray(parsed.checks)
    ) {
      return parsed as AppBuilderModelReadinessReport;
    }
  } catch {
    // Missing model readiness report is expected before the first model-check run.
  }
  return null;
}

export async function readImplementationReport(
  appDirInput: string,
): Promise<AppBuilderImplementationReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "implementation-report.json"), "utf8"),
    ) as Partial<AppBuilderImplementationReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.ready === "boolean" &&
      Array.isArray(parsed.checks)
    ) {
      return parsed as AppBuilderImplementationReport;
    }
  } catch {
    // Missing implementation report is expected before the first implementation pass.
  }
  return null;
}

export async function readRepairReport(appDirInput: string): Promise<AppBuilderRepairReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "repair-report.json"), "utf8"),
    ) as Partial<AppBuilderRepairReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.ready === "boolean" &&
      Array.isArray(parsed.sourceChecksAfter)
    ) {
      return parsed as AppBuilderRepairReport;
    }
  } catch {
    // Missing repair report is expected before the first repair loop.
  }
  return null;
}

export async function readFinalVerifierReport(
  appDirInput: string,
): Promise<AppBuilderFinalVerifierReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "final-verifier-report.json"), "utf8"),
    ) as Partial<AppBuilderFinalVerifierReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.readyForAppReview === "boolean" &&
      Array.isArray(parsed.checks)
    ) {
      return parsed as AppBuilderFinalVerifierReport;
    }
  } catch {
    // Missing final verifier report is expected before the final release gate.
  }
  return null;
}

export async function readPatchReport(appDirInput: string): Promise<AppBuilderPatchReport | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "patch-report.json"), "utf8"),
    ) as Partial<AppBuilderPatchReport>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.ready === "boolean" &&
      Array.isArray(parsed.checks)
    ) {
      return parsed as AppBuilderPatchReport;
    }
  } catch {
    // Missing patch report is expected before the first guarded model patch pass.
  }
  return null;
}

export async function readPublishPlan(appDirInput: string): Promise<AppStorePublishPlan | null> {
  const appDir = path.resolve(appDirInput);
  try {
    const parsed = JSON.parse(
      await readFile(path.join(appDir, BUILDER_DIR, "app-store-publish-plan.json"), "utf8"),
    ) as Partial<AppStorePublishPlan>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.appDir === "string" &&
      typeof parsed.actionable === "boolean" &&
      Array.isArray(parsed.commands)
    ) {
      return parsed as AppStorePublishPlan;
    }
  } catch {
    // Missing publish plan is expected before the release plan is generated.
  }
  return null;
}

function chooseStrongestValidationReport(
  structuralValidation: IosValidationReport,
  priorValidation: IosValidationReport | null,
): IosValidationReport {
  if (!structuralValidation.readyForLocalBuild) {
    return structuralValidation;
  }
  if (priorValidation?.readyForLocalBuild && hasSuccessfulXcodebuildTest(priorValidation)) {
    return priorValidation;
  }
  return structuralValidation;
}

function hasSuccessfulXcodebuildTest(report: IosValidationReport): boolean {
  return report.commands.some(
    (command) => command.ok && command.command.startsWith("xcodebuild test "),
  );
}

export async function createBuildDryRunTask(
  appDirInput: string,
): Promise<{ taskPath: string; text: string }> {
  const appDir = path.resolve(appDirInput);
  const spec = await readProductSpec(appDir);
  const packet = await readBuildPacket(appDir);
  if (!spec || !packet) {
    throw new Error("This directory is missing app-builder product-spec/build-packet artifacts.");
  }
  const routing = validateAppBuilderModelRouting(packet);
  if (!routing.ok) {
    throw new Error(`Build packet model routing is invalid: ${routing.messages.join("; ")}`);
  }
  const taskPath = path.join(appDir, BUILDER_DIR, "builder-task.md");
  const text = `# OpenClaw App Builder Task\n\nImplement only inside this generated app directory.\n\n## App\n- Name: ${spec.appName}\n- Target: ${spec.target}\n- Bundle ID: ${spec.bundleId}\n- Request: ${spec.originalRequest}\n\n## Model Routing\n- Planner: ${formatModelProfileLine(packet.modelRouting.planner)}\n- Builder: ${formatModelProfileLine(packet.modelRouting.builder)}\n- Local fallback: ${formatModelProfileLine(packet.modelRouting.localFallback)}\n- Repair fallback: ${formatModelProfileLine(packet.modelRouting.repairFallback)}\n- Final verifier: ${formatModelProfileLine(packet.modelRouting.finalVerifier)}\n- Disabled reviewers: ${packet.modelRouting.disallowedReviewers.join(", ")}\n\n## Builder Parameters\n\`\`\`json\n${JSON.stringify(packet.modelRouting.builder.parameters, null, 2)}\n\`\`\`\n\n## Local Fallback Parameters\n\`\`\`json\n${JSON.stringify(packet.modelRouting.localFallback.parameters, null, 2)}\n\`\`\`\n\n## Runtime Preflight\n- Verify ${packet.modelRouting.builder.modelRef} is locally available before any autonomous mutation.\n- Verify ${packet.modelRouting.localFallback.modelRef} is locally available before any fallback mutation.\n- Record local Ollama model digests for both the primary builder and local fallback; fail closed if either digest cannot be captured.\n- Use the local fallback only after primary Qwen failure evidence or explicit human approval.\n- Use Codex only for planning, failed-Qwen repair planning, and final verification.\n\n## Allowed Write Root\n${packet.allowedWriteRoot}\n\n## Forbidden Actions\n${packet.forbiddenActions.map((action) => `- ${action}`).join("\n")}\n\n## Required Validation\n${packet.requiredValidationCommands.map((command) => `- \`${command}\``).join("\n")}\n\n## Acceptance Criteria\n${spec.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}\n`;
  await writeTextFile(taskPath, text);
  await appendEvidence(appDir, {
    at: new Date().toISOString(),
    stage: "build-dry-run",
    result: "created",
    summary: "Created constrained builder task prompt without mutating app code.",
  });
  return { taskPath, text };
}

async function inspectImplementationSource(
  appDir: string,
  spec: AppBuilderProductSpec,
): Promise<ValidationCheck[]> {
  const contentView = await safeReadText(path.join(appDir, "Sources", "ContentView.swift"));
  const appModels = await safeReadText(path.join(appDir, "Sources", "AppModels.swift"));
  const missingScreens = spec.screens.filter((screen) => !contentView.includes(screen.title));
  const checks: ValidationCheck[] = [
    {
      id: "screen-traceability",
      ok: missingScreens.length === 0,
      severity: "critical",
      message:
        missingScreens.length === 0
          ? "ContentView renders every product-spec screen."
          : `ContentView is missing screen titles: ${missingScreens.map((screen) => screen.title).join(", ")}.`,
    },
    {
      id: "prompt-traceability",
      ok: contentView.includes("ProductSpecSummary.originalRequest"),
      severity: "warning",
      message: contentView.includes("ProductSpecSummary.originalRequest")
        ? "ContentView exposes product-spec request traceability."
        : "ContentView does not expose product-spec request traceability.",
    },
  ];
  const hasCrudScaffold =
    appModels.includes("struct LocalDraftRecord") &&
    contentView.includes("@State private var records") &&
    contentView.includes("addRecord") &&
    contentView.includes("toggleRecord") &&
    contentView.includes("deleteRecords");
  const hasLocalPersistence =
    appModels.includes("Codable") &&
    appModels.includes("recordsStorageKey") &&
    appModels.includes("load(for features") &&
    appModels.includes("save(_ records") &&
    contentView.includes("LocalDraftRecord.load(for: AppFeature.defaults)") &&
    contentView.includes("LocalDraftRecord.save(newRecords)");
  checks.push({
    id: "local-crud-scaffold",
    ok: hasCrudScaffold,
    severity: "critical",
    message: hasCrudScaffold
      ? "ContentView includes app-local create, toggle, and delete record interactions."
      : "ContentView is missing app-local create, toggle, or delete record interactions.",
  });
  checks.push({
    id: "local-persistence",
    ok: hasLocalPersistence,
    severity: "critical",
    message: hasLocalPersistence
      ? "Generated records persist locally with UserDefaults-backed Codable storage."
      : "Generated records are not persisted locally across app launches.",
  });
  return checks;
}

export async function applyAppBuilderImplementationPass(
  appDirInput: string,
  options: { engine?: string } = {},
): Promise<AppBuilderImplementationReport> {
  const appDir = path.resolve(appDirInput);
  const generatedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const packet = await readBuildPacket(appDir);
  const checks: ValidationCheck[] = [];
  const filesChanged: string[] = [];
  const engine = options.engine ?? "deterministic-template";

  checks.push({
    id: "product-spec",
    ok: spec !== null,
    severity: "critical",
    message: spec ? "Product spec is present." : "Product spec is missing.",
  });
  checks.push({
    id: "build-packet",
    ok: packet !== null,
    severity: "critical",
    message: packet ? "Build packet is present." : "Build packet is missing.",
  });

  const writeRootOk = packet ? path.resolve(packet.allowedWriteRoot) === appDir : false;
  checks.push({
    id: "allowed-write-root",
    ok: writeRootOk,
    severity: "critical",
    message: writeRootOk
      ? "Implementation pass is constrained to the app directory."
      : "Build packet allowedWriteRoot does not match the app directory.",
  });

  const routing = packet ? validateAppBuilderModelRouting(packet) : null;
  checks.push({
    id: "model-routing",
    ok: Boolean(routing?.ok),
    severity: "critical",
    message: routing?.ok
      ? "Build packet model routing is approved."
      : `Build packet model routing is invalid: ${routing?.messages.join("; ") || "missing build packet"}.`,
  });

  if (spec && packet && writeRootOk && routing?.ok) {
    await writeTextFile(
      path.join(appDir, "Sources", "AppModels.swift"),
      renderAppBuilderModelsSwift(spec),
    );
    filesChanged.push("Sources/AppModels.swift");
    await writeTextFile(
      path.join(appDir, "Sources", "ContentView.swift"),
      renderImplementedContentViewSwift(spec),
    );
    filesChanged.push("Sources/ContentView.swift");
  }

  if (spec) {
    checks.push(...(await inspectImplementationSource(appDir, spec)));
  }

  const ready = checks.every((check) => check.severity !== "critical" || check.ok);
  const report: AppBuilderImplementationReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    generatedAt,
    engine,
    ready,
    filesChanged,
    safeguards: [
      "No dependencies installed.",
      "No secrets read or written.",
      "No network, App Store Connect, upload, publish, or submit action attempted.",
      "Only Sources/AppModels.swift and Sources/ContentView.swift are mutated.",
    ],
    checks,
    nextActions: ready
      ? [
          "Run openclaw apps ios-validate <app-dir> --run-xcodegen.",
          "Run openclaw apps ios-validate <app-dir> --run-xcodebuild when simulator validation is available.",
        ]
      : checks
          .filter((check) => check.severity === "critical" && !check.ok)
          .map((check) => `${check.id}: ${check.message}`),
  };
  await writeJsonFile(path.join(appDir, BUILDER_DIR, "implementation-report.json"), report);
  await appendEvidence(appDir, {
    at: generatedAt,
    stage: "implementation-pass",
    result: ready ? "passed" : "blocked",
    summary: ready
      ? "Applied app-local SwiftUI implementation pass."
      : "Implementation pass was blocked by app-builder safeguards.",
    details: { engine, filesChanged, ready },
  });
  return report;
}

export async function applyAppBuilderPatchPlan(
  appDirInput: string,
  plan: AppBuilderPatchPlan,
): Promise<AppBuilderPatchReport> {
  const appDir = path.resolve(appDirInput);
  const generatedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const packet = await readBuildPacket(appDir);
  const checks: ValidationCheck[] = [];
  const changedFiles: string[] = [];
  const rejectedChanges: AppBuilderPatchReport["rejectedChanges"] = [];

  checks.push({
    id: "product-spec",
    ok: spec !== null,
    severity: "critical",
    message: spec ? "Product spec is present." : "Product spec is missing.",
  });
  checks.push({
    id: "build-packet",
    ok: packet !== null,
    severity: "critical",
    message: packet ? "Build packet is present." : "Build packet is missing.",
  });
  const routing = packet ? validateAppBuilderModelRouting(packet) : null;
  checks.push({
    id: "model-routing",
    ok: Boolean(routing?.ok),
    severity: "critical",
    message: routing?.ok
      ? "Build packet model routing is approved."
      : `Build packet model routing is invalid: ${routing?.messages.join("; ") || "missing build packet"}.`,
  });
  const engineAllowed = packet ? isAllowedPatchEngine(plan.engine, packet) : false;
  checks.push({
    id: "patch-engine",
    ok: engineAllowed,
    severity: "critical",
    message: engineAllowed
      ? `Patch engine ${plan.engine} matches an approved app-builder mutation lane.`
      : `Patch engine ${plan.engine || "<missing>"} is not an approved builder or fallback lane.`,
  });
  checks.push({
    id: "patch-objective",
    ok: typeof plan.objective === "string" && plan.objective.trim().length > 0,
    severity: "critical",
    message: "Patch objective is present.",
  });
  checks.push({
    id: "patch-changes",
    ok: Array.isArray(plan.changes) && plan.changes.length > 0 && plan.changes.length <= 12,
    severity: "critical",
    message: "Patch plan includes 1-12 file changes.",
  });

  const mayApply = checks.every((check) => check.severity !== "critical" || check.ok);
  const acceptedChanges: Array<{
    change: AppBuilderPatchChange;
    relativePath: string;
    absolutePath: string;
  }> = [];
  if (mayApply) {
    for (const change of plan.changes) {
      const safety = validatePatchChange(appDir, change);
      if (!safety.ok) {
        rejectedChanges.push({ path: change.path || "<missing>", reason: safety.reason });
        continue;
      }
      const symlinkComponent = await findSymlinkPathComponent(appDir, safety.relativePath);
      if (symlinkComponent) {
        rejectedChanges.push({
          path: change.path,
          reason: `symbolic links are not patchable: ${symlinkComponent}`,
        });
        continue;
      }
      const currentText = await safeReadText(safety.absolutePath);
      const currentHash = sha256Text(currentText);
      if (change.oldContentSha256 && change.oldContentSha256 !== currentHash) {
        rejectedChanges.push({
          path: change.path,
          reason: "oldContentSha256 did not match the current file content",
        });
        continue;
      }
      acceptedChanges.push({
        change,
        relativePath: safety.relativePath,
        absolutePath: safety.absolutePath,
      });
    }

    if (rejectedChanges.length === 0) {
      for (const accepted of acceptedChanges) {
        await writeTextFile(accepted.absolutePath, accepted.change.contents);
        changedFiles.push(accepted.relativePath);
      }
    }
  }

  checks.push({
    id: "patch-scope",
    ok: rejectedChanges.length === 0 && mayApply,
    severity: "critical",
    message:
      rejectedChanges.length === 0 && mayApply
        ? "All patch changes stayed inside the approved app-local mutation scope."
        : "One or more patch changes were rejected by app-builder safeguards.",
  });

  const validationAfter = await validateIosApp(appDir, {
    runXcodegen: plan.validation?.runXcodegen,
    runXcodebuild: plan.validation?.runXcodebuild,
    simulator: plan.validation?.simulator,
    checkToolchain: plan.validation?.checkToolchain,
    writeReport: true,
  });
  const sourceChecks = spec ? await inspectImplementationSource(appDir, spec) : [];
  checks.push(...sourceChecks);
  const ready =
    checks.every((check) => check.severity !== "critical" || check.ok) &&
    changedFiles.length > 0 &&
    validationAfter.readyForLocalBuild;
  const transcriptPath = path.join(appDir, BUILDER_DIR, "patch-transcript.json");
  await writeJsonFile(transcriptPath, {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    generatedAt,
    engine: plan.engine,
    objective: plan.objective,
    plan,
    changedFiles,
    rejectedChanges,
    validationAfter: {
      readyForLocalBuild: validationAfter.readyForLocalBuild,
      checks: validationAfter.checks,
      commands: validationAfter.commands,
    },
  });
  const report: AppBuilderPatchReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    generatedAt,
    engine: plan.engine,
    objective: plan.objective,
    ready,
    applied: changedFiles.length > 0,
    changedFiles,
    rejectedChanges,
    checks,
    validationAfter,
    transcriptPath,
    safeguards: [
      "No dependencies installed.",
      "No secrets read or written.",
      "No network, App Store Connect, upload, publish, or submit action attempted.",
      "Patch writes are restricted to app-local Sources, Tests, AppStore metadata, Privacy, and README files.",
      "Patch plans from unapproved engines or stale oldContentSha256 values fail closed.",
    ],
    nextActions: ready
      ? ["Run openclaw apps final-verify <app-dir> after screenshot and App Store evidence are complete."]
      : [
          ...checks
            .filter((check) => check.severity === "critical" && !check.ok)
            .map((check) => `${check.id}: ${check.message}`),
          ...validationAfter.nextActions,
        ],
  };
  await writeJsonFile(path.join(appDir, BUILDER_DIR, "patch-report.json"), report);
  await appendEvidence(appDir, {
    at: generatedAt,
    stage: "patch-executor",
    result: ready ? "passed" : "blocked",
    summary: ready
      ? `Applied ${changedFiles.length} guarded app-local patch change(s).`
      : "Guarded app-local patch executor was blocked.",
    details: {
      engine: plan.engine,
      objective: plan.objective,
      changedFiles,
      rejectedChanges,
      ready,
    },
  });
  return report;
}

export async function repairIosApp(
  appDirInput: string,
  options: {
    engine?: string;
    runXcodegen?: boolean;
    runXcodebuild?: boolean;
    simulator?: string;
    checkToolchain?: boolean;
    force?: boolean;
  } = {},
): Promise<AppBuilderRepairReport> {
  const appDir = path.resolve(appDirInput);
  const generatedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const engine = options.engine ?? "deterministic-template-repair";
  const validationOptions = {
    runXcodegen: options.runXcodegen,
    runXcodebuild: options.runXcodebuild,
    simulator: options.simulator,
    checkToolchain: options.checkToolchain,
  };
  const validationBefore = await validateIosApp(appDir, {
    ...validationOptions,
    writeReport: false,
  });
  const sourceChecksBefore = spec
    ? await inspectImplementationSource(appDir, spec)
    : [
        {
          id: "product-spec",
          ok: false,
          severity: "critical" as const,
          message: "Product spec is missing, so the repair loop cannot regenerate app code.",
        },
      ];
  const priorImplementation = await readImplementationReport(appDir);
  const needsRepair =
    options.force === true ||
    !validationBefore.readyForLocalBuild ||
    priorImplementation?.ready !== true ||
    sourceChecksBefore.some((check) => check.severity === "critical" && !check.ok);
  const implementation = needsRepair
    ? await applyAppBuilderImplementationPass(appDir, { engine })
    : priorImplementation;
  const validationAfter = await validateIosApp(appDir, {
    ...validationOptions,
    writeReport: true,
  });
  const sourceChecksAfter = spec
    ? await inspectImplementationSource(appDir, spec)
    : sourceChecksBefore;
  const sourceReady = sourceChecksAfter.every((check) => check.severity !== "critical" || check.ok);
  const ready = validationAfter.readyForLocalBuild && sourceReady && (implementation?.ready ?? false);
  const report: AppBuilderRepairReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    generatedAt,
    engine,
    repaired: needsRepair,
    ready,
    sourceChecksBefore,
    sourceChecksAfter,
    validationBefore,
    validationAfter,
    implementation,
    safeguards: [
      "No dependencies installed.",
      "No secrets read or written.",
      "No network, App Store Connect, upload, publish, or submit action attempted.",
      "Repair is constrained to the generated app directory and delegates code mutation to the app-local implementation pass.",
    ],
    nextActions: ready
      ? ["Run openclaw apps ready <app-dir> or continue with screenshot/App Store evidence gates."]
      : [
          ...sourceChecksAfter
            .filter((check) => check.severity === "critical" && !check.ok)
            .map((check) => `${check.id}: ${check.message}`),
          ...validationAfter.nextActions,
        ],
  };
  await writeJsonFile(path.join(appDir, BUILDER_DIR, "repair-report.json"), report);
  await appendEvidence(appDir, {
    at: generatedAt,
    stage: "repair-loop",
    result: ready ? "passed" : "blocked",
    summary: ready
      ? "Repair loop completed and validation passed."
      : "Repair loop completed but validation is still blocked.",
    details: {
      engine,
      repaired: needsRepair,
      ready,
      runXcodegen: Boolean(options.runXcodegen),
      runXcodebuild: Boolean(options.runXcodebuild),
    },
  });
  return report;
}

export async function createAppBuilderFinalVerifierReport(
  appDirInput: string,
  options: { requireXcodebuild?: boolean; checkToolchain?: boolean } = {},
): Promise<AppBuilderFinalVerifierReport> {
  const appDir = path.resolve(appDirInput);
  const generatedAt = new Date().toISOString();
  const spec = await readProductSpec(appDir);
  const packet = await readBuildPacket(appDir);
  const structuralValidation = await validateIosApp(appDir, {
    checkToolchain: options.checkToolchain,
    writeReport: false,
  });
  const priorValidation = await readIosValidationReport(appDir);
  const validation = chooseStrongestValidationReport(structuralValidation, priorValidation);
  const implementation = await readImplementationReport(appDir);
  const repair = await readRepairReport(appDir);
  const screenshot = await readScreenshotReport(appDir);
  const appStore = await evaluateAppStoreReadiness(appDir);
  const publishPlan = await readPublishPlan(appDir);
  const modelReadiness = await readModelReadinessReport(appDir);
  const secretHits = await scanForSecretLikeContent(appDir);
  const routing = packet ? validateAppBuilderModelRouting(packet) : null;
  const verifier = packet?.modelRouting.finalVerifier ?? null;
  const requireXcodebuild = options.requireXcodebuild !== false;
  const xcodebuildTested = hasSuccessfulXcodebuildTest(validation);
  const publishPlanHumanGated =
    publishPlan !== null &&
    publishPlan.commands.every((command) =>
      /archive|export|upload|submit/i.test(command.id) ? command.requiresHumanApproval : true,
    );
  const localCrudReady =
    implementation?.checks.find((check) => check.id === "local-crud-scaffold")?.ok === true;
  const localPersistenceReady =
    implementation?.checks.find((check) => check.id === "local-persistence")?.ok === true;
  const checks: ValidationCheck[] = [
    {
      id: "product-spec",
      ok: spec !== null,
      severity: "critical",
      message: spec ? "Product spec is present." : "Product spec is missing.",
    },
    {
      id: "build-packet",
      ok: packet !== null,
      severity: "critical",
      message: packet ? "Build packet is present." : "Build packet is missing.",
    },
    {
      id: "final-verifier-profile",
      ok: Boolean(routing?.ok && verifier?.runtime === "codex" && verifier.reasoningEffort === "xhigh"),
      severity: "critical",
      message:
        routing?.ok && verifier?.runtime === "codex" && verifier.reasoningEffort === "xhigh"
          ? "Final verifier is pinned to the approved Codex xhigh verifier profile."
          : `Final verifier routing is invalid: ${routing?.messages.join("; ") || "missing build packet"}.`,
    },
    {
      id: "implementation",
      ok: implementation?.ready === true,
      severity: "critical",
      message:
        implementation?.ready === true
          ? "Implementation evidence is ready."
          : "Implementation evidence is missing or blocked.",
    },
    {
      id: "local-crud-scaffold",
      ok: localCrudReady,
      severity: "critical",
      message: localCrudReady
        ? "Generated app includes local create, toggle, and delete interactions."
        : "Generated app is missing local create, toggle, or delete implementation evidence.",
    },
    {
      id: "local-persistence",
      ok: localPersistenceReady,
      severity: "critical",
      message: localPersistenceReady
        ? "Generated app persists local records across launches."
        : "Generated app is missing persistent local record storage evidence.",
    },
    {
      id: "local-validation",
      ok: validation.readyForLocalBuild,
      severity: "critical",
      message: validation.readyForLocalBuild
        ? "Local iOS validation is ready."
        : "Local iOS validation is blocked.",
    },
    {
      id: "xcodebuild-test",
      ok: !requireXcodebuild || xcodebuildTested,
      severity: "critical",
      message:
        !requireXcodebuild || xcodebuildTested
          ? "xcodebuild simulator test evidence is present."
          : "xcodebuild simulator test evidence is required before final verification can pass.",
    },
    {
      id: "model-readiness",
      ok: modelReadiness?.ready === true,
      severity: "critical",
      message:
        modelReadiness?.ready === true
          ? "Pinned Qwen primary and fallback model readiness evidence is present."
          : "Pinned Qwen primary/fallback model readiness evidence is missing or blocked.",
    },
    {
      id: "publish-plan",
      ok: publishPlan?.actionable === true,
      severity: "critical",
      message:
        publishPlan?.actionable === true
          ? "Publish plan is actionable."
          : "Publish plan is missing or blocked.",
    },
    {
      id: "publish-plan-human-gated",
      ok: publishPlanHumanGated,
      severity: "critical",
      message: publishPlanHumanGated
        ? "Archive, export, upload, and submit commands remain human-gated."
        : "Publish plan has missing or ungated release commands.",
    },
    {
      id: "testflight-evidence",
      ok: appStore.readyForTestFlightUpload,
      severity: "critical",
      message: appStore.readyForTestFlightUpload
        ? "App Store Connect, signing, SKU, team, and API profile evidence supports TestFlight upload."
        : "TestFlight upload evidence is incomplete.",
    },
    {
      id: "screenshot-evidence",
      ok: screenshot?.ready === true && Boolean(screenshot.screenshotPath),
      severity: "warning",
      message:
        screenshot?.ready === true && screenshot.screenshotPath
          ? "Simulator screenshot evidence is present."
          : "Simulator screenshot evidence is missing.",
    },
    {
      id: "app-review-evidence",
      ok: appStore.readyForAppReviewSubmission,
      severity: "warning",
      message: appStore.readyForAppReviewSubmission
        ? "App Review metadata, privacy, screenshots, and review evidence are complete."
        : "App Review evidence is incomplete.",
    },
    {
      id: "secret-scan",
      ok: secretHits.length === 0,
      severity: "critical",
      message:
        secretHits.length === 0
          ? "No obvious secret-like content was found in generated app text files."
          : `Secret-like content found in ${secretHits.slice(0, 5).join(", ")}.`,
    },
  ];
  const testFlightCriticalIds = new Set([
    "product-spec",
    "build-packet",
    "final-verifier-profile",
    "implementation",
    "local-crud-scaffold",
    "local-persistence",
    "local-validation",
    "xcodebuild-test",
    "model-readiness",
    "publish-plan",
    "publish-plan-human-gated",
    "testflight-evidence",
    "secret-scan",
  ]);
  const readyForTestFlight = checks
    .filter((check) => testFlightCriticalIds.has(check.id))
    .every((check) => check.ok);
  const readyForAppReview =
    readyForTestFlight &&
    checks.find((check) => check.id === "screenshot-evidence")?.ok === true &&
    checks.find((check) => check.id === "app-review-evidence")?.ok === true;
  const blockedGates = checks.filter((check) => !check.ok).map((check) => check.id);
  const report: AppBuilderFinalVerifierReport = {
    schemaVersion: 1,
    appId: spec?.appId ?? null,
    appDir,
    generatedAt,
    verifier,
    readyForTestFlight,
    readyForAppReview,
    checks,
    blockedGates,
    evidence: {
      validationReady: validation.readyForLocalBuild,
      xcodebuildTested,
      implementationReady: implementation?.ready === true,
      repairReady: repair ? repair.ready : null,
      screenshotReady: screenshot?.ready === true && Boolean(screenshot.screenshotPath),
      appStoreReadyForTestFlight: appStore.readyForTestFlightUpload,
      appStoreReadyForAppReview: appStore.readyForAppReviewSubmission,
      publishPlanActionable: publishPlan?.actionable === true,
      modelReadinessReady: modelReadiness?.ready === true,
      secretHits,
    },
    safeguards: [
      "Final verification is evidence-only and does not mutate app source.",
      "No dependencies installed.",
      "No secrets read or written.",
      "No network, App Store Connect, upload, publish, or submit action attempted.",
      "Archive, export, upload, and submit commands must remain human-approved.",
    ],
    nextActions:
      blockedGates.length === 0
        ? ["Proceed only after final human owner approval for TestFlight/App Review actions."]
        : checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.message}`),
  };
  await writeJsonFile(path.join(appDir, BUILDER_DIR, "final-verifier-report.json"), report);
  await appendEvidence(appDir, {
    at: generatedAt,
    stage: "final-verifier",
    result: readyForAppReview ? "passed" : "blocked",
    summary: readyForAppReview
      ? "Final verifier evidence is green for App Review."
      : readyForTestFlight
        ? "Final verifier evidence is green for TestFlight but blocked for App Review."
        : "Final verifier evidence is blocked.",
    details: { readyForTestFlight, readyForAppReview, blockedGates },
  });
  return report;
}

export async function checkIosToolchain(): Promise<{
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
}> {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  for (const tool of ["xcodebuild", "xcrun", "xcodegen"]) {
    const result = await runCommand(
      tool,
      tool === "xcrun"
        ? ["simctl", "list", "devices", "available"]
        : tool === "xcodebuild"
          ? ["-version"]
          : ["--version"],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
      },
    );
    checks.push({
      id: tool,
      ok: result.ok,
      detail: result.ok
        ? trimTail(result.stdoutTail || result.stderrTail, 300)
        : trimTail(result.stderrTail || result.stdoutTail, 300),
    });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

function buildProductSpec(params: {
  appId: string;
  appName: string;
  moduleName: string;
  bundleId: string;
  request: string;
  now: Date;
}): AppBuilderProductSpec {
  const request = params.request.trim();
  const blueprint = inferProductBlueprint(request, params.appName);
  return {
    schemaVersion: 1,
    templateVersion: TEMPLATE_VERSION,
    target: "ios-native",
    appId: params.appId,
    appName: params.appName,
    moduleName: params.moduleName,
    bundleId: params.bundleId,
    originalRequest: request,
    platform: {
      kind: "ios-native",
      minimumIOS: "18.0",
      swiftVersion: "6.0",
      appStoreOnly: true,
    },
    goal: request || `Create ${params.appName} as a polished App Store-ready iOS app.`,
    audience: blueprint.audience,
    appleCategory: blueprint.appleCategory,
    coreUserJourneys: blueprint.coreUserJourneys,
    screens: blueprint.screens,
    screenFlow: createDefaultAppBuilderScreenFlow(blueprint.screens),
    dataModel: blueprint.dataModel,
    permissions: blueprint.permissions,
    privacyPosture: {
      collectsPersonalData: false,
      tracking: false,
      networkAccess: false,
      notes: blueprint.privacyNotes,
    },
    monetization: "Free by default until the product spec explicitly adds monetization.",
    offlineBehavior: "Core scaffold works offline with local sample data.",
    integrations: [],
    acceptanceCriteria: blueprint.acceptanceCriteria,
    nonGoals: [
      "Do not upload, publish, or submit to App Store Connect automatically.",
      "Do not install dependencies, write secrets, or edit OpenClaw core from the generated app builder loop.",
    ],
    unresolvedQuestions: blueprint.unresolvedQuestions,
    createdAt: params.now.toISOString(),
  };
}

function inferProductBlueprint(request: string, appName: string): ProductBlueprint {
  const normalized = request.toLowerCase();
  if (/focus|timer|pomodoro|session|streak|reminder/.test(normalized)) {
    return {
      audience:
        "People who want a calm, privacy-first way to run focus sessions and review streaks without creating an account.",
      appleCategory: "Productivity",
      coreUserJourneys: [
        "Start, pause, and complete a focus session from the timer screen.",
        "Review recent focus sessions, streak progress, and completion notes.",
        "Set lightweight reminder preferences while keeping all history on device.",
        "Open privacy settings and confirm that the scaffold uses no tracking or network services.",
      ],
      screens: [
        {
          id: "timer",
          title: "Timer",
          purpose: "Start, pause, and complete focus sessions with clear progress feedback.",
        },
        {
          id: "sessions",
          title: "Sessions",
          purpose: "Review local focus history, session notes, durations, and streak progress.",
        },
        {
          id: "reminders",
          title: "Reminders",
          purpose: "Plan optional local reminder preferences without account setup.",
        },
        {
          id: "settings",
          title: "Settings",
          purpose: "Review privacy posture, export notes, and App Store readiness status.",
        },
      ],
      dataModel: [
        {
          name: "FocusSession",
          purpose: "Local record of each completed or planned focus session.",
          fields: ["id", "title", "durationMinutes", "startedAt", "completedAt", "notes"],
        },
        {
          name: "FocusStreak",
          purpose: "Derived local summary of consecutive focus days and weekly progress.",
          fields: ["currentCount", "bestCount", "lastCompletedDate", "weeklyCompletedMinutes"],
        },
      ],
      permissions: [
        {
          permission: "Notifications",
          reason: "Only needed if the user enables local focus reminders.",
          required: false,
        },
      ],
      privacyNotes: [
        "Focus sessions, streaks, and reminder preferences stay local in the generated scaffold.",
        "No account, analytics, tracking, or network sync is enabled by default.",
        "If push notifications, cloud sync, analytics, or AI features are added later, privacy evidence must be updated before App Store submission.",
      ],
      acceptanceCriteria: [
        "The generated iOS project can be regenerated with XcodeGen.",
        "The SwiftUI app launches in the iOS simulator without requiring secrets or network access.",
        "The timer, sessions, reminders, and settings surfaces are represented in app-local SwiftUI code.",
        "Generated tests pass before App Store readiness can be claimed.",
        "App Store submission remains blocked until signing, metadata, privacy, screenshot, and human approval evidence exists.",
      ],
      unresolvedQuestions: [
        "Final timer durations, reminder defaults, and whether reminders should request notification permission.",
        "Final app icon, branded screenshots, and App Store marketing copy.",
        "App Store Connect app record, SKU, team, signing profile, and review metadata.",
      ],
    };
  }
  if (/meal|recipe|grocery|nutrition|food/.test(normalized)) {
    return {
      audience:
        "Households and solo planners who want local meal plans, recipe ideas, and grocery organization without an account.",
      appleCategory: "Food & Drink",
      coreUserJourneys: [
        "Plan meals for the week from a simple calendar-like surface.",
        "Save recipe ideas with ingredients, prep notes, and meal tags.",
        "Convert planned meals into a local grocery checklist.",
        "Review privacy settings and confirm no network or tracking is enabled by default.",
      ],
      screens: [
        {
          id: "plan",
          title: "Plan",
          purpose: "Build a weekly meal plan with breakfast, lunch, dinner, and snack slots.",
        },
        {
          id: "recipes",
          title: "Recipes",
          purpose: "Save local recipe ideas, ingredients, prep steps, and tags.",
        },
        {
          id: "groceries",
          title: "Groceries",
          purpose: "Review a grocery checklist generated from planned meals.",
        },
        {
          id: "settings",
          title: "Settings",
          purpose: "Review privacy posture, export notes, and App Store readiness status.",
        },
      ],
      dataModel: [
        {
          name: "MealPlanEntry",
          purpose: "Local meal plan item assigned to a date and meal slot.",
          fields: ["id", "date", "mealSlot", "recipeTitle", "notes", "isPrepared"],
        },
        {
          name: "GroceryItem",
          purpose: "Local checklist item for planned meals.",
          fields: ["id", "name", "category", "quantity", "isChecked"],
        },
      ],
      permissions: [
        {
          permission: "None by default",
          reason: "Meal planning scaffold works offline with local data.",
          required: false,
        },
      ],
      privacyNotes: [
        "Meal plans, recipes, and grocery lists stay local in the generated scaffold.",
        "No account, analytics, tracking, health data, or network sync is enabled by default.",
        "If nutrition APIs, cloud sync, HealthKit, or account features are added later, privacy evidence must be updated before App Store submission.",
      ],
      acceptanceCriteria: [
        "The generated iOS project can be regenerated with XcodeGen.",
        "The SwiftUI app launches in the iOS simulator without requiring secrets or network access.",
        "The plan, recipes, groceries, and settings surfaces are represented in app-local SwiftUI code.",
        "Generated tests pass before App Store readiness can be claimed.",
        "App Store submission remains blocked until signing, metadata, privacy, screenshot, and human approval evidence exists.",
      ],
      unresolvedQuestions: [
        "Final nutrition claims, dietary filters, and whether external recipe sources are allowed.",
        "Final app icon, branded screenshots, and App Store marketing copy.",
        "App Store Connect app record, SKU, team, signing profile, and review metadata.",
      ],
    };
  }
  if (/habit|routine|goal|streak/.test(normalized)) {
    return {
      audience:
        "People building repeatable routines who want a private habit tracker with fast daily check-ins.",
      appleCategory: "Productivity",
      coreUserJourneys: [
        "Create a local habit and choose a simple schedule.",
        "Check off today's habits with minimal taps.",
        "Review streaks, completion history, and missed days.",
        "Review privacy settings and confirm no tracking or account is required.",
      ],
      screens: [
        {
          id: "today",
          title: "Today",
          purpose: "Complete daily habit check-ins and see current momentum.",
        },
        {
          id: "habits",
          title: "Habits",
          purpose: "Create and organize local habits, routines, and schedules.",
        },
        {
          id: "streaks",
          title: "Streaks",
          purpose: "Review completion history, streaks, and weekly progress.",
        },
        {
          id: "settings",
          title: "Settings",
          purpose: "Review privacy posture, export notes, and App Store readiness status.",
        },
      ],
      dataModel: [
        {
          name: "Habit",
          purpose: "Local habit definition and schedule.",
          fields: ["id", "title", "schedule", "createdAt", "isArchived"],
        },
        {
          name: "HabitCheckIn",
          purpose: "Local completion record for one habit on one day.",
          fields: ["id", "habitId", "date", "completedAt", "note"],
        },
      ],
      permissions: [
        {
          permission: "Notifications",
          reason: "Only needed if the user enables habit reminders.",
          required: false,
        },
      ],
      privacyNotes: [
        "Habit definitions and check-ins stay local in the generated scaffold.",
        "No account, analytics, tracking, or network sync is enabled by default.",
        "If reminders, cloud sync, analytics, or coaching APIs are added later, privacy evidence must be updated before App Store submission.",
      ],
      acceptanceCriteria: [
        "The generated iOS project can be regenerated with XcodeGen.",
        "The SwiftUI app launches in the iOS simulator without requiring secrets or network access.",
        "The today, habits, streaks, and settings surfaces are represented in app-local SwiftUI code.",
        "Generated tests pass before App Store readiness can be claimed.",
        "App Store submission remains blocked until signing, metadata, privacy, screenshot, and human approval evidence exists.",
      ],
      unresolvedQuestions: [
        "Final habit scheduling model, reminder defaults, and streak rules.",
        "Final app icon, branded screenshots, and App Store marketing copy.",
        "App Store Connect app record, SKU, team, signing profile, and review metadata.",
      ],
    };
  }
  return {
    audience: `People who want ${appName} to solve the requested workflow privately on iPhone and iPad without mandatory account setup.`,
    appleCategory: "Productivity",
    coreUserJourneys: [
      `Open ${appName} and see the primary workflow requested by the user.`,
      "Create or review local records that support the app's core task.",
      "Use an insights surface to understand recent local activity.",
      "Review privacy settings and confirm no tracking or network access is enabled by default.",
    ],
    screens: [
      {
        id: "dashboard",
        title: "Dashboard",
        purpose: `Guide the user through ${appName}'s requested primary workflow.`,
      },
      {
        id: "records",
        title: "Records",
        purpose: "Create, review, and organize local app records.",
      },
      {
        id: "insights",
        title: "Insights",
        purpose: "Summarize recent local activity and progress.",
      },
      {
        id: "settings",
        title: "Settings",
        purpose: "Review privacy posture, export notes, and App Store readiness status.",
      },
    ],
    dataModel: [
      {
        name: "LocalRecord",
        purpose: "App-local record for the requested workflow.",
        fields: ["id", "title", "detail", "createdAt", "updatedAt", "isArchived"],
      },
    ],
    permissions: [
      {
        permission: "None by default",
        reason: "The generated scaffold must launch without sensitive permissions.",
        required: false,
      },
    ],
    privacyNotes: [
      "Generated scaffold stores user-created records locally only.",
      "No account, analytics, tracking, or network sync is enabled by default.",
      "Any future permission, account, analytics, network, or tracking feature must update privacy evidence before App Store submission.",
    ],
    acceptanceCriteria: [
      "The generated iOS project can be regenerated with XcodeGen.",
      "The SwiftUI app launches in the iOS simulator without requiring secrets or network access.",
      "The dashboard, records, insights, and settings surfaces are represented in app-local SwiftUI code.",
      "Generated tests pass before App Store readiness can be claimed.",
      "App Store submission remains blocked until signing, metadata, privacy, screenshot, and human approval evidence exists.",
    ],
    unresolvedQuestions: [
      "Final workflow-specific copy, data fields, and user interaction details.",
      "Final app icon, branded screenshots, and App Store marketing copy.",
      "App Store Connect app record, SKU, team, signing profile, and review metadata.",
    ],
  };
}

function buildAppBuildPacket(params: {
  appDir: string;
  spec: AppBuilderProductSpec;
}): AppBuildPacket {
  return {
    schemaVersion: 1,
    appId: params.spec.appId,
    appDir: params.appDir,
    target: params.spec.target,
    acceptedRequest: params.spec.originalRequest,
    allowedWriteRoot: params.appDir,
    forbiddenActions: [
      "Do not edit files outside allowedWriteRoot.",
      "Do not install dependencies or run package managers.",
      "Do not read or write plaintext secrets.",
      "Do not contact App Store Connect.",
      "Do not upload, publish, submit for review, or change signing assets.",
      "Do not modify OpenClaw source, config, or plugins from this app task.",
    ],
    requiredArtifacts: [
      `${BUILDER_DIR}/product-spec.json`,
      `${BUILDER_DIR}/build-packet.json`,
      `${BUILDER_DIR}/evidence-ledger.json`,
      "project.yml",
      "Sources/AppMain.swift",
      "Sources/ContentView.swift",
      "Sources/PrivacyInfo.xcprivacy",
      "Tests/GeneratedAppTests.swift",
      "AppStore/metadata.json",
      "AppStore/ExportOptions.plist",
    ],
    requiredValidationCommands: [
      "openclaw apps model-check <app-dir>",
      "openclaw apps ios-validate <app-dir> --run-xcodegen",
      "openclaw apps ios-validate <app-dir> --run-xcodebuild",
      "openclaw apps screenshots <app-dir>",
      "openclaw apps app-store-ready <app-dir>",
      "openclaw apps publish-plan <app-dir>",
    ],
    approvalGates: [
      {
        id: "dependency-approval",
        requiredBefore: "adding third-party dependencies",
        status: "blocked",
      },
      { id: "runtime-approval", requiredBefore: "executing generated app code", status: "blocked" },
      { id: "testflight-approval", requiredBefore: "uploading to TestFlight", status: "blocked" },
      { id: "app-review-approval", requiredBefore: "submitting to App Review", status: "blocked" },
    ],
    modelRouting: buildAppBuilderModelRouting(),
    riskSignals: [
      "Generated code is untrusted until validation passes.",
      "App Store actions require explicit human approval and complete evidence.",
      "No dependency installation is performed by this scaffold command.",
    ],
  };
}

function buildAppBuilderModelRouting(): AppBuilderModelRouting {
  return {
    planner: {
      role: "planner",
      provider: "openai",
      modelRef: APP_BUILDER_PLANNER_MODEL_REF,
      runtime: "codex",
      authProvider: "openai-codex",
      modelFamily: "GPT-5.5",
      quantization: null,
      reasoningEffort: "high",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      parameters: null,
      requiresLocalAvailability: false,
      requiresModelDigestBeforeMutation: false,
      digest: null,
      failClosedIfUnavailable: true,
      purpose: "Create the product plan, app spec, and implementation strategy before local code generation begins.",
      mutationPolicy: "planning-only; no file mutation from planner output without a build packet",
      requiredBefore: ["scaffold", "builder-task"],
      allowedWhen: ["always"],
    },
    builder: {
      role: "builder",
      provider: "ollama",
      modelRef: APP_BUILDER_BUILDER_MODEL_REF,
      runtime: "ollama-native",
      authProvider: "ollama",
      modelFamily: "Qwen3.6 27B",
      quantization: "Q8_0",
      reasoningEffort: null,
      contextWindowTokens: APP_BUILDER_QWEN_PARAMS.numCtx,
      maxOutputTokens: APP_BUILDER_QWEN_PARAMS.numPredict,
      parameters: { ...APP_BUILDER_QWEN_PARAMS },
      requiresLocalAvailability: true,
      requiresModelDigestBeforeMutation: true,
      digest: null,
      failClosedIfUnavailable: true,
      purpose: "Perform app-local SwiftUI implementation attempts inside allowedWriteRoot only.",
      mutationPolicy:
        "may edit generated app files only after scope/runtime approval; no dependencies, secrets, OpenClaw core edits, App Store Connect, upload, publish, or submit",
      requiredBefore: ["autonomous-code-mutation"],
      allowedWhen: ["product-spec-present", "build-packet-valid", "allowed-write-root-valid"],
    },
    localFallback: {
      role: "local-fallback",
      provider: "ollama",
      modelRef: APP_BUILDER_LOCAL_FALLBACK_MODEL_REF,
      runtime: "ollama-native",
      authProvider: "ollama",
      modelFamily: "Qwen3 30.5B",
      quantization: "Q6_K",
      reasoningEffort: null,
      contextWindowTokens: APP_BUILDER_QWEN_PARAMS.numCtx,
      maxOutputTokens: APP_BUILDER_QWEN_PARAMS.numPredict,
      parameters: { ...APP_BUILDER_QWEN_PARAMS },
      requiresLocalAvailability: true,
      requiresModelDigestBeforeMutation: true,
      digest: null,
      failClosedIfUnavailable: true,
      purpose:
        "Provide a stable local app-dir-only fallback when the primary Qwen3.6 Q8 coder fails validation or is unavailable.",
      mutationPolicy:
        "may be used only after primary-builder failure evidence; same app-dir-only, no-dependency, no-secret, no-publish constraints as builder",
      requiredBefore: ["local-qwen-fallback-mutation"],
      allowedWhen: [
        "primary-qwen-unavailable",
        "primary-qwen-attempt-failed-validation",
        "human-approved-local-fallback",
      ],
    },
    repairFallback: {
      role: "repair-fallback",
      provider: "openai",
      modelRef: APP_BUILDER_VERIFIER_MODEL_REF,
      runtime: "codex",
      authProvider: "openai-codex",
      modelFamily: "GPT-5.5",
      quantization: null,
      reasoningEffort: "high",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      parameters: null,
      requiresLocalAvailability: false,
      requiresModelDigestBeforeMutation: false,
      digest: null,
      failClosedIfUnavailable: true,
      purpose: "Plan repairs or review failed Qwen attempts when local validation evidence shows a concrete failure.",
      mutationPolicy:
        "repair planning and explicitly approved app-dir-only patch review; never silent broad mutation",
      requiredBefore: ["qwen-fallback-repair"],
      allowedWhen: ["qwen-unavailable", "qwen-attempt-failed-validation", "human-approved-fallback"],
    },
    finalVerifier: {
      role: "final-verifier",
      provider: "openai",
      modelRef: APP_BUILDER_VERIFIER_MODEL_REF,
      runtime: "codex",
      authProvider: "openai-codex",
      modelFamily: "GPT-5.5",
      quantization: null,
      reasoningEffort: "xhigh",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      parameters: null,
      requiresLocalAvailability: false,
      requiresModelDigestBeforeMutation: false,
      digest: null,
      failClosedIfUnavailable: true,
      purpose: "Perform the final correctness, safety, privacy, App Store, and validation-evidence review before publishing.",
      mutationPolicy: "verification-only unless a new human-approved repair cycle is opened",
      requiredBefore: ["testflight-upload", "app-review-submission"],
      allowedWhen: ["local-validation-passed", "app-store-evidence-complete"],
    },
    disallowedReviewers: ["claude", "gemini"],
  };
}

async function assertWritableTarget(appDir: string, force: boolean): Promise<void> {
  const entries = await listFiles(appDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Refusing to write into non-empty app directory: ${appDir}. Pass --force to overwrite scaffold-owned files.`,
    );
  }
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendEvidence(appDir: string, event: EvidenceLedgerEvent): Promise<void> {
  const ledgerPath = path.join(appDir, BUILDER_DIR, "evidence-ledger.json");
  const existing = await readJsonObject(ledgerPath);
  const events = Array.isArray(existing.events) ? existing.events : [];
  await writeJsonFile(ledgerPath, {
    schemaVersion: 1,
    appId: typeof existing.appId === "string" ? existing.appId : null,
    events: [...events, event],
  });
}

async function finishScreenshotReport(params: {
  appDir: string;
  checkedAt: string;
  spec: AppBuilderProductSpec | null;
  simulatorName: string;
  resolvedSimulator: ResolvedSimulator | null;
  appBundlePath: string | null;
  screenshotPath: string | null;
  commands: CommandResult[];
  writeReport?: boolean;
  nextActions: string[];
}): Promise<IosScreenshotReport> {
  const commandsOk = params.commands.every((command) => command.ok || command.skipped);
  const ready = commandsOk && params.screenshotPath !== null;
  const report: IosScreenshotReport = {
    schemaVersion: 1,
    appId: params.spec?.appId ?? null,
    appDir: params.appDir,
    ready,
    checkedAt: params.checkedAt,
    simulator: {
      requestedName: params.simulatorName,
      resolvedName: params.resolvedSimulator?.name ?? null,
      udid: params.resolvedSimulator?.udid ?? null,
      runtime: params.resolvedSimulator?.runtime ?? null,
    },
    appBundlePath: params.appBundlePath,
    screenshotPath: params.screenshotPath,
    commands: params.commands,
    nextActions: params.nextActions,
  };
  if (params.writeReport !== false) {
    await writeJsonFile(path.join(params.appDir, BUILDER_DIR, "screenshot-report.json"), report);
    await appendEvidence(params.appDir, {
      at: params.checkedAt,
      stage: "simulator-screenshot",
      result: ready ? "passed" : "failed",
      summary: ready
        ? "Installed, launched, and captured a simulator screenshot."
        : "Simulator screenshot evidence failed.",
      details: {
        simulator: report.simulator,
        screenshotPath: report.screenshotPath,
      },
    });
  }
  return report;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeReadText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function listFiles(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

async function scanForSecretLikeContent(appDir: string): Promise<string[]> {
  const hits: string[] = [];
  const root = path.resolve(appDir);
  const skippedDirs = new Set([
    ".git",
    ".openclaw-app-builder/DerivedData",
    "DerivedData",
    "node_modules",
    "Pods",
    "build",
    "dist",
  ]);
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
    /\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*["'][^"']{12,}["']/i,
    /\bAPP_STORE_CONNECT_(?:API_KEY|ISSUER|PRIVATE_KEY)\b\s*=/i,
  ];
  const stack = [root];
  while (stack.length > 0 && hits.length < 10) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const relativeCurrent = path.relative(root, current);
    if (
      skippedDirs.has(relativeCurrent) ||
      [...skippedDirs].some((dir) => relativeCurrent.startsWith(`${dir}${path.sep}`))
    ) {
      continue;
    }
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      hits.push(relativeCurrent || ".");
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of await listFiles(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (!stat.isFile() || stat.size > 256_000 || !isScannableTextFile(current)) {
      continue;
    }
    const text = await safeReadText(current);
    if (secretPatterns.some((pattern) => pattern.test(text))) {
      hits.push(relativeCurrent);
    }
  }
  return hits;
}

function isScannableTextFile(filePath: string): boolean {
  return /\.(json|md|swift|yml|yaml|plist|txt|env|xcprivacy)$/i.test(filePath);
}

async function commandAvailable(command: string): Promise<boolean> {
  const result = await runCommand(
    command,
    command === "xcodebuild" ? ["-version"] : ["--version"],
    {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    },
  );
  return result.ok;
}

type ResolvedSimulator = {
  name: string;
  udid: string;
  runtime: string;
  state: string;
};

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; tailMax?: number },
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd: options.cwd,
      env: { ...process.env, HOME: os.homedir() },
      maxBuffer: 2 * 1024 * 1024,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        command: formatCommand(command, args),
        skipped: false,
        ok: false,
        exitCode: error.code === "ENOENT" ? 127 : null,
        durationMs: Date.now() - started,
        stdoutTail: trimTail(stdout, options.tailMax),
        stderrTail: trimTail(error.message || stderr, options.tailMax),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: formatCommand(command, args),
        skipped: false,
        ok: code === 0,
        exitCode: code,
        durationMs: Date.now() - started,
        stdoutTail: trimTail(stdout, options.tailMax),
        stderrTail: trimTail(stderr, options.tailMax),
      });
    });
  });
}

function skippedCommand(command: string, reason: string): CommandResult {
  return {
    command,
    skipped: true,
    ok: true,
    exitCode: null,
    durationMs: 0,
    stdoutTail: reason,
    stderrTail: "",
  };
}

function formatModelProfileLine(profile: AppBuilderModelProfile): string {
  const parts = [profile.modelRef, profile.runtime];
  if (profile.quantization) {
    parts.push(profile.quantization);
  }
  if (profile.reasoningEffort) {
    parts.push(`reasoning=${profile.reasoningEffort}`);
  }
  return parts.join(" / ");
}

async function waitCommand(command: string, durationMs: number): Promise<CommandResult> {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  return {
    command,
    skipped: false,
    ok: true,
    exitCode: 0,
    durationMs: Date.now() - started,
    stdoutTail: "settled",
    stderrTail: "",
  };
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))].join(" ");
}

function trimTail(value: string, max = 4000): string {
  const normalized = value.trim();
  return normalized.length > max ? normalized.slice(normalized.length - max) : normalized;
}

function resolveSimulator(simctlJson: string, requestedName: string): ResolvedSimulator | null {
  try {
    const parsed = JSON.parse(simctlJson) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.devices)) {
      return null;
    }
    const candidates: ResolvedSimulator[] = [];
    for (const [runtime, devices] of Object.entries(parsed.devices)) {
      if (!Array.isArray(devices)) {
        continue;
      }
      for (const device of devices) {
        if (!isRecord(device)) {
          continue;
        }
        const name = typeof device.name === "string" ? device.name : "";
        const udid = typeof device.udid === "string" ? device.udid : "";
        const state = typeof device.state === "string" ? device.state : "";
        const isAvailable = device.isAvailable !== false;
        if (name === requestedName && udid && isAvailable) {
          candidates.push({ name, udid, runtime, state });
        }
      }
    }
    return candidates.toSorted(compareSimulatorsNewestFirst)[0] ?? null;
  } catch {
    return null;
  }
}

function compareSimulatorsNewestFirst(a: ResolvedSimulator, b: ResolvedSimulator): number {
  const versionA = simulatorRuntimeVersion(a.runtime);
  const versionB = simulatorRuntimeVersion(b.runtime);
  for (let index = 0; index < Math.max(versionA.length, versionB.length); index += 1) {
    const partA = versionA[index] ?? 0;
    const partB = versionB[index] ?? 0;
    if (partA !== partB) {
      return partB - partA;
    }
  }
  return a.udid.localeCompare(b.udid);
}

function simulatorRuntimeVersion(runtime: string): number[] {
  const version = runtime.match(/iOS[-.]([0-9-]+)/)?.[1] ?? "";
  return version
    .split("-")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
}

async function findAppBundle(root: string, moduleName: string): Promise<string | null> {
  const expected = `${moduleName}.app`;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && entry.name === expected) {
          return fullPath;
        }
        if (entry.isDirectory()) {
          stack.push(fullPath);
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function buildValidationNextActions(params: {
  checks: ValidationCheck[];
  commands: CommandResult[];
  readyForLocalBuild: boolean;
}): string[] {
  if (params.readyForLocalBuild) {
    return ["Run openclaw apps app-store-ready <app-dir> after filling App Store evidence."];
  }
  const actions = params.checks
    .filter((check) => !check.ok)
    .map((check) => `${check.id}: ${check.message}`);
  for (const command of params.commands.filter((entry) => !entry.ok)) {
    actions.push(`Fix failing command: ${command.command}`);
  }
  return actions;
}

function chooseNextGap(
  validation: IosValidationReport,
  appStore: AppStoreReadinessReport,
  gaps?: AppBuilderGapReport,
): {
  completionGrade: number;
  criticality: number;
  gap: string;
  why: string;
} {
  if (!validation.readyForLocalBuild) {
    return {
      completionGrade: 4,
      criticality: 10,
      gap: "iOS scaffold/toolchain validation",
      why: "The app cannot be considered build-ready until project structure, XcodeGen, and local build validation pass.",
    };
  }
  if (gaps && !gaps.readyForAutonomousBuild) {
    const blocker =
      gaps.gaps.find(
        (gap) =>
          isAutonomousBuildBlockingGap(gap) && ["critical", "high"].includes(gap.severity),
      ) ?? gaps.gaps[0];
    return {
      completionGrade: 6,
      criticality: blocker?.impact ?? 9,
      gap: blocker?.title ?? "Autonomous builder readiness evidence",
      why: blocker?.remediation ?? "The local builder lane still needs required evidence before mutation.",
    };
  }
  if (!appStore.readyForTestFlightUpload) {
    return {
      completionGrade: 6,
      criticality: 10,
      gap: "Apple signing and App Store Connect evidence",
      why: "A simulator-valid app still cannot be uploaded until bundle id, team id, signing, SKU, and app record evidence are complete.",
    };
  }
  if (!appStore.readyForAppReviewSubmission) {
    return {
      completionGrade: 7,
      criticality: 9,
      gap: "App Store metadata, privacy labels, screenshots, and review answers",
      why: "TestFlight upload may be possible, but App Review submission must fail closed until all metadata and privacy evidence is complete.",
    };
  }
  return {
    completionGrade: 8,
    criticality: 8,
    gap: "Constrained autonomous Qwen implementation and repair loop",
    why: "The scaffold and gates are ready, but a 10/10 app builder needs a bounded code-generation loop with repair evidence and final verifier review.",
  };
}

function isProductSpecHighSignal(spec: AppBuilderProductSpec): boolean {
  const genericFragments = [
    "Primary App Store users for the requested product.",
    "Primary action surface and current-state summary.",
    "Review prior items, examples, or generated records.",
  ];
  const joined = [
    spec.audience,
    spec.goal,
    ...spec.coreUserJourneys,
    ...spec.screens.map((screen) => `${screen.title} ${screen.purpose}`),
    ...spec.acceptanceCriteria,
  ].join("\n");
  return (
    spec.originalRequest.trim().length >= 20 &&
    spec.coreUserJourneys.length >= 3 &&
    spec.screens.length >= 3 &&
    spec.dataModel.length >= 1 &&
    spec.acceptanceCriteria.length >= 4 &&
    !genericFragments.some((fragment) => joined.includes(fragment))
  );
}

function gapWeight(gap: AppBuilderGap): number {
  switch (gap.severity) {
    case "critical":
      return Math.max(1.5, gap.impact / 4);
    case "high":
      return Math.max(0.8, gap.impact / 7);
    case "medium":
      return 0.5;
    case "low":
      return 0.2;
  }
  return 0;
}

function isAutonomousBuildBlockingGap(gap: AppBuilderGap): boolean {
  return !gap.id.startsWith("app-store-") && gap.id !== "metadata-subtitle";
}

function isAllowedPatchEngine(engine: string, packet: AppBuildPacket): boolean {
  const allowed = new Set([
    packet.modelRouting.builder.modelRef,
    packet.modelRouting.localFallback.modelRef,
    packet.modelRouting.repairFallback.modelRef,
    "Local Qwen Q8",
    "Qwen Q8",
    "Qwen Q6 fallback",
    "Codex GPT-5.5",
  ]);
  return allowed.has(engine);
}

function validatePatchChange(
  appDir: string,
  change: AppBuilderPatchChange,
): { ok: true; relativePath: string; absolutePath: string } | { ok: false; reason: string } {
  if (!isRecord(change)) {
    return { ok: false, reason: "change must be an object" };
  }
  if (change.action !== "write") {
    return { ok: false, reason: "only write actions are supported" };
  }
  if (typeof change.path !== "string" || change.path.trim().length === 0) {
    return { ok: false, reason: "path is required" };
  }
  if (path.isAbsolute(change.path)) {
    return { ok: false, reason: "absolute paths are not allowed" };
  }
  if (typeof change.contents !== "string") {
    return { ok: false, reason: "contents must be a string" };
  }
  if (change.contents.length > 300_000) {
    return { ok: false, reason: "contents exceed the 300KB app-builder patch limit" };
  }
  const normalized = path.normalize(change.path).replace(/\\/g, "/");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return { ok: false, reason: "path must stay inside the app directory" };
  }
  if (!isAllowedPatchRelativePath(normalized)) {
    return {
      ok: false,
      reason:
        "path is outside the approved patch surface; use Sources/, Tests/, AppStore/metadata.json, AppStore/review-notes.md, Privacy/, or README.md",
    };
  }
  const absolutePath = path.resolve(appDir, normalized);
  const relativeToRoot = path.relative(appDir, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return { ok: false, reason: "resolved path escapes the app directory" };
  }
  return { ok: true, relativePath: normalized, absolutePath };
}

async function findSymlinkPathComponent(
  appDir: string,
  relativePath: string,
): Promise<string | null> {
  const parts = relativePath.split("/").filter(Boolean);
  let current = appDir;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const existing = await lstat(current);
      if (existing.isSymbolicLink()) {
        return path.relative(appDir, current).replace(/\\/g, "/");
      }
    } catch {
      return null;
    }
  }
  return null;
}

function isAllowedPatchRelativePath(relativePath: string): boolean {
  return (
    relativePath.startsWith("Sources/") ||
    relativePath.startsWith("Tests/") ||
    relativePath === "AppStore/metadata.json" ||
    relativePath === "AppStore/review-notes.md" ||
    relativePath.startsWith("Privacy/") ||
    relativePath === "README.md"
  );
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validateAppBuilderModelRouting(packet: AppBuildPacket): {
  ok: boolean;
  messages: string[];
} {
  const routing = packet.modelRouting as unknown;
  const messages: string[] = [];
  if (!isRecord(routing)) {
    return { ok: false, messages: ["modelRouting must be an object"] };
  }

  const planner = routing.planner;
  const builder = routing.builder;
  const localFallback = routing.localFallback;
  const repairFallback = routing.repairFallback;
  const finalVerifier = routing.finalVerifier;
  const disallowedReviewers = routing.disallowedReviewers;

  if (!isRecord(planner) || planner.modelRef !== APP_BUILDER_PLANNER_MODEL_REF) {
    messages.push(`planner must be ${APP_BUILDER_PLANNER_MODEL_REF}`);
  }
  if (!isRecord(planner) || planner.runtime !== "codex" || planner.authProvider !== "openai-codex") {
    messages.push("planner must use the Codex runtime with openai-codex auth");
  }

  if (!isRecord(builder) || builder.modelRef !== APP_BUILDER_BUILDER_MODEL_REF) {
    messages.push(`builder must be ${APP_BUILDER_BUILDER_MODEL_REF}`);
  }
  if (!isRecord(builder) || builder.provider !== "ollama" || builder.runtime !== "ollama-native") {
    messages.push("builder must use the native Ollama runtime");
  }
  if (!isRecord(builder) || builder.quantization !== "Q8_0") {
    messages.push("builder quantization must be Q8_0");
  }
  if (
    !isRecord(builder) ||
    builder.requiresLocalAvailability !== true ||
    builder.requiresModelDigestBeforeMutation !== true ||
    builder.failClosedIfUnavailable !== true
  ) {
    messages.push("builder must fail closed, require local availability, and require a digest before mutation");
  }

  const parameters = isRecord(builder) ? builder.parameters : null;
  if (!isRecord(parameters)) {
    messages.push("builder parameters are missing");
  } else {
    const expectedEntries: Array<[keyof AppBuilderModelParameters, number | boolean]> = [
      ["temperature", APP_BUILDER_QWEN_PARAMS.temperature],
      ["topP", APP_BUILDER_QWEN_PARAMS.topP],
      ["topK", APP_BUILDER_QWEN_PARAMS.topK],
      ["repeatPenalty", APP_BUILDER_QWEN_PARAMS.repeatPenalty],
      ["numCtx", APP_BUILDER_QWEN_PARAMS.numCtx],
      ["numPredict", APP_BUILDER_QWEN_PARAMS.numPredict],
      ["think", APP_BUILDER_QWEN_PARAMS.think],
    ];
    for (const [key, expected] of expectedEntries) {
      if (parameters[key] !== expected) {
        messages.push(`builder parameter ${key} must be ${String(expected)}`);
      }
    }
  }

  if (!isRecord(localFallback) || localFallback.modelRef !== APP_BUILDER_LOCAL_FALLBACK_MODEL_REF) {
    messages.push(`local fallback must be ${APP_BUILDER_LOCAL_FALLBACK_MODEL_REF}`);
  }
  if (
    !isRecord(localFallback) ||
    localFallback.provider !== "ollama" ||
    localFallback.runtime !== "ollama-native"
  ) {
    messages.push("local fallback must use the native Ollama runtime");
  }
  if (!isRecord(localFallback) || localFallback.quantization !== "Q6_K") {
    messages.push("local fallback quantization must be Q6_K");
  }
  if (
    !isRecord(localFallback) ||
    localFallback.requiresLocalAvailability !== true ||
    localFallback.requiresModelDigestBeforeMutation !== true ||
    localFallback.failClosedIfUnavailable !== true
  ) {
    messages.push(
      "local fallback must fail closed, require local availability, and require a digest before mutation",
    );
  }
  const localFallbackParameters = isRecord(localFallback) ? localFallback.parameters : null;
  if (!isRecord(localFallbackParameters)) {
    messages.push("local fallback parameters are missing");
  } else {
    const expectedEntries: Array<[keyof AppBuilderModelParameters, number | boolean]> = [
      ["temperature", APP_BUILDER_QWEN_PARAMS.temperature],
      ["topP", APP_BUILDER_QWEN_PARAMS.topP],
      ["topK", APP_BUILDER_QWEN_PARAMS.topK],
      ["repeatPenalty", APP_BUILDER_QWEN_PARAMS.repeatPenalty],
      ["numCtx", APP_BUILDER_QWEN_PARAMS.numCtx],
      ["numPredict", APP_BUILDER_QWEN_PARAMS.numPredict],
      ["think", APP_BUILDER_QWEN_PARAMS.think],
    ];
    for (const [key, expected] of expectedEntries) {
      if (localFallbackParameters[key] !== expected) {
        messages.push(`local fallback parameter ${key} must be ${String(expected)}`);
      }
    }
  }

  if (!isRecord(repairFallback) || repairFallback.modelRef !== APP_BUILDER_VERIFIER_MODEL_REF) {
    messages.push(`repair fallback must be ${APP_BUILDER_VERIFIER_MODEL_REF}`);
  }
  if (
    !isRecord(repairFallback) ||
    repairFallback.runtime !== "codex" ||
    repairFallback.authProvider !== "openai-codex"
  ) {
    messages.push("repair fallback must use the Codex runtime with openai-codex auth");
  }
  if (!isRecord(finalVerifier) || finalVerifier.modelRef !== APP_BUILDER_VERIFIER_MODEL_REF) {
    messages.push(`final verifier must be ${APP_BUILDER_VERIFIER_MODEL_REF}`);
  }
  if (
    !isRecord(finalVerifier) ||
    finalVerifier.runtime !== "codex" ||
    finalVerifier.authProvider !== "openai-codex" ||
    finalVerifier.reasoningEffort !== "xhigh"
  ) {
    messages.push("final verifier must use Codex with xhigh reasoning");
  }
  if (
    !Array.isArray(disallowedReviewers) ||
    !disallowedReviewers.includes("claude") ||
    !disallowedReviewers.includes("gemini")
  ) {
    messages.push("Claude and Gemini must remain disabled for this builder lane");
  }

  return { ok: messages.length === 0, messages };
}

function ollamaModelNameFromRef(modelRef: string): string | null {
  return modelRef.startsWith("ollama/") ? modelRef.slice("ollama/".length) : null;
}

async function checkOllamaModelAvailability(
  baseUrl: string,
  modelName: string,
): Promise<{ ok: boolean; digest: string | null; message: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  try {
    const parsed = await fetchJsonWithTimeout(url, { method: "GET" }, 2_000);
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return {
        ok: false,
        digest: null,
        message: `Ollama API at ${baseUrl} returned an invalid /api/tags payload.`,
      };
    }
    for (const entry of parsed.models) {
      if (!isRecord(entry)) {
        continue;
      }
      const name = typeof entry.name === "string" ? entry.name : "";
      if (name === modelName) {
        const digest = typeof entry.digest === "string" ? entry.digest : null;
        return {
          ok: true,
          digest,
          message: digest
            ? `Found ${modelName} on ${baseUrl} with digest ${digest}.`
            : `Found ${modelName} on ${baseUrl}, but the digest was not reported.`,
        };
      }
    }
    return {
      ok: false,
      digest: null,
      message: `Ollama model ${modelName} is not available on ${baseUrl}.`,
    };
  } catch (error) {
    return {
      ok: false,
      digest: null,
      message: `Ollama API at ${baseUrl} is not reachable: ${formatUnknownError(error)}.`,
    };
  }
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evidenceItem(
  id: string,
  label: string,
  present: boolean,
  criticality: number,
  remediation: string,
): AppStoreReadinessReport["requiredEvidence"][number] {
  return { id, label, present, criticality, remediation };
}

function stringPresent(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("TODO");
}

function stringOrPlaceholder(value: unknown, placeholder: string): string {
  return stringPresent(value) && typeof value === "string" ? value : placeholder;
}

function objectHasValues(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) => {
    if (typeof entry === "string") {
      return stringPresent(entry);
    }
    if (typeof entry === "boolean") {
      return true;
    }
    if (Array.isArray(entry)) {
      return entry.length > 0;
    }
    return isRecord(entry) && Object.keys(entry).length > 0;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function swiftString(value: string): string {
  return JSON.stringify(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderReadme(spec: AppBuilderProductSpec): string {
  return `# ${spec.appName}\n\nGenerated by OpenClaw Apps as a native SwiftUI iOS scaffold.\n\n## Request\n\n${spec.originalRequest}\n\n## Local validation\n\n\`\`\`bash\nxcodegen generate\nxcodebuild test -scheme ${spec.moduleName} -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO\n\`\`\`\n\n## OpenClaw validation\n\n\`\`\`bash\nopenclaw apps ios-validate . --run-xcodegen\nopenclaw apps ios-validate . --run-xcodebuild\nopenclaw apps app-store-ready .\n\`\`\`\n\nApp Store upload and submission are intentionally blocked until the evidence in \`AppStore/\`, \`Privacy/\`, and \`Screenshots/\` is complete and a human approves the release.\n`;
}

function renderProjectYml(spec: AppBuilderProductSpec): string {
  return `name: ${spec.moduleName}\noptions:\n  bundleIdPrefix: ai.openclaw.generated\n  deploymentTarget:\n    iOS: ${yamlString(spec.platform.minimumIOS)}\n  xcodeVersion: "16.0"\nsettings:\n  base:\n    SWIFT_VERSION: ${yamlString(spec.platform.swiftVersion)}\n    ENABLE_APP_INTENTS_METADATA_GENERATION: NO\nschemes:\n  ${spec.moduleName}:\n    shared: true\n    build:\n      targets:\n        ${spec.moduleName}: all\n    test:\n      targets:\n        - ${spec.moduleName}Tests\ntargets:\n  ${spec.moduleName}:\n    type: application\n    platform: iOS\n    sources:\n      - path: Sources\n      - path: Assets.xcassets\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: ${yamlString(spec.bundleId)}\n        TARGETED_DEVICE_FAMILY: "1,2"\n        SWIFT_VERSION: ${yamlString(spec.platform.swiftVersion)}\n        SWIFT_STRICT_CONCURRENCY: complete\n        CODE_SIGN_STYLE: Automatic\n        CODE_SIGNING_ALLOWED: NO\n    info:\n      path: Sources/Info.plist\n      properties:\n        CFBundleDisplayName: ${yamlString(spec.appName)}\n        CFBundleShortVersionString: "1.0"\n        CFBundleVersion: "1"\n        UILaunchScreen: {}\n        ITSAppUsesNonExemptEncryption: false\n        UISupportedInterfaceOrientations:\n          - UIInterfaceOrientationPortrait\n        UISupportedInterfaceOrientations~ipad:\n          - UIInterfaceOrientationPortrait\n          - UIInterfaceOrientationLandscapeLeft\n          - UIInterfaceOrientationLandscapeRight\n  ${spec.moduleName}Tests:\n    type: bundle.unit-test\n    platform: iOS\n    sources:\n      - path: Tests\n    dependencies:\n      - target: ${spec.moduleName}\n    settings:\n      base:\n        SWIFT_VERSION: ${yamlString(spec.platform.swiftVersion)}\n        CODE_SIGNING_ALLOWED: NO\n`;
}

function renderAppMainSwift(spec: AppBuilderProductSpec): string {
  return `import SwiftUI\n\n@main\nstruct ${spec.moduleName}App: App {\n    var body: some Scene {\n        WindowGroup {\n            ContentView()\n        }\n    }\n}\n`;
}

export function renderAppBuilderModelsSwift(spec: AppBuilderProductSpec): string {
  const flow = normalizeAppBuilderScreenFlow(spec);
  return `import Foundation\n\nstruct AppFeature: Identifiable, Equatable {\n    let id: String\n    let title: String\n    let detail: String\n\n    static let defaults: [AppFeature] = [\n${spec.screens.map((screen) => `        AppFeature(id: ${swiftString(screen.id)}, title: ${swiftString(screen.title)}, detail: ${swiftString(screen.purpose)})`).join(",\n")}\n    ]\n}\n\nstruct AppScreenFlow: Identifiable, Equatable {\n    let id: String\n    let fromScreenId: String\n    let toScreenId: String\n    let label: String\n    let trigger: String\n\n    static let entryScreenId = ${swiftString(flow.entryScreenId)}\n    static let defaults: [AppScreenFlow] = [\n${flow.edges.map((edge) => `        AppScreenFlow(id: ${swiftString(edge.id)}, fromScreenId: ${swiftString(edge.fromScreenId)}, toScreenId: ${swiftString(edge.toScreenId)}, label: ${swiftString(edge.label)}, trigger: ${swiftString(edge.trigger)})`).join(",\n")}\n    ]\n}\n\nstruct LocalDraftRecord: Identifiable, Equatable, Codable {\n    static let recordsStorageKey = ${swiftString(`openclaw.${spec.appId}.localDraftRecords.v1`)}\n\n    let id: UUID\n    var title: String\n    var detail: String\n    var isComplete: Bool\n    var featureId: String\n\n    init(id: UUID = UUID(), title: String, detail: String, isComplete: Bool = false, featureId: String) {\n        self.id = id\n        self.title = title\n        self.detail = detail\n        self.isComplete = isComplete\n        self.featureId = featureId\n    }\n\n    static func samples(for features: [AppFeature]) -> [LocalDraftRecord] {\n        features.prefix(3).enumerated().map { index, feature in\n            LocalDraftRecord(\n                title: "\\(feature.title) starter",\n                detail: feature.detail,\n                isComplete: index == 0,\n                featureId: feature.id\n            )\n        }\n    }\n\n    static func load(for features: [AppFeature], defaults: UserDefaults = .standard) -> [LocalDraftRecord] {\n        guard\n            let data = defaults.data(forKey: recordsStorageKey),\n            let decoded = try? JSONDecoder().decode([LocalDraftRecord].self, from: data)\n        else {\n            return samples(for: features)\n        }\n        return decoded\n    }\n\n    static func save(_ records: [LocalDraftRecord], defaults: UserDefaults = .standard) {\n        guard let data = try? JSONEncoder().encode(records) else { return }\n        defaults.set(data, forKey: recordsStorageKey)\n    }\n\n    static func clearSavedRecords(defaults: UserDefaults = .standard) {\n        defaults.removeObject(forKey: recordsStorageKey)\n    }\n}\n\nstruct ProductSpecSummary {\n    static let appName = ${swiftString(spec.appName)}\n    static let originalRequest = ${swiftString(spec.originalRequest)}\n    static let acceptanceCriteria = [\n${spec.acceptanceCriteria.map((criterion) => `        ${swiftString(criterion)}`).join(",\n")}\n    ]\n}\n`;
}

function renderContentViewSwift(spec: AppBuilderProductSpec): string {
  return `import SwiftUI\n\nstruct ContentView: View {\n    var body: some View {\n        TabView {\n            TodayView()\n                .tabItem { Label("Today", systemImage: "sparkles") }\n            HistoryView()\n                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }\n            SettingsView()\n                .tabItem { Label("Settings", systemImage: "gearshape") }\n        }\n    }\n}\n\nprivate struct TodayView: View {\n    var body: some View {\n        NavigationStack {\n            List {\n                Section("Goal") {\n                    Text(${swiftString(spec.goal)})\n                        .font(.body)\n                }\n                Section("Core flows") {\n                    ForEach(AppFeature.defaults) { feature in\n                        VStack(alignment: .leading, spacing: 6) {\n                            Text(feature.title)\n                                .font(.headline)\n                            Text(feature.detail)\n                                .font(.subheadline)\n                                .foregroundStyle(.secondary)\n                        }\n                        .padding(.vertical, 4)\n                    }\n                }\n            }\n            .navigationTitle(ProductSpecSummary.appName)\n        }\n    }\n}\n\nprivate struct HistoryView: View {\n    var body: some View {\n        NavigationStack {\n            List(ProductSpecSummary.acceptanceCriteria, id: \\.self) { criterion in\n                Label(criterion, systemImage: "checkmark.seal")\n            }\n            .navigationTitle("Build Proof")\n        }\n    }\n}\n\nprivate struct SettingsView: View {\n    var body: some View {\n        NavigationStack {\n            Form {\n                Section("Privacy") {\n                    Label("No tracking in generated scaffold", systemImage: "hand.raised")\n                    Label("No network access by default", systemImage: "wifi.slash")\n                }\n                Section("Original request") {\n                    Text(ProductSpecSummary.originalRequest)\n                }\n            }\n            .navigationTitle("Settings")\n        }\n    }\n}\n\n#Preview {\n    ContentView()\n}\n`;
}

function renderImplementedContentViewSwift(spec: AppBuilderProductSpec): string {
  return `import SwiftUI\n\n// Product-spec screens: ${spec.screens.map((screen) => screen.title).join(", ")}\n\nstruct ContentView: View {\n    @State private var records = LocalDraftRecord.load(for: AppFeature.defaults)\n\n    var body: some View {\n        TabView {\n            ForEach(Array(AppFeature.defaults.enumerated()), id: \\.element.id) { index, feature in\n                GeneratedFeatureView(feature: feature, features: AppFeature.defaults, records: $records)\n                    .tabItem { Label(feature.title, systemImage: generatedFeatureIcon(at: index)) }\n            }\n            BuildProofView(records: records)\n                .tabItem { Label("Proof", systemImage: "checkmark.seal") }\n            SettingsView()\n                .tabItem { Label("Settings", systemImage: "gearshape") }\n        }\n        .onChange(of: records) { _, newRecords in\n            LocalDraftRecord.save(newRecords)\n        }\n    }\n}\n\nprivate let generatedFeatureIcons = [\n    "sparkles",\n    "rectangle.grid.2x2",\n    "chart.bar",\n    "calendar",\n    "list.bullet.clipboard",\n    "star",\n    "bolt.heart",\n    "folder"\n]\n\nprivate func generatedFeatureIcon(at index: Int) -> String {\n    generatedFeatureIcons[index % generatedFeatureIcons.count]\n}\n\nprivate struct GeneratedFeatureView: View {\n    let feature: AppFeature\n    let features: [AppFeature]\n    @Binding var records: [LocalDraftRecord]\n    @State private var draftTitle = ""\n    @State private var draftDetail = ""\n\n    private var featureRecords: [LocalDraftRecord] {\n        records.filter { $0.featureId == feature.id }\n    }\n\n    private var completedCount: Int {\n        featureRecords.filter(\\.isComplete).count\n    }\n\n    private var connectedScreens: [(edge: AppScreenFlow, target: AppFeature)] {\n        AppScreenFlow.defaults.compactMap { edge in\n            guard edge.fromScreenId == feature.id, let target = features.first(where: { $0.id == edge.toScreenId }) else {\n                return nil\n            }\n            return (edge, target)\n        }\n    }\n\n    var body: some View {\n        NavigationStack {\n            List {\n                Section("Purpose") {\n                    Text(feature.detail)\n                    Label("\\(completedCount) of \\(featureRecords.count) local records complete", systemImage: "chart.bar.doc.horizontal")\n                        .foregroundStyle(.secondary)\n                }\n                Section("Quick add") {\n                    TextField("Record title", text: $draftTitle)\n                    TextEditor(text: $draftDetail)\n                        .frame(minHeight: 72)\n                        .accessibilityLabel("Record detail")\n                    Button(action: addRecord) {\n                        Label("Add local record", systemImage: "plus.circle.fill")\n                    }\n                    .disabled(draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)\n                }\n                Section("Local records") {\n                    if featureRecords.isEmpty {\n                        ContentUnavailableView("No records yet", systemImage: "tray", description: Text("Add a local record to make this screen useful."))\n                    } else {\n                        ForEach(featureRecords) { record in\n                            Button {\n                                toggleRecord(record.id)\n                            } label: {\n                                HStack(alignment: .top, spacing: 12) {\n                                    Image(systemName: record.isComplete ? "checkmark.circle.fill" : "circle")\n                                        .foregroundStyle(record.isComplete ? .green : .secondary)\n                                    VStack(alignment: .leading, spacing: 4) {\n                                        Text(record.title)\n                                            .font(.headline)\n                                            .foregroundStyle(.primary)\n                                        Text(record.detail)\n                                            .font(.subheadline)\n                                            .foregroundStyle(.secondary)\n                                    }\n                                }\n                            }\n                            .buttonStyle(.plain)\n                        }\n                        .onDelete(perform: deleteRecords)\n                    }\n                }\n                if !connectedScreens.isEmpty {\n                    Section("Connected screens") {\n                        ForEach(connectedScreens, id: \\.edge.id) { connection in\n                            NavigationLink {\n                                GeneratedFeatureView(feature: connection.target, features: features, records: $records)\n                            } label: {\n                                VStack(alignment: .leading, spacing: 4) {\n                                    Label(connection.edge.label, systemImage: "arrow.turn.down.right")\n                                    Text("Tap → \\(connection.target.title)")\n                                        .font(.caption)\n                                        .foregroundStyle(.secondary)\n                                }\n                            }\n                        }\n                    }\n                }\n                Section("What this screen must support") {\n                    ForEach(ProductSpecSummary.acceptanceCriteria, id: \\.self) { criterion in\n                        Label(criterion, systemImage: "checkmark.circle")\n                    }\n                }\n                Section("Local-first promise") {\n                    Label("Records stay on this device", systemImage: "internaldrive")\n                    Label("No account required", systemImage: "person.crop.circle.badge.checkmark")\n                    Label("No tracking in generated scaffold", systemImage: "hand.raised")\n                    Label("No network access by default", systemImage: "wifi.slash")\n                }\n            }\n            .navigationTitle(feature.title)\n        }\n    }\n\n    private func addRecord() {\n        let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)\n        let detail = draftDetail.trimmingCharacters(in: .whitespacesAndNewlines)\n        guard !title.isEmpty else { return }\n        records.append(\n            LocalDraftRecord(\n                title: title,\n                detail: detail.isEmpty ? feature.detail : detail,\n                featureId: feature.id\n            )\n        )\n        draftTitle = ""\n        draftDetail = ""\n    }\n\n    private func toggleRecord(_ id: LocalDraftRecord.ID) {\n        guard let index = records.firstIndex(where: { $0.id == id }) else { return }\n        records[index].isComplete.toggle()\n    }\n\n    private func deleteRecords(at offsets: IndexSet) {\n        let idsToDelete = Set(offsets.map { featureRecords[$0].id })\n        records.removeAll { idsToDelete.contains($0.id) }\n    }\n}\n\nprivate struct BuildProofView: View {\n    let records: [LocalDraftRecord]\n\n    var body: some View {\n        NavigationStack {\n            List {\n                Section("App goal") {\n                    Text(ProductSpecSummary.appName)\n                        .font(.headline)\n                    Text(ProductSpecSummary.originalRequest)\n                        .foregroundStyle(.secondary)\n                }\n                Section("Local data proof") {\n                    Label("\\(records.count) saved local records", systemImage: "tray.full")\n                    Label("Create, toggle, delete, and relaunch persistence use app-local SwiftUI state plus UserDefaults", systemImage: "checklist")\n                }\n                Section("Acceptance criteria") {\n                    ForEach(ProductSpecSummary.acceptanceCriteria, id: \\.self) { criterion in\n                        Label(criterion, systemImage: "checkmark.seal")\n                    }\n                }\n            }\n            .navigationTitle("Build Proof")\n        }\n    }\n}\n\nprivate struct SettingsView: View {\n    var body: some View {\n        NavigationStack {\n            Form {\n                Section("Privacy") {\n                    Label("Generated scaffold stores data locally", systemImage: "internaldrive")\n                    Label("No tracking", systemImage: "hand.raised")\n                    Label("No network access by default", systemImage: "wifi.slash")\n                }\n                Section("Original request") {\n                    Text(ProductSpecSummary.originalRequest)\n                }\n            }\n            .navigationTitle("Settings")\n        }\n    }\n}\n\n#Preview {\n    ContentView()\n}\n`;
}

export function renderAppBuilderTestsSwift(spec: AppBuilderProductSpec): string {
  const firstScreenId = spec.screens[0]?.id ?? "dashboard";
  const flow = normalizeAppBuilderScreenFlow(spec);
  return `import Foundation\nimport XCTest\n@testable import ${spec.moduleName}\n\nfinal class GeneratedAppTests: XCTestCase {\n    func testProductSpecTraceability() {\n        XCTAssertEqual(ProductSpecSummary.appName, ${swiftString(spec.appName)})\n        XCTAssertTrue(ProductSpecSummary.originalRequest.contains(${swiftString(spec.originalRequest.slice(0, Math.min(20, spec.originalRequest.length)))}))\n    }\n\n    func testGeneratedFeaturesExist() {\n        XCTAssertGreaterThanOrEqual(AppFeature.defaults.count, 3)\n        XCTAssertEqual(AppFeature.defaults.first?.id, ${swiftString(firstScreenId)})\n    }\n\n    func testGeneratedScreenFlowExists() {\n        XCTAssertEqual(AppScreenFlow.entryScreenId, ${swiftString(flow.entryScreenId)})\n        XCTAssertEqual(AppScreenFlow.defaults.count, ${flow.edges.length})\n    }\n\n    func testLocalDraftRecordPersistenceRoundTrip() {\n        let defaults = UserDefaults(suiteName: "${spec.moduleName}.GeneratedAppTests")!\n        defaults.removePersistentDomain(forName: "${spec.moduleName}.GeneratedAppTests")\n        defer { defaults.removePersistentDomain(forName: "${spec.moduleName}.GeneratedAppTests") }\n        let record = LocalDraftRecord(title: "Test record", detail: "Saved locally", featureId: ${swiftString(firstScreenId)})\n\n        LocalDraftRecord.save([record], defaults: defaults)\n        let loaded = LocalDraftRecord.load(for: [], defaults: defaults)\n\n        XCTAssertEqual(loaded.count, 1)\n        XCTAssertEqual(loaded.first?.title, "Test record")\n        XCTAssertEqual(loaded.first?.detail, "Saved locally")\n        XCTAssertEqual(loaded.first?.featureId, ${swiftString(firstScreenId)})\n    }\n}\n`;
}

function renderInfoPlist(_spec: AppBuilderProductSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict/>\n</plist>\n`;
}

function renderPrivacyManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>NSPrivacyTracking</key>\n  <false/>\n  <key>NSPrivacyCollectedDataTypes</key>\n  <array/>\n  <key>NSPrivacyAccessedAPITypes</key>\n  <array/>\n</dict>\n</plist>\n`;
}

function renderAppIconContents(): string {
  return `${JSON.stringify(
    {
      images: [{ idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  )}\n`;
}

function renderAppStoreMetadata(spec: AppBuilderProductSpec): string {
  const keywords = inferAppStoreKeywords(spec);
  return `${JSON.stringify(
    {
      name: spec.appName,
      subtitle: inferAppStoreSubtitle(spec),
      description: inferAppStoreDescription(spec),
      keywords,
      supportUrl: "",
      privacyUrl: "",
      marketingUrl: "",
      accessibilityNotes:
        "Generated SwiftUI scaffold uses standard controls, system text, Dynamic Type-friendly layout, and VoiceOver-compatible labels. Revalidate after custom UI changes.",
      ageRating: {
        unrestrictedWebAccess: false,
        gambling: false,
        contests: false,
        medicalTreatmentInformation: false,
        alcoholTobaccoOrDrugUseOrReferences: "none",
        matureOrSuggestiveThemes: "none",
        violence: "none",
      },
      privacyNutritionLabels: {
        collectsData: false,
        tracksUsers: false,
        dataLinkedToUser: [],
        dataNotLinkedToUser: [],
      },
      trackingDeclaration: { tracksUsers: false, usesIdfa: false },
      encryptionCompliance: { usesNonExemptEncryption: false },
      reviewContact: {},
      demoAccount: { required: false, instructions: "" },
      testFlightNotes:
        "Generated offline scaffold. No login, network access, tracking, or demo account is required.",
    },
    null,
    2,
  )}\n`;
}

function inferAppStoreSubtitle(spec: AppBuilderProductSpec): string {
  const normalized = spec.originalRequest.toLowerCase();
  if (/focus|timer|pomodoro/.test(normalized)) {
    return "Private focus timer";
  }
  if (/meal|recipe|grocery/.test(normalized)) {
    return "Private meal planning";
  }
  if (/habit|routine|streak/.test(normalized)) {
    return "Private habit tracker";
  }
  return `${spec.appName} for iPhone`.slice(0, 30);
}

function inferAppStoreDescription(spec: AppBuilderProductSpec): string {
  const screens = spec.screens.map((screen) => screen.title).join(", ");
  return `${spec.appName} is a privacy-first iOS app scaffold for: ${spec.originalRequest}. The generated app is designed around ${screens}, keeps scaffold data local by default, and requires no account, tracking, or network access until you explicitly add those features.`;
}

function inferAppStoreKeywords(spec: AppBuilderProductSpec): string[] {
  const words = spec.originalRequest
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(
      (word) => word.length >= 4 && !["create", "apple", "store", "with", "simple"].includes(word),
    )
    .slice(0, 8) ?? ["productivity", "private"];
  return [...new Set([...words, spec.appleCategory.toLowerCase(), "private"])].slice(0, 10);
}

function renderAppStoreConnectStub(spec: AppBuilderProductSpec): string {
  return `${JSON.stringify(
    {
      bundleId: spec.bundleId,
      appStoreConnectAppId: "",
      sku: "",
      teamId: "",
      signingIdentity: "",
      provisioningProfile: "",
      version: "1.0",
      buildNumber: "1",
      apiKeyProfileRef: "",
      appStoreConnectApiKeyRef:
        "JWT credential material must stay outside the generated app directory.",
    },
    null,
    2,
  )}\n`;
}

function renderExportOptionsPlist(spec: AppBuilderProductSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>destination</key>\n  <string>export</string>\n  <key>method</key>\n  <string>app-store-connect</string>\n  <key>signingStyle</key>\n  <string>automatic</string>\n  <key>stripSwiftSymbols</key>\n  <true/>\n  <key>teamID</key>\n  <string>TODO_TEAM_ID</string>\n  <key>manageAppVersionAndBuildNumber</key>\n  <false/>\n  <key>provisioningProfiles</key>\n  <dict>\n    <key>${spec.bundleId}</key>\n    <string>TODO_PROVISIONING_PROFILE_NAME</string>\n  </dict>\n</dict>\n</plist>\n`;
}

function renderReviewNotes(spec: AppBuilderProductSpec): string {
  return `# App Review Notes\n\nApp: ${spec.appName}\n\n## Human approval required\n\nDo not submit this app until simulator validation, metadata, screenshots, privacy labels, signing evidence, TestFlight review, and final human approval are complete.\n\n## Demo account\n\nNot required for the generated offline scaffold. Update this if the app adds accounts or server-backed features.\n`;
}

function renderPrivacyEvidence(spec: AppBuilderProductSpec): string {
  return `# Privacy Evidence\n\n- App: ${spec.appName}\n- Tracking: false in generated scaffold\n- Network access: false in generated scaffold\n- Data collection: none in generated scaffold\n\nIf future builder passes add analytics, accounts, location, camera, contacts, HealthKit, payments, backend sync, AI APIs, or crash reporting, update this file and AppStore/metadata.json before App Store readiness can pass.\n`;
}

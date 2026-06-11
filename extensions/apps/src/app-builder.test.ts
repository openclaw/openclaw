import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAppBuilderImplementationPass,
  applyAppBuilderPatchPlan,
  captureIosSimulatorScreenshot,
  createBuildDryRunTask,
  createAppStorePublishPlan,
  createAppBuilderFinalVerifierReport,
  createIosNativeApp,
  evaluateAppBuilderGaps,
  evaluateAppBuilderModelReadiness,
  evaluateAppBuilderReadiness,
  evaluateAppStoreReadiness,
  inferAppBuilderTarget,
  readBuildPacket,
  readFinalVerifierReport,
  readIosValidationReport,
  readPatchReport,
  readRepairReport,
  repairIosApp,
  validateIosApp,
} from "./app-builder.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-apps-test-"));
  tempDirs.push(dir);
  return dir;
}

async function withFakeOllama<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake Ollama server did not expose a TCP port.");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OpenClaw Apps builder", () => {
  it("defaults Apple Store requests to native iOS", () => {
    expect(inferAppBuilderTarget("Create a timer app for the Apple Store")).toBe("ios-native");
  });

  it("creates a native SwiftUI/XcodeGen scaffold with durable builder artifacts", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    expect(result.appDir).toBe(path.join(root, "generated-apps", "habit-forge"));
    expect(result.spec.target).toBe("ios-native");
    expect(result.spec.moduleName).toBe("HabitForge");
    expect(result.filesWritten).toContain("project.yml");
    expect(result.filesWritten).toContain("Sources/PrivacyInfo.xcprivacy");
    expect(result.filesWritten).toContain("AppStore/ExportOptions.plist");
    expect(result.filesWritten).toContain(".openclaw-app-builder/build-packet.json");

    const project = await readFile(path.join(result.appDir, "project.yml"), "utf8");
    expect(project).toContain("HabitForge");
    expect(project).toContain("ai.openclaw.generated.habit.forge");

    const packet = await readBuildPacket(result.appDir);
    expect(packet?.allowedWriteRoot).toBe(result.appDir);
    expect(packet?.forbiddenActions.join("\n")).toContain(
      "Do not edit files outside allowedWriteRoot",
    );
    expect(packet?.modelRouting.planner.modelRef).toBe("openai/gpt-5.5");
    expect(packet?.modelRouting.builder.modelRef).toBe("ollama/qwen3.6:27b-q8_0");
    expect(packet?.modelRouting.builder.modelFamily).toBe("Qwen3.6 27B");
    expect(packet?.modelRouting.builder.quantization).toBe("Q8_0");
    expect(packet?.modelRouting.localFallback.modelRef).toBe(
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    );
    expect(packet?.modelRouting.localFallback.modelFamily).toBe("Qwen3 30.5B");
    expect(packet?.modelRouting.localFallback.quantization).toBe("Q6_K");
    expect(packet?.modelRouting.builder.parameters).toMatchObject({
      temperature: 0.15,
      topP: 0.9,
      topK: 20,
      repeatPenalty: 1.05,
      numCtx: 65_536,
      numPredict: 8_192,
      think: false,
    });
    expect(packet?.modelRouting.localFallback.parameters).toMatchObject({
      temperature: 0.15,
      topP: 0.9,
      topK: 20,
      repeatPenalty: 1.05,
      numCtx: 65_536,
      numPredict: 8_192,
      think: false,
    });
    expect(packet?.modelRouting.repairFallback.modelRef).toBe("openai/gpt-5.5");
    expect(packet?.modelRouting.finalVerifier.reasoningEffort).toBe("xhigh");
    expect(packet?.modelRouting.disallowedReviewers).toEqual(["claude", "gemini"]);
    expect(packet?.requiredValidationCommands).toContain("openclaw apps model-check <app-dir>");
    expect(packet?.requiredValidationCommands).toContain("openclaw apps screenshots <app-dir>");
  });

  it("refuses to write into a non-empty output directory without force", async () => {
    const root = await makeTempDir();
    const appDir = path.join(root, "Existing");
    await writeFile(path.join(root, "marker"), "x", "utf8");
    await createIosNativeApp({
      request: "Create a notes app for iPhone",
      outputDir: appDir,
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    await expect(
      createIosNativeApp({
        request: "Create a notes app for iPhone",
        outputDir: appDir,
        now: new Date("2026-05-13T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/Refusing to write/);
  });

  it("validates scaffold structure without requiring host Xcode in unit tests", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a budget app for iOS",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const report = await validateIosApp(result.appDir, { checkToolchain: false });

    expect(report.readyForLocalBuild).toBe(true);
    expect(report.checks.find((check) => check.id === "product-spec")?.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "model-routing")?.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "toolchain-skipped")?.ok).toBe(true);
  });

  it("fails validation when the app builder model routing drifts from Qwen Q8 primary, Qwen Q6 fallback, and Codex verifier", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a focus timer for the Apple Store",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    const packet = await readBuildPacket(result.appDir);
    expect(packet).not.toBeNull();
    if (!packet) {
      return;
    }
    packet.modelRouting.builder.modelRef = "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest";
    packet.modelRouting.builder.quantization = "Q6_K";
    packet.modelRouting.localFallback.modelRef = "ollama/qwen3.6:27b-q8_0";
    packet.modelRouting.localFallback.quantization = "Q8_0";
    packet.modelRouting.disallowedReviewers = ["claude"];
    await writeFile(
      path.join(result.appDir, ".openclaw-app-builder", "build-packet.json"),
      `${JSON.stringify(packet, null, 2)}\n`,
      "utf8",
    );

    const validation = await validateIosApp(result.appDir, { checkToolchain: false });
    const gaps = await evaluateAppBuilderGaps(result.appDir);

    expect(validation.readyForLocalBuild).toBe(false);
    expect(validation.checks.find((check) => check.id === "model-routing")?.message).toContain(
      "builder must be ollama/qwen3.6:27b-q8_0",
    );
    expect(validation.checks.find((check) => check.id === "model-routing")?.message).toContain(
      "local fallback must be ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    );
    expect(gaps.gaps.map((gap) => gap.id)).toContain("model-routing");
  });

  it("verifies Qwen Q8 primary and Qwen Q6 fallback model readiness through the local Ollama API before autonomous mutation", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a focus timer for the Apple Store",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    await withFakeOllama(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            models: [
              {
                name: "qwen3.6:27b-q8_0",
                digest: "sha256:qwen-q8-test-digest",
              },
              {
                name: "openclaw-control-qwen3-30b-q6-chatfix:latest",
                digest: "sha256:qwen-q6-test-digest",
              },
            ],
          }),
        );
      },
      async (baseUrl) => {
        const report = await evaluateAppBuilderModelReadiness(result.appDir, {
          ollamaBaseUrl: baseUrl,
        });

        expect(report.ready).toBe(true);
        expect(report.builder.ollamaModel).toBe("qwen3.6:27b-q8_0");
        expect(report.builder.digest).toBe("sha256:qwen-q8-test-digest");
        expect(report.localFallback.ollamaModel).toBe(
          "openclaw-control-qwen3-30b-q6-chatfix:latest",
        );
        expect(report.localFallback.digest).toBe("sha256:qwen-q6-test-digest");
        expect(report.checks.find((check) => check.id === "qwen-q8-primary-local")?.ok).toBe(
          true,
        );
        expect(report.checks.find((check) => check.id === "qwen-q6-local-fallback")?.ok).toBe(
          true,
        );
      },
    );
  });

  it("fails App Store readiness until Apple metadata, signing, screenshots, and privacy evidence are filled", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a recipe app for the Apple Store",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const report = await evaluateAppStoreReadiness(result.appDir);

    expect(report.readyForTestFlightUpload).toBe(false);
    expect(report.readyForAppReviewSubmission).toBe(false);
    expect(report.blockedGates).toContain("app-record");
    expect(report.blockedGates).toContain("signing");
    expect(report.blockedGates).toContain("api-key-profile");
    expect(report.blockedGates).toContain("privacy-url");
  });

  it("accepts screenshot and metadata evidence for App Review readiness", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a recipe app for the Apple Store",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await mkdir(path.join(result.appDir, "Screenshots"), { recursive: true });
    await writeFile(path.join(result.appDir, "Screenshots", "iphone-17-pro.png"), "png");
    await writeFile(
      path.join(result.appDir, "AppStore", "app-store-connect.json"),
      `${JSON.stringify(
        {
          bundleId: result.spec.bundleId,
          appStoreConnectAppId: "1234567890",
          sku: "recipe-app-ios",
          teamId: "ABCDE12345",
          signingIdentity: "Apple Distribution: Example",
          provisioningProfile: "Recipe App Store Profile",
          version: "1.0",
          buildNumber: "1",
          apiKeyProfileRef: "openclaw-appstore-api",
        },
        null,
        2,
      )}\n`,
    );
    const metadataPath = path.join(result.appDir, "AppStore", "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.supportUrl = "https://example.com/support";
    metadata.privacyUrl = "https://example.com/privacy";
    metadata.reviewContact = {
      firstName: "App",
      lastName: "Reviewer",
      phone: "+15555550123",
      email: "review@example.com",
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const report = await evaluateAppStoreReadiness(result.appDir);

    expect(report.readyForTestFlightUpload).toBe(true);
    expect(report.readyForAppReviewSubmission).toBe(true);
    expect(report.blockedGates).toEqual([]);
    expect(report.requiredEvidence.find((item) => item.id === "screenshots")?.present).toBe(true);
  });

  it("fails simulator screenshot capture closed when app-builder artifacts are missing", async () => {
    const root = await makeTempDir();

    const report = await captureIosSimulatorScreenshot(root, { writeReport: false });

    expect(report.ready).toBe(false);
    expect(report.nextActions.join("\n")).toContain("product-spec.json");
    expect(report.commands).toHaveLength(0);
  });

  it("writes a non-executing App Store publish plan with rollback steps", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a recipe app for the Apple Store",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const plan = await createAppStorePublishPlan(result.appDir);

    expect(plan.actionable).toBe(false);
    expect(plan.blockedGates).toContain("app-record");
    expect(plan.commands.map((command) => command.id)).toEqual([
      "generate-project",
      "archive",
      "export",
      "upload-testflight",
    ]);
    expect(plan.commands.every((command) => command.command.length > 0)).toBe(true);
    expect(plan.rollbackPlan.join("\n")).toContain("TestFlight build");
  });

  it("writes a prioritized gap report for generated apps", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a recipe app for the Apple Store",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const report = await evaluateAppBuilderGaps(result.appDir);
    const reportText = await readFile(
      path.join(result.appDir, ".openclaw-app-builder", "gap-report.json"),
      "utf8",
    );

    expect(report.score).toBeLessThan(10);
    expect(report.readyForAutonomousBuild).toBe(false);
    expect(report.gaps.map((gap) => gap.id)).not.toContain("product-spec-quality");
    expect(report.gaps.map((gap) => gap.id)).toContain("implementation-pass");
    expect(report.gaps.map((gap) => gap.id)).toContain("screenshot-evidence");
    expect(report.nextActions.length).toBeGreaterThan(0);
    expect(reportText).toContain("app-store-app-record");
  });

  it("applies a constrained implementation pass that renders all product-spec screens", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const report = await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });
    const appModels = await readFile(path.join(result.appDir, "Sources", "AppModels.swift"), "utf8");
    const contentView = await readFile(path.join(result.appDir, "Sources", "ContentView.swift"), "utf8");
    const gaps = await evaluateAppBuilderGaps(result.appDir);

    expect(report.ready).toBe(true);
    expect(report.engine).toBe("Codex GPT-5.5");
    expect(report.filesChanged).toEqual(["Sources/AppModels.swift", "Sources/ContentView.swift"]);
    expect(contentView).toContain("GeneratedFeatureView");
    expect(contentView).toContain("@State private var records");
    expect(contentView).toContain("LocalDraftRecord.load(for: AppFeature.defaults)");
    expect(contentView).toContain("LocalDraftRecord.save(newRecords)");
    expect(contentView).toContain("addRecord");
    expect(contentView).toContain("toggleRecord");
    expect(contentView).toContain("deleteRecords");
    expect(appModels).toContain("struct AppScreenFlow");
    expect(contentView).toContain("Connected screens");
    expect(contentView).toContain("NavigationLink");
    expect(contentView).toContain("Today");
    expect(contentView).toContain("Habits");
    expect(contentView).toContain("Streaks");
    expect(gaps.gaps.map((gap) => gap.id)).not.toContain("implementation-pass");
    expect(gaps.gaps.map((gap) => gap.id)).not.toContain("local-crud-scaffold");
    expect(gaps.gaps.map((gap) => gap.id)).not.toContain("local-persistence");
  });

  it("applies a guarded app-local patch plan and records transcript evidence", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });

    const report = await applyAppBuilderPatchPlan(result.appDir, {
      schemaVersion: 1,
      engine: "Codex GPT-5.5",
      objective: "Update generated app README with model patch transcript proof.",
      changes: [
        {
          path: "README.md",
          action: "write",
          contents: "# Habit Forge\n\nPatched by the guarded app-local patch executor.\n",
        },
      ],
      validation: { checkToolchain: false },
    });
    const stored = await readPatchReport(result.appDir);
    const readme = await readFile(path.join(result.appDir, "README.md"), "utf8");
    const gaps = await evaluateAppBuilderGaps(result.appDir);

    expect(report.ready).toBe(true);
    expect(report.changedFiles).toEqual(["README.md"]);
    expect(report.rejectedChanges).toEqual([]);
    expect(report.transcriptPath).toContain("patch-transcript.json");
    expect(stored?.ready).toBe(true);
    expect(readme).toContain("guarded app-local patch executor");
    expect(gaps.gaps.map((gap) => gap.id)).not.toContain("guarded-patch-executor");
  });

  it("rejects patch plans that escape the generated app directory", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });

    const report = await applyAppBuilderPatchPlan(result.appDir, {
      schemaVersion: 1,
      engine: "Codex GPT-5.5",
      objective: "Attempt an unsafe write.",
      changes: [
        {
          path: "../outside.txt",
          action: "write",
          contents: "nope",
        },
      ],
      validation: { checkToolchain: false },
    });

    expect(report.ready).toBe(false);
    expect(report.changedFiles).toEqual([]);
    expect(report.rejectedChanges[0]?.reason).toContain("inside the app directory");
  });

  it("does not partially apply a patch plan when any change is rejected", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });

    const readmePath = path.join(result.appDir, "README.md");
    const originalReadme = await readFile(readmePath, "utf8");
    const report = await applyAppBuilderPatchPlan(result.appDir, {
      schemaVersion: 1,
      engine: "Codex GPT-5.5",
      objective: "Attempt a mixed safe and unsafe write.",
      changes: [
        {
          path: "README.md",
          action: "write",
          contents: "# Habit Forge\n\nThis write should not happen because the plan is rejected.\n",
        },
        {
          path: "../outside.txt",
          action: "write",
          contents: "nope",
        },
      ],
      validation: { checkToolchain: false },
    });
    const readmeAfter = await readFile(readmePath, "utf8");

    expect(report.ready).toBe(false);
    expect(report.changedFiles).toEqual([]);
    expect(report.rejectedChanges[0]?.reason).toContain("inside the app directory");
    expect(readmeAfter).toBe(originalReadme);
  });

  it("rejects patch plans that traverse app-local symbolic links", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });

    const outside = path.join(root, "outside-target");
    await mkdir(outside, { recursive: true });
    await rm(path.join(result.appDir, "Privacy"), { recursive: true, force: true });
    await symlink(outside, path.join(result.appDir, "Privacy"));

    const report = await applyAppBuilderPatchPlan(result.appDir, {
      schemaVersion: 1,
      engine: "Codex GPT-5.5",
      objective: "Attempt to write through an app-local symlink.",
      changes: [
        {
          path: "Privacy/privacy-evidence.md",
          action: "write",
          contents: "nope",
        },
      ],
      validation: { checkToolchain: false },
    });

    expect(report.ready).toBe(false);
    expect(report.changedFiles).toEqual([]);
    expect(report.rejectedChanges[0]?.reason).toContain("symbolic links are not patchable");
  });

  it("repairs broken app-local SwiftUI source and records validation evidence", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });
    await writeFile(
      path.join(result.appDir, "Sources", "ContentView.swift"),
      'import SwiftUI\n\nstruct ContentView: View { var body: some View { Text("Broken") } }\n',
    );

    const report = await repairIosApp(result.appDir, {
      engine: "Codex GPT-5.5",
      checkToolchain: false,
    });
    const stored = await readRepairReport(result.appDir);
    const contentView = await readFile(path.join(result.appDir, "Sources", "ContentView.swift"), "utf8");
    const gaps = await evaluateAppBuilderGaps(result.appDir);

    expect(report.repaired).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.sourceChecksBefore.some((check) => !check.ok)).toBe(true);
    expect(report.sourceChecksAfter.every((check) => check.severity !== "critical" || check.ok)).toBe(
      true,
    );
    expect(report.validationAfter.readyForLocalBuild).toBe(true);
    expect(stored?.ready).toBe(true);
    expect(contentView).toContain("Add local record");
    expect(gaps.strengths).toContain("Repair loop evidence is present and validation passed after repair.");
  });

  it("writes an evidence-backed final verifier report", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a habit tracker for the Apple Store",
      appName: "Habit Forge",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    await applyAppBuilderImplementationPass(result.appDir, { engine: "Codex GPT-5.5" });
    await validateIosApp(result.appDir, { checkToolchain: false });
    await writeFile(
      path.join(result.appDir, ".openclaw-app-builder", "model-readiness-report.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appId: "habit-forge",
          appDir: result.appDir,
          checkedAt: "2026-05-13T12:01:00.000Z",
          ready: true,
          checks: [],
          builder: {
            modelRef: "ollama/qwen3.6:27b-q8_0",
            ollamaModel: "qwen3.6:27b-q8_0",
            digest: "sha256:builder",
            baseUrl: "http://127.0.0.1:11434",
          },
          localFallback: {
            modelRef: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
            ollamaModel: "openclaw-control-qwen3-30b-q6-chatfix:latest",
            digest: "sha256:fallback",
            baseUrl: "http://127.0.0.1:11434",
          },
          nextActions: [],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(result.appDir, "AppStore", "app-store-connect.json"),
      `${JSON.stringify(
        {
          bundleId: result.spec.bundleId,
          appStoreConnectAppId: "1234567890",
          sku: "habit-forge-ios",
          teamId: "ABCDE12345",
          signingIdentity: "Apple Distribution: Example",
          provisioningProfile: "Habit Forge App Store Profile",
          version: "1.0",
          buildNumber: "1",
          apiKeyProfileRef: "openclaw-appstore-api",
        },
        null,
        2,
      )}\n`,
    );
    await createAppStorePublishPlan(result.appDir);

    const report = await createAppBuilderFinalVerifierReport(result.appDir, {
      requireXcodebuild: false,
      checkToolchain: false,
    });
    const stored = await readFinalVerifierReport(result.appDir);

    expect(report.readyForTestFlight).toBe(true);
    expect(report.readyForAppReview).toBe(false);
    expect(report.blockedGates).toContain("screenshot-evidence");
    expect(report.checks.find((check) => check.id === "final-verifier-profile")?.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "local-persistence")?.ok).toBe(true);
    expect(stored?.readyForTestFlight).toBe(true);
  });

  it("produces a readiness report with completion grade and next gap", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a meditation app for iOS",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const report = await evaluateAppBuilderReadiness(result.appDir);

    expect(report.readyToBuild).toBeTypeOf("boolean");
    expect(report.completionGrade).toBeGreaterThanOrEqual(4);
    expect(report.criticalityOfNextGap).toBeGreaterThanOrEqual(8);
    expect(report.nextMostImpactfulGap.length).toBeGreaterThan(0);
  });

  it("preserves stronger prior simulator validation evidence when summarizing readiness", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a meditation app for iOS",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });
    const reportPath = path.join(
      result.appDir,
      ".openclaw-app-builder",
      "ios-validation-report.json",
    );
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appId: result.spec.appId,
          appDir: result.appDir,
          readyForLocalBuild: true,
          checkedAt: "2026-05-13T12:00:00.000Z",
          checks: [],
          commands: [
            {
              command: "xcodebuild test -scheme Meditation -destination simulator",
              skipped: false,
              ok: true,
              exitCode: 0,
              durationMs: 1,
              stdoutTail: "TEST SUCCEEDED",
              stderrTail: "",
            },
          ],
          nextActions: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const readiness = await evaluateAppBuilderReadiness(result.appDir);
    const preserved = await readIosValidationReport(result.appDir);

    expect(readiness.validation.commands[0]?.command).toContain("xcodebuild test");
    expect(preserved?.commands[0]?.stdoutTail).toBe("TEST SUCCEEDED");
  });

  it("creates a constrained builder dry-run task without editing app code", async () => {
    const root = await makeTempDir();
    const result = await createIosNativeApp({
      cwd: root,
      request: "Create a field notes app for iPhone",
      now: new Date("2026-05-13T12:00:00.000Z"),
    });

    const task = await createBuildDryRunTask(result.appDir);

    expect(task.taskPath).toBe(
      path.join(result.appDir, ".openclaw-app-builder", "builder-task.md"),
    );
    expect(task.text).toContain("Allowed Write Root");
    expect(task.text).toContain("Do not contact App Store Connect");
    expect(task.text).toContain("ollama/qwen3.6:27b-q8_0");
    expect(task.text).toContain("ollama/openclaw-control-qwen3-30b-q6-chatfix:latest");
    expect(task.text).toContain("Local fallback");
    expect(task.text).toContain('"think": false');
    expect(task.text).toContain("Disabled reviewers: claude, gemini");
  });
});

import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  applyAppBuilderImplementationPass,
  applyAppBuilderPatchPlan,
  checkIosToolchain,
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
  repairIosApp,
  type AppBuilderPatchPlan,
  validateIosApp,
} from "./app-builder.js";

type CreateOptions = {
  target?: string;
  name?: string;
  id?: string;
  bundleId?: string;
  outputDir?: string;
  force?: boolean;
  json?: boolean;
};

type ValidateOptions = {
  json?: boolean;
  runXcodegen?: boolean;
  runXcodebuild?: boolean;
  simulator?: string;
};

type ScreenshotOptions = {
  json?: boolean;
  simulator?: string;
};

type JsonOption = {
  json?: boolean;
};

type ModelCheckOptions = {
  json?: boolean;
  ollamaBaseUrl?: string;
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHumanHeading(text: string): void {
  console.log(text);
  console.log("-".repeat(text.length));
}

function markFailure(): void {
  process.exitCode = 1;
}

function requireIosNativeTarget(target: string | undefined, request: string): void {
  const resolved = target ?? inferAppBuilderTarget(request);
  if (resolved !== "ios-native") {
    throw new Error(
      `Unsupported apps target "${resolved}". This build currently supports --target ios-native.`,
    );
  }
}

export function registerAppsCli(program: Command): void {
  const apps = program
    .command("apps")
    .description("Create, validate, and prepare native apps")
    .addHelpText(
      "after",
      `\nExamples:\n  openclaw apps create "Create a habit tracker for the Apple Store" --name HabitForge\n  openclaw apps ios-toolchain --json\n  openclaw apps model-check ./generated-apps/habitforge --json\n  openclaw apps build ./generated-apps/habitforge --apply --engine "Codex GPT-5.5"\n  openclaw apps patch ./generated-apps/habitforge --plan patch-plan.json --run-xcodegen\n  openclaw apps repair ./generated-apps/habitforge --run-xcodegen\n  openclaw apps ios-validate ./generated-apps/habitforge --run-xcodegen\n  openclaw apps screenshots ./generated-apps/habitforge\n  openclaw apps app-store-ready ./generated-apps/habitforge\n  openclaw apps publish-plan ./generated-apps/habitforge\n  openclaw apps final-verify ./generated-apps/habitforge\n  openclaw apps gaps ./generated-apps/habitforge\n  openclaw apps ready ./generated-apps/habitforge --json\n\nSafety: generated apps are not uploaded, published, or submitted without separate explicit approvals.\nDocs: https://docs.openclaw.ai/cli/apps\n`,
    );

  apps
    .command("create")
    .description("Create a native SwiftUI/XcodeGen app scaffold from a prompt")
    .argument("<request...>", "User request for the app to create")
    .option("--target <target>", "App builder target (ios-native)")
    .option("--name <name>", "App display name")
    .option("--id <id>", "Stable app id/slug")
    .option("--bundle-id <id>", "Apple bundle identifier")
    .option("--output-dir <path>", "Output directory for the generated app")
    .option("--force", "Overwrite scaffold-owned files in a non-empty app directory", false)
    .option("--json", "Print JSON")
    .action(async (requestParts: string[], opts: CreateOptions) => {
      try {
        const request = requestParts.join(" ").trim();
        requireIosNativeTarget(opts.target, request);
        const result = await createIosNativeApp({
          request,
          appName: opts.name,
          appId: opts.id,
          bundleId: opts.bundleId,
          outputDir: opts.outputDir,
          force: opts.force,
        });
        if (opts.json) {
          printJson(result);
          return;
        }
        printHumanHeading("OpenClaw app created");
        console.log(`App: ${result.spec.appName}`);
        console.log(`Target: ${result.spec.target}`);
        console.log(`Directory: ${path.relative(process.cwd(), result.appDir) || "."}`);
        console.log(`Bundle ID: ${result.spec.bundleId}`);
        console.log("Next:");
        console.log(`  openclaw apps ios-validate ${shellPath(result.appDir)} --run-xcodegen`);
        console.log(`  openclaw apps ios-validate ${shellPath(result.appDir)} --run-xcodebuild`);
        console.log(`  openclaw apps screenshots ${shellPath(result.appDir)}`);
        console.log(`  openclaw apps app-store-ready ${shellPath(result.appDir)}`);
      } catch (error) {
        markFailure();
        console.error(formatError(error));
      }
    });

  apps
    .command("ios-toolchain")
    .description("Check local Xcode, simulator, and XcodeGen readiness")
    .option("--json", "Print JSON")
    .action(async (opts: JsonOption) => {
      const result = await checkIosToolchain();
      if (opts.json) {
        printJson(result);
      } else {
        printHumanHeading("iOS toolchain");
        for (const check of result.checks) {
          console.log(`${check.ok ? "OK" : "FAIL"} ${check.id}: ${check.detail || "available"}`);
        }
      }
      if (!result.ok) {
        markFailure();
      }
    });

  apps
    .command("build-packet")
    .description("Print the app-local constrained builder packet")
    .argument("<app-dir>", "Generated app directory")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: JsonOption) => {
      const packet = await readBuildPacket(appDir);
      if (!packet) {
        markFailure();
        console.error("Missing or invalid .openclaw-app-builder/build-packet.json");
        return;
      }
      if (opts.json) {
        printJson(packet);
        return;
      }
      printHumanHeading("Build packet");
      console.log(`Allowed write root: ${packet.allowedWriteRoot}`);
      console.log("Model routing:");
      console.log(`  Planner: ${packet.modelRouting.planner.modelRef}`);
      console.log(
        `  Builder: ${packet.modelRouting.builder.modelRef} (${packet.modelRouting.builder.quantization})`,
      );
      if (packet.modelRouting.localFallback) {
        console.log(
          `  Local fallback: ${packet.modelRouting.localFallback.modelRef} (${packet.modelRouting.localFallback.quantization})`,
        );
      } else {
        console.log("  Local fallback: missing");
      }
      console.log(`  Repair fallback: ${packet.modelRouting.repairFallback.modelRef}`);
      console.log(`  Final verifier: ${packet.modelRouting.finalVerifier.modelRef}`);
      if (packet.modelRouting.disallowedReviewers.length > 0) {
        console.log(`  Disabled reviewers: ${packet.modelRouting.disallowedReviewers.join(", ")}`);
      }
      console.log("Forbidden actions:");
      for (const action of packet.forbiddenActions) {
        console.log(`  - ${action}`);
      }
      console.log("Required validation:");
      for (const command of packet.requiredValidationCommands) {
        console.log(`  - ${command}`);
      }
    });

  apps
    .command("model-check")
    .description(
      "Verify the pinned Qwen Q8 primary and Qwen Q6 fallback models are reachable before autonomous mutation",
    )
    .argument("<app-dir>", "Generated app directory")
    .option("--ollama-base-url <url>", "Ollama base URL", "http://127.0.0.1:11434")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: ModelCheckOptions) => {
      const report = await evaluateAppBuilderModelReadiness(appDir, {
        ollamaBaseUrl: opts.ollamaBaseUrl,
      });
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("App builder model readiness");
        for (const check of report.checks) {
          console.log(`${check.ok ? "OK" : "BLOCKED"} ${check.id}: ${check.message}`);
        }
        console.log(`Ready: ${report.ready ? "yes" : "no"}`);
        if (report.nextActions.length > 0) {
          console.log("Next actions:");
          for (const action of report.nextActions) {
            console.log(`  - ${action}`);
          }
        }
      }
      if (!report.ready) {
        markFailure();
      }
    });

  apps
    .command("build")
    .description("Create or apply a constrained app-local builder task")
    .argument("<app-dir>", "Generated app directory")
    .option("--dry-run", "Generate the task prompt only", false)
    .option("--apply", "Apply the deterministic app-local SwiftUI implementation pass", false)
    .option("--engine <engine>", "Engine label to record in implementation evidence")
    .option("--json", "Print JSON")
    .action(
      async (
        appDir: string,
        opts: JsonOption & { dryRun?: boolean; apply?: boolean; engine?: string },
      ) => {
        if (!opts.dryRun && !opts.apply) {
          markFailure();
          console.error(
            "Choose --dry-run to create the constrained task prompt or --apply to run the app-local implementation pass.",
          );
          return;
        }
        if (opts.dryRun && opts.apply) {
          markFailure();
          console.error("Choose only one of --dry-run or --apply.");
          return;
        }
        try {
          if (opts.apply) {
            const result = await applyAppBuilderImplementationPass(appDir, { engine: opts.engine });
            if (opts.json) {
              printJson(result);
              return;
            }
            printHumanHeading("Implementation pass");
            console.log(`Ready: ${result.ready ? "yes" : "no"}`);
            console.log(`Engine: ${result.engine}`);
            console.log(`Files changed: ${result.filesChanged.join(", ") || "none"}`);
            for (const check of result.checks) {
              console.log(`${check.ok ? "OK" : "BLOCKED"} ${check.id}: ${check.message}`);
            }
            if (result.nextActions.length > 0) {
              console.log("Next actions:");
              for (const action of result.nextActions) {
                console.log(`  - ${action}`);
              }
            }
            if (!result.ready) {
              markFailure();
            }
            return;
          }
          const result = await createBuildDryRunTask(appDir);
          if (opts.json) {
            printJson(result);
            return;
          }
          printHumanHeading("Builder task created");
          console.log(result.taskPath);
        } catch (error) {
          markFailure();
          console.error(formatError(error));
        }
      },
    );

  apps
    .command("patch")
    .description("Apply a guarded app-local patch plan and record transcript evidence")
    .argument("<app-dir>", "Generated app directory")
    .requiredOption("--plan <path>", "JSON patch plan emitted by an approved app-builder engine")
    .option("--run-xcodegen", "Run xcodegen generate after applying the patch", false)
    .option("--run-xcodebuild", "Run xcodebuild test after applying the patch", false)
    .option("--simulator <name>", "Simulator name for xcodebuild", "iPhone 17 Pro")
    .option("--skip-toolchain-check", "Skip local xcodebuild/xcrun/xcodegen availability checks", false)
    .option("--json", "Print JSON")
    .action(
      async (
        appDir: string,
        opts: JsonOption & {
          plan: string;
          runXcodegen?: boolean;
          runXcodebuild?: boolean;
          simulator?: string;
          skipToolchainCheck?: boolean;
        },
      ) => {
        try {
          const parsed = JSON.parse(await readFile(path.resolve(opts.plan), "utf8")) as Record<
            string,
            unknown
          >;
          const plan = {
            ...parsed,
            validation: {
              ...(typeof parsed.validation === "object" && parsed.validation !== null
                ? (parsed.validation as Record<string, unknown>)
                : {}),
              ...(opts.runXcodegen ? { runXcodegen: true } : {}),
              ...(opts.runXcodebuild ? { runXcodebuild: true } : {}),
              ...(opts.simulator ? { simulator: opts.simulator } : {}),
              ...(opts.skipToolchainCheck ? { checkToolchain: false } : {}),
            },
          };
          const report = await applyAppBuilderPatchPlan(appDir, plan as AppBuilderPatchPlan);
          if (opts.json) {
            printJson(report);
            return;
          }
          printHumanHeading("Patch executor");
          console.log(`Ready: ${report.ready ? "yes" : "no"}`);
          console.log(`Engine: ${report.engine}`);
          console.log(`Changed files: ${report.changedFiles.join(", ") || "none"}`);
          for (const rejected of report.rejectedChanges) {
            console.log(`REJECTED ${rejected.path}: ${rejected.reason}`);
          }
          for (const check of report.checks) {
            console.log(`${check.ok ? "OK" : "BLOCKED"} ${check.id}: ${check.message}`);
          }
          if (!report.ready) {
            markFailure();
          }
        } catch (error) {
          markFailure();
          console.error(formatError(error));
        }
      },
    );

  apps
    .command("repair")
    .description("Run the app-local repair loop and rerun validation evidence")
    .argument("<app-dir>", "Generated app directory")
    .option("--engine <engine>", "Engine label to record in repair evidence")
    .option("--run-xcodegen", "Run xcodegen generate during validation", false)
    .option("--run-xcodebuild", "Run xcodebuild test during validation", false)
    .option("--simulator <name>", "Simulator name for xcodebuild", "iPhone 17 Pro")
    .option("--force", "Run the repair implementation pass even if the app already looks valid", false)
    .option("--json", "Print JSON")
    .action(
      async (
        appDir: string,
        opts: JsonOption & {
          engine?: string;
          runXcodegen?: boolean;
          runXcodebuild?: boolean;
          simulator?: string;
          force?: boolean;
        },
      ) => {
        try {
          const report = await repairIosApp(appDir, {
            engine: opts.engine,
            runXcodegen: opts.runXcodegen,
            runXcodebuild: opts.runXcodebuild,
            simulator: opts.simulator,
            force: opts.force,
          });
          if (opts.json) {
            printJson(report);
            return;
          }
          printHumanHeading("Repair loop");
          console.log(`Ready: ${report.ready ? "yes" : "no"}`);
          console.log(`Repaired: ${report.repaired ? "yes" : "no"}`);
          console.log(`Engine: ${report.engine}`);
          for (const check of report.sourceChecksAfter) {
            console.log(`${check.ok ? "OK" : "BLOCKED"} ${check.id}: ${check.message}`);
          }
          console.log(
            `Validation after repair: ${report.validationAfter.readyForLocalBuild ? "passed" : "blocked"}`,
          );
          if (report.nextActions.length > 0) {
            console.log("Next actions:");
            for (const action of report.nextActions) {
              console.log(`  - ${action}`);
            }
          }
          if (!report.ready) {
            markFailure();
          }
        } catch (error) {
          markFailure();
          console.error(formatError(error));
        }
      },
    );

  apps
    .command("ios-validate")
    .description("Validate a generated native iOS app scaffold")
    .argument("<app-dir>", "Generated app directory")
    .option("--run-xcodegen", "Run xcodegen generate", false)
    .option("--run-xcodebuild", "Run xcodebuild test on the iOS simulator", false)
    .option("--simulator <name>", "Simulator name for xcodebuild", "iPhone 17 Pro")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: ValidateOptions) => {
      const report = await validateIosApp(appDir, opts);
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("iOS validation");
        for (const check of report.checks) {
          console.log(`${check.ok ? "OK" : "FAIL"} ${check.id}: ${check.message}`);
        }
        for (const command of report.commands) {
          console.log(`${command.ok ? "OK" : "FAIL"} ${command.command} (${command.durationMs}ms)`);
          if (!command.ok && command.stderrTail) {
            console.log(command.stderrTail);
          }
        }
        console.log(`Ready for local build: ${report.readyForLocalBuild ? "yes" : "no"}`);
        if (report.nextActions.length > 0) {
          console.log("Next actions:");
          for (const action of report.nextActions) {
            console.log(`  - ${action}`);
          }
        }
      }
      if (!report.readyForLocalBuild) {
        markFailure();
      }
    });

  apps
    .command("screenshots")
    .description("Install, launch, and capture simulator screenshot evidence")
    .argument("<app-dir>", "Generated app directory")
    .option("--simulator <name>", "Simulator name", "iPhone 17 Pro")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: ScreenshotOptions) => {
      const report = await captureIosSimulatorScreenshot(appDir, opts);
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("Simulator screenshot");
        console.log(
          `Simulator: ${report.simulator.resolvedName ?? report.simulator.requestedName}`,
        );
        console.log(`App bundle: ${report.appBundlePath ?? "not built"}`);
        console.log(`Screenshot: ${report.screenshotPath ?? "not captured"}`);
        for (const command of report.commands) {
          console.log(`${command.ok ? "OK" : "FAIL"} ${command.command} (${command.durationMs}ms)`);
          if (!command.ok && command.stderrTail) {
            console.log(command.stderrTail);
          }
        }
        if (report.nextActions.length > 0) {
          console.log("Next actions:");
          for (const action of report.nextActions) {
            console.log(`  - ${action}`);
          }
        }
      }
      if (!report.ready) {
        markFailure();
      }
    });

  apps
    .command("app-store-ready")
    .description("Check App Store/TestFlight evidence gates without uploading")
    .argument("<app-dir>", "Generated app directory")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: JsonOption) => {
      const report = await evaluateAppStoreReadiness(appDir);
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("App Store readiness");
        for (const item of report.requiredEvidence) {
          console.log(`${item.present ? "OK" : "BLOCKED"} ${item.id}: ${item.label}`);
        }
        console.log(
          `Ready for TestFlight upload: ${report.readyForTestFlightUpload ? "yes" : "no"}`,
        );
        console.log(
          `Ready for App Review submission: ${report.readyForAppReviewSubmission ? "yes" : "no"}`,
        );
        if (report.nextActions.length > 0) {
          console.log("Next actions:");
          for (const action of report.nextActions) {
            console.log(`  - ${action}`);
          }
        }
      }
      if (!report.readyForAppReviewSubmission) {
        markFailure();
      }
    });

  apps
    .command("publish-plan")
    .description("Write a gated App Store/TestFlight archive, export, upload, and rollback plan")
    .argument("<app-dir>", "Generated app directory")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: JsonOption) => {
      const plan = await createAppStorePublishPlan(appDir);
      if (opts.json) {
        printJson(plan);
      } else {
        printHumanHeading("App Store publish plan");
        console.log(`Actionable: ${plan.actionable ? "yes" : "no"}`);
        if (plan.blockedGates.length > 0) {
          console.log(`Blocked gates: ${plan.blockedGates.join(", ")}`);
        }
        console.log("Commands:");
        for (const command of plan.commands) {
          console.log(`  - ${command.id}: ${command.command}`);
        }
        console.log("Rollback:");
        for (const step of plan.rollbackPlan) {
          console.log(`  - ${step}`);
        }
      }
      if (!plan.actionable) {
        markFailure();
      }
    });

  apps
    .command("final-verify")
    .description("Write the evidence-backed final verifier report without uploading or submitting")
    .argument("<app-dir>", "Generated app directory")
    .option(
      "--allow-structural-validation",
      "Do not require prior xcodebuild simulator test evidence",
      false,
    )
    .option("--skip-toolchain-check", "Skip local xcodebuild/xcrun/xcodegen availability checks", false)
    .option("--json", "Print JSON")
    .action(async (
      appDir: string,
      opts: JsonOption & { allowStructuralValidation?: boolean; skipToolchainCheck?: boolean },
    ) => {
      const report = await createAppBuilderFinalVerifierReport(appDir, {
        requireXcodebuild: !opts.allowStructuralValidation,
        checkToolchain: opts.skipToolchainCheck ? false : undefined,
      });
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("Final verifier");
        console.log(`Ready for TestFlight: ${report.readyForTestFlight ? "yes" : "no"}`);
        console.log(`Ready for App Review: ${report.readyForAppReview ? "yes" : "no"}`);
        for (const check of report.checks) {
          console.log(`${check.ok ? "OK" : "BLOCKED"} ${check.id}: ${check.message}`);
        }
        if (report.nextActions.length > 0) {
          console.log("Next actions:");
          for (const action of report.nextActions) {
            console.log(`  - ${action}`);
          }
        }
      }
      if (!report.readyForTestFlight) {
        markFailure();
      }
    });

  apps
    .command("gaps")
    .description("Write and print a prioritized app-builder gap report")
    .argument("<app-dir>", "Generated app directory")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: JsonOption) => {
      const report = await evaluateAppBuilderGaps(appDir);
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("App builder gaps");
        console.log(`Score: ${report.score}/10`);
        console.log(`Ready for autonomous build: ${report.readyForAutonomousBuild ? "yes" : "no"}`);
        console.log(`Ready for publish planning: ${report.readyForPublishPlanning ? "yes" : "no"}`);
        if (report.gaps.length === 0) {
          console.log("No gaps found.");
        } else {
          console.log("Top gaps:");
          for (const gap of report.gaps.slice(0, 10)) {
            console.log(`  - [${gap.severity}] ${gap.title}: ${gap.remediation}`);
          }
        }
      }
      if (report.gaps.some((gap) => gap.severity === "critical")) {
        markFailure();
      }
    });

  apps
    .command("ready")
    .description("Summarize build readiness, App Store readiness, completion grade, and next gap")
    .argument("<app-dir>", "Generated app directory")
    .option("--json", "Print JSON")
    .action(async (appDir: string, opts: JsonOption) => {
      const report = await evaluateAppBuilderReadiness(appDir);
      if (opts.json) {
        printJson(report);
      } else {
        printHumanHeading("App builder readiness");
        console.log(`Ready to build: ${report.readyToBuild ? "yes" : "no"}`);
        console.log(`Ready for App Store: ${report.readyForAppStore ? "yes" : "no"}`);
        console.log(`Completion Grade: ${report.completionGrade}/10`);
        console.log(`Criticality: ${report.criticalityOfNextGap}/10`);
        console.log(`Next most impactful gap: ${report.nextMostImpactfulGap}`);
        console.log(report.why);
      }
      if (!report.readyToBuild) {
        markFailure();
      }
    });

  apps.action(() => {
    apps.outputHelp();
    process.exitCode = 0;
  });
}

function shellPath(value: string): string {
  const relative = path.relative(process.cwd(), value) || ".";
  return relative.includes(" ") ? JSON.stringify(relative) : relative;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { appendFileSync } from "node:fs";
import { buildCIExecutionManifest } from "./test-planner/planner.mjs";

const WORKFLOWS = new Set(["ci", "install-smoke"]);

const parseArgs = (argv) => {
  const parsed = {
    workflow: "ci",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workflow") {
      const nextValue = argv[index + 1] ?? "";
      if (!WORKFLOWS.has(nextValue)) {
        throw new Error(
          `Unsupported --workflow value "${String(nextValue || "<missing>")}". Supported values: ci, install-smoke.`,
        );
      }
      parsed.workflow = nextValue;
      index += 1;
    }
  }
  return parsed;
};

const outputPath = process.env.GITHUB_OUTPUT;

if (!outputPath) {
  throw new Error("GITHUB_OUTPUT is required");
}

const { workflow } = parseArgs(process.argv.slice(2));
const manifest = buildCIExecutionManifest(undefined, { env: process.env });

const writeOutput = (name, value) => {
  appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
};

if (workflow === "ci") {
  writeOutput("docs_only", String(manifest.scope.docsOnly));
  writeOutput("docs_changed", String(manifest.scope.docsChanged));
  writeOutput("run_node", String(manifest.scope.runNode));
  writeOutput("run_macos", String(manifest.scope.runMacos));
  writeOutput("run_android", String(manifest.scope.runAndroid));
  writeOutput("run_skills_python", String(manifest.scope.runSkillsPython));
  writeOutput("run_windows", String(manifest.scope.runWindows));
  writeOutput("has_changed_extensions", String(manifest.scope.hasChangedExtensions));
  writeOutput("changed_extensions_matrix", JSON.stringify(manifest.scope.changedExtensionsMatrix));
  writeOutput("run_build_artifacts", String(manifest.jobs.buildArtifacts.enabled));
  writeOutput("run_checks_fast", String(manifest.jobs.checksFast.enabled));
  writeOutput("checks_fast_matrix", JSON.stringify(manifest.jobs.checksFast.matrix));
  writeOutput("run_checks", String(manifest.jobs.checks.enabled));
  writeOutput("checks_matrix", JSON.stringify(manifest.jobs.checks.matrix));
  writeOutput("run_extension_fast", String(manifest.jobs.extensionFast.enabled));
  writeOutput("extension_fast_matrix", JSON.stringify(manifest.jobs.extensionFast.matrix));
  writeOutput("run_check", String(manifest.jobs.check.enabled));
  writeOutput("run_check_additional", String(manifest.jobs.checkAdditional.enabled));
  writeOutput("run_build_smoke", String(manifest.jobs.buildSmoke.enabled));
  writeOutput("run_check_docs", String(manifest.jobs.checkDocs.enabled));
  writeOutput("run_skills_python_job", String(manifest.jobs.skillsPython.enabled));
  writeOutput("run_checks_windows", String(manifest.jobs.checksWindows.enabled));
  writeOutput("checks_windows_matrix", JSON.stringify(manifest.jobs.checksWindows.matrix));
  writeOutput("run_macos_node", String(manifest.jobs.macosNode.enabled));
  writeOutput("macos_node_matrix", JSON.stringify(manifest.jobs.macosNode.matrix));
  writeOutput("run_macos_swift", String(manifest.jobs.macosSwift.enabled));
  writeOutput("run_android_job", String(manifest.jobs.android.enabled));
  writeOutput("android_matrix", JSON.stringify(manifest.jobs.android.matrix));
  writeOutput("required_check_names", JSON.stringify(manifest.requiredCheckNames));
} else if (workflow === "install-smoke") {
  writeOutput("docs_only", String(manifest.scope.docsOnly));
  writeOutput("run_install_smoke", String(manifest.jobs.installSmoke.enabled));
}

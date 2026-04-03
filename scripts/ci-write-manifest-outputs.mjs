import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "") {
    return false;
  }
  return defaultValue;
};

const parseJsonEnv = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const createMatrix = (include) => ({ include });

export function buildWorkflowManifest(env = process.env, workflow = "ci") {
  const eventName = env.GITHUB_EVENT_NAME ?? "pull_request";
  const isPush = eventName === "push";
  const docsOnly = parseBooleanEnv(env.OPENCLAW_CI_DOCS_ONLY);
  const docsChanged = parseBooleanEnv(env.OPENCLAW_CI_DOCS_CHANGED);
  const runNode = parseBooleanEnv(env.OPENCLAW_CI_RUN_NODE);
  const runMacos = parseBooleanEnv(env.OPENCLAW_CI_RUN_MACOS);
  const runAndroid = parseBooleanEnv(env.OPENCLAW_CI_RUN_ANDROID);
  const runWindows = parseBooleanEnv(env.OPENCLAW_CI_RUN_WINDOWS);
  const runSkillsPython = parseBooleanEnv(env.OPENCLAW_CI_RUN_SKILLS_PYTHON);
  const hasChangedExtensions = parseBooleanEnv(env.OPENCLAW_CI_HAS_CHANGED_EXTENSIONS);
  const changedExtensionsMatrix = parseJsonEnv(env.OPENCLAW_CI_CHANGED_EXTENSIONS_MATRIX, {
    include: [],
  });
  const runChangedSmoke = parseBooleanEnv(env.OPENCLAW_CI_RUN_CHANGED_SMOKE);

  const checksFastMatrix = createMatrix(
    runNode
      ? [
          { check_name: "checks-fast-bundled", runtime: "node", task: "bundled" },
          { check_name: "checks-fast-extensions", runtime: "node", task: "extensions" },
          {
            check_name: "checks-fast-contracts-protocol",
            runtime: "node",
            task: "contracts-protocol",
          },
        ]
      : [],
  );

  const checksMatrixInclude = runNode
    ? [
        { check_name: "checks-node-test", runtime: "node", task: "test" },
        { check_name: "checks-node-channels", runtime: "node", task: "channels" },
        ...(isPush
          ? [
              {
                check_name: "checks-node-compat-node22",
                runtime: "node",
                task: "compat-node22",
                node_version: "22.x",
                cache_key_suffix: "node22",
              },
            ]
          : []),
      ]
    : [];

  const windowsMatrix = createMatrix(
    runWindows ? [{ check_name: "checks-windows-node-test", runtime: "node", task: "test" }] : [],
  );
  const macosNodeMatrix = createMatrix(
    runMacos ? [{ check_name: "macos-node", runtime: "node", task: "test" }] : [],
  );
  const androidMatrix = createMatrix(
    runAndroid
      ? [
          { check_name: "android-test-play", task: "test-play" },
          { check_name: "android-test-third-party", task: "test-third-party" },
          { check_name: "android-build-play", task: "build-play" },
          { check_name: "android-build-third-party", task: "build-third-party" },
        ]
      : [],
  );
  const extensionFastMatrix = createMatrix(
    hasChangedExtensions
      ? (changedExtensionsMatrix.include ?? []).map((entry) => ({
          check_name: `extension-fast-${entry.extension}`,
          extension: entry.extension,
        }))
      : [],
  );

  if (workflow === "install-smoke") {
    return {
      docs_only: docsOnly,
      run_install_smoke: !docsOnly && runChangedSmoke,
    };
  }

  return {
    docs_only: docsOnly,
    docs_changed: docsChanged,
    run_node: !docsOnly && runNode,
    run_macos: !docsOnly && runMacos,
    run_android: !docsOnly && runAndroid,
    run_skills_python: !docsOnly && runSkillsPython,
    run_windows: !docsOnly && runWindows,
    has_changed_extensions: !docsOnly && hasChangedExtensions,
    changed_extensions_matrix: changedExtensionsMatrix,
    run_build_artifacts: !docsOnly && runNode,
    run_checks_fast: !docsOnly && runNode,
    checks_fast_matrix: checksFastMatrix,
    run_checks: !docsOnly && runNode,
    checks_matrix: createMatrix(checksMatrixInclude),
    run_extension_fast: !docsOnly && hasChangedExtensions,
    extension_fast_matrix: extensionFastMatrix,
    run_check: !docsOnly && runNode,
    run_check_additional: !docsOnly && runNode,
    run_build_smoke: !docsOnly && runNode,
    run_check_docs: docsChanged,
    run_skills_python_job: !docsOnly && runSkillsPython,
    run_checks_windows: !docsOnly && runWindows,
    checks_windows_matrix: windowsMatrix,
    run_macos_node: !docsOnly && runMacos,
    macos_node_matrix: macosNodeMatrix,
    run_macos_swift: !docsOnly && runMacos,
    run_android_job: !docsOnly && runAndroid,
    android_matrix: androidMatrix,
  };
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryHref) {
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }

  const { workflow } = parseArgs(process.argv.slice(2));
  const manifest = buildWorkflowManifest(process.env, workflow);

  const writeOutput = (name, value) => {
    appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  };

  for (const [key, value] of Object.entries(manifest)) {
    writeOutput(key, typeof value === "string" ? value : JSON.stringify(value));
  }
}

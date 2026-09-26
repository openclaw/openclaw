#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(command, args, cwd, options = {}) {
  const output = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return output?.trim() ?? "";
}

function git(root, ...args) {
  return run("git", args, root);
}

function clean(root) {
  if (git(root, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error(
      "Release commands require a clean checkout; commit or move your changes first.",
    );
  }
}

function mainSha(root) {
  git(root, "fetch", "--no-tags", "origin", "refs/heads/main");
  return git(root, "rev-parse", "FETCH_HEAD");
}

function uploadedRef(root, platform, plan, planPath) {
  if (platform === "android") {
    const [sha, ref] = run(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/mobile-release-ref.ts",
        "resolve",
        "--plan",
        planPath,
        "--root",
        root,
      ],
      root,
    ).split(/\s+/);
    if (sha !== plan.sourceSha || !ref) {
      throw new Error(
        "Android uploaded source ref does not match the saved plan. Inspect the store outcome and perform record-only recovery; do not upload again blindly.",
      );
    }
    return ref;
  }
  const version = platform === "ios" ? plan.appStoreVersion : plan.version;
  const build = platform === "ios" ? plan.buildNumber : plan.versionCode;
  if (!/^20\d{2}\.[1-9]\d?\.[1-9]\d*$/.test(version) || !Number.isSafeInteger(build) || build < 1) {
    throw new Error("Saved release plan has an invalid store identity.");
  }
  const ref = `refs/openclaw/mobile-releases/${platform}/${version}-${build}`;
  const row = git(root, "ls-remote", "--refs", "origin", ref).split(/\s+/);
  if (row[0] !== plan.sourceSha || row[1] !== ref) {
    throw new Error(
      `No matching upload record for ${ref}. Inspect the store outcome and use the record-only recovery command before continuing; do not upload again blindly.`,
    );
  }
  return ref;
}

function bridgeLocalTools(root, source, platform) {
  // Reuse installed dependencies; release source stays on the selected main commit.
  const manifests = git(root, "ls-files", "package.json", "**/package.json").split("\n");
  for (const manifest of manifests) {
    const relative = path.join(path.dirname(manifest), "node_modules");
    const installed = path.join(root, relative);
    const target = path.join(source, relative);
    if (fs.existsSync(installed) && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(installed, target, "dir");
    }
  }
  for (const relative of [
    `apps/${platform}/.bundle`,
    `apps/${platform}/fastlane/.env`,
    `apps/${platform}/fastlane/.env.default`,
    ...(platform === "android"
      ? ["apps/android/local.properties", "apps/android/build/release-signing"]
      : []),
  ]) {
    const local = path.join(root, relative);
    if (fs.existsSync(local)) {
      fs.cpSync(local, path.join(source, relative), { recursive: true });
    }
  }
}

function collectArtifacts(source, recovery, platform) {
  const directory = path.join(
    source,
    "apps",
    platform,
    "build",
    platform === "ios" ? "app-store" : "release-artifacts",
  );
  if (!fs.existsSync(directory)) {
    return;
  }
  const destination = path.join(recovery, "artifacts");
  for (const file of fs.readdirSync(directory)) {
    if (/\.(ipa|aab|apk|sha256)$/.test(file)) {
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(path.join(directory, file), path.join(destination, file));
    }
  }
}

function uploadArgs(plan) {
  return [
    "--version",
    plan.gatewayVersion,
    "--revision",
    String(plan.appStoreRevision),
    "--build-number",
    String(plan.buildNumber),
  ];
}

function releaseEnvironment(platform, recovery, sourceSha) {
  return {
    ...process.env,
    GIT_COMMIT: sourceSha,
    GIT_SHA: sourceSha,
    OPENCLAW_MOBILE_RELEASE_NOTES: path.join(recovery, "release-notes.json"),
    ...(platform === "android"
      ? { OPENCLAW_ANDROID_RELEASE_PLAN: path.join(recovery, "android-plan.json") }
      : { OPENCLAW_IOS_RELEASE_PLAN: path.join(recovery, "ios-plan.json") }),
  };
}

function retainSummary(artifactPath) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const summary = artifact.entries
    .map((entry) => `### ${entry.audience} release notes\n\n${entry.text}\n`)
    .join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

function prepareAndUpload(root, platform, recovery, releaseArgs) {
  clean(root);
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error(
      "Do not rerun the upload job. Inspect the original store outcome before starting a new release; iOS metadata staging has a separate recovery command.",
    );
  }
  if (git(root, "branch", "--show-current") !== "main") {
    throw new Error(
      "Start a release from a clean, current main checkout. This command never switches your branch.",
    );
  }
  const currentMain = mainSha(root);
  const sourceSha = git(root, "rev-parse", "HEAD");
  if (process.env.GITHUB_ACTIONS === "true") {
    git(root, "merge-base", "--is-ancestor", sourceSha, currentMain);
  } else if (sourceSha !== currentMain) {
    throw new Error("Local main differs from origin/main. Update it before starting the release.");
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to prepare store release notes.");
  }
  if (fs.existsSync(recovery) && fs.readdirSync(recovery).length) {
    throw new Error(
      "This recovery directory already contains an attempt. Inspect its outcome or use a new directory; never repeat an upload blindly.",
    );
  }
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  const source = path.join(recovery, "source");
  const planPath = path.join(recovery, `${platform}-plan.json`);
  const notesPath = path.join(recovery, "release-notes.json");
  git(root, "worktree", "add", "--detach", source, sourceSha);
  let completed = false;
  try {
    bridgeLocalTools(root, source, platform);
    let plan;
    if (platform === "ios") {
      plan = JSON.parse(
        run("/bin/bash", ["scripts/ios-release-plan.sh", "--json", ...releaseArgs], source),
      );
    } else {
      run(
        "/bin/bash",
        [
          "-c",
          'source scripts/lib/android-fastlane.sh; cd apps/android; run_android_fastlane android release_plan "output_path:$1"',
          "release-plan",
          planPath,
        ],
        source,
        { stdio: "inherit" },
      );
      plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    }
    plan.sourceSha = sourceSha;
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    run(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/mobile-release-notes.ts",
        "generate",
        "--platform",
        platform,
        "--plan",
        planPath,
        "--output",
        notesPath,
      ],
      source,
      { stdio: "inherit" },
    );
    retainSummary(notesPath);
    clean(source);
    if (git(source, "rev-parse", "HEAD") !== sourceSha) {
      throw new Error("Release preparation changed source identity.");
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `release_sha=${sourceSha}\nplatform=${platform}\n`,
      );
    }
    console.log(
      `Prepared ${platform} release from main source ${sourceSha}. Saved plan and notes: ${recovery}`,
    );
    run(
      "/bin/bash",
      [`scripts/${platform}-release-upload.sh`, ...(platform === "ios" ? uploadArgs(plan) : [])],
      source,
      {
        stdio: "inherit",
        env: releaseEnvironment(platform, recovery, sourceSha),
      },
    );
    console.log(`Verified uploaded release: ${uploadedRef(root, platform, plan, planPath)}`);
    completed = true;
  } finally {
    collectArtifacts(source, recovery, platform);
    if (completed) {
      git(root, "worktree", "remove", "--force", source);
    } else {
      console.error(
        `Release attempt retained at ${recovery}. Inspect the first failure and store state before another upload.`,
      );
    }
  }
}

function stageIos(root, recovery) {
  clean(root);
  const plan = JSON.parse(fs.readFileSync(path.join(recovery, "ios-plan.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(plan.sourceSha)) {
    throw new Error("Saved iOS plan must identify a full source SHA.");
  }
  const ref = uploadedRef(root, "ios", plan);
  git(root, "fetch", "--no-tags", "origin", ref);
  const source = path.join(recovery, "source");
  if (fs.existsSync(source)) {
    clean(source);
    if (git(source, "rev-parse", "HEAD") !== plan.sourceSha) {
      throw new Error("Retained source differs from the uploaded build.");
    }
  } else {
    git(root, "worktree", "add", "--detach", source, plan.sourceSha);
  }
  bridgeLocalTools(root, source, "ios");
  run("/bin/bash", ["scripts/ios-release-upload.sh", "--stage-only", ...uploadArgs(plan)], source, {
    stdio: "inherit",
    env: releaseEnvironment("ios", recovery, plan.sourceSha),
  });
  git(root, "worktree", "remove", "--force", source);
  console.log(`Staged saved notes and selected the already uploaded iOS build: ${ref}`);
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/mobile-release.mjs run --platform ios|android [--recovery-dir <directory>]\n       node scripts/mobile-release.mjs stage --platform ios --recovery-dir <directory>\nRun prepares notes and uploads unchanged main source. Stage retries only iOS metadata/build selection for a recorded upload, without uploading again or making Git commits.",
    );
    return;
  }
  const operation = args.shift();
  let platform;
  let recovery;
  const releaseArgs = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--") {
      continue;
    }
    if (
      !["--platform", "--recovery-dir", "--version", "--revision", "--build-number"].includes(arg)
    ) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}.`);
    }
    if (arg === "--platform") {
      platform = value;
    } else if (arg === "--recovery-dir") {
      recovery = path.resolve(value);
    } else {
      releaseArgs.push(arg, value);
    }
  }
  if (!["run", "stage"].includes(operation) || !["ios", "android"].includes(platform)) {
    throw new Error("Choose run or stage and --platform ios or android.");
  }
  if (releaseArgs.length && (operation !== "run" || platform !== "ios")) {
    throw new Error("Release overrides are accepted only for an iOS run.");
  }
  if (operation === "stage" && (platform !== "ios" || !recovery)) {
    throw new Error("Stage recovery requires --platform ios and --recovery-dir.");
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (!recovery) {
    const parent = path.join(root, ".artifacts");
    fs.mkdirSync(parent, { recursive: true });
    recovery = fs.mkdtempSync(path.join(parent, `${platform}-release-`));
  }
  // Recovery data must survive removing its source worktree.
  const relativeRecovery = path.relative(root, recovery);
  if (
    relativeRecovery === "" ||
    relativeRecovery.startsWith(`.git${path.sep}`) ||
    relativeRecovery === ".git"
  ) {
    throw new Error("Choose a dedicated release recovery directory outside .git.");
  }
  if (operation === "stage") {
    stageIos(root, recovery);
  } else {
    prepareAndUpload(root, platform, recovery, releaseArgs);
  }
}

try {
  runCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

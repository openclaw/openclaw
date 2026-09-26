#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const releasePaths = {
  ios: ["apps/ios/CHANGELOG.md"],
  android: [
    "apps/android/version.json",
    "apps/android/Config/Version.properties",
    "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
  ],
};

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

function assertPreparation(root, sha, platform) {
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Expected a full prepared release commit SHA.");
  }
  const parents = git(root, "rev-list", "--parents", "-n", "1", sha).split(" ");
  if (parents.length !== 2) {
    throw new Error("Release preparation must be one ordinary commit, without merge parents.");
  }
  const message = git(root, "show", "-s", "--format=%B", sha);
  if (!message.split("\n").includes(`Mobile-Release-Platform: ${platform}`)) {
    throw new Error("The prepared commit does not belong to this release platform.");
  }
  const changed = git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
    .split("\n")
    .filter(Boolean);
  for (const file of changed) {
    if (!releasePaths[platform].includes(file)) {
      throw new Error(`Release preparation changes an unexpected file: ${file}`);
    }
    if (git(root, "ls-tree", sha, "--", file).split(" ")[0] !== "100644") {
      throw new Error(`Release metadata must remain a regular file: ${file}`);
    }
  }
  return parents[1];
}

function uploadedRef(root, platform, sha) {
  const rows = git(root, "ls-remote", "origin", `refs/openclaw/mobile-releases/${platform}/*`);
  const refs = rows.split("\n").filter((row) => row.split(/\s+/)[0] === sha);
  if (refs.length === 0) {
    throw new Error(
      "The prepared commit has no successful upload record. Inspect the store outcome before recovery; do not upload again blindly.",
    );
  }
  return refs[0].split(/\s+/)[1];
}

function bridgeLocalTools(root, source, platform) {
  // Reuse installed dependencies; release source stays on the exact prepared commit.
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

function prepareAndUpload(root, platform, recovery, releaseArgs) {
  clean(root);
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error(
      "Do not rerun the upload job. Inspect the original store outcome, then rerun only Git finalization or start a new release.",
    );
  }
  if (git(root, "branch", "--show-current") !== "main") {
    throw new Error(
      "Start a release from a clean, current main checkout. This command never switches your branch.",
    );
  }
  const currentMain = mainSha(root);
  const base = git(root, "rev-parse", "HEAD");
  if (process.env.GITHUB_ACTIONS === "true") {
    // CI freezes source before installing its dependencies and toolchain.
    git(root, "merge-base", "--is-ancestor", base, currentMain);
  } else if (base !== currentMain) {
    throw new Error("Local main differs from origin/main. Update it before starting the release.");
  }
  git(root, "var", "GIT_AUTHOR_IDENT");
  git(root, "var", "GIT_COMMITTER_IDENT");
  const source = path.join(recovery, "source");
  if (fs.existsSync(source) || fs.existsSync(path.join(recovery, "release.bundle"))) {
    throw new Error(
      "This recovery directory already contains an attempt. Use finalize to recover it, or a new directory for a new release.",
    );
  }
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  git(root, "worktree", "add", "--detach", source, base);
  let uploaded = false;
  try {
    bridgeLocalTools(root, source, platform);
    let uploadArgs = releaseArgs;
    if (platform === "ios") {
      const planPath = path.join(recovery, "ios-plan.json");
      const planText = run(
        "/bin/bash",
        ["scripts/ios-release-plan.sh", "--json", ...releaseArgs],
        source,
      );
      const plan = JSON.parse(planText);
      fs.writeFileSync(planPath, planText, { mode: 0o600 });
      run(
        process.execPath,
        ["--import", "tsx", "scripts/ios-release-cut.ts", "--plan", planPath],
        source,
      );
      uploadArgs = [
        "--version",
        plan.gatewayVersion,
        "--revision",
        String(plan.appStoreRevision),
        "--build-number",
        String(plan.buildNumber),
      ];
    } else {
      const planPath = path.join(recovery, "android-plan.json");
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
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      run(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/android-pin-version.ts",
          "--version",
          plan.version,
          "--version-code",
          String(plan.versionCode),
        ],
        source,
        { stdio: "inherit" },
      );
    }
    git(source, "add", "--", ...releasePaths[platform]);
    const changed = git(source, "diff", "--cached", "--name-only");
    if (changed) {
      git(
        source,
        "commit",
        "-m",
        `chore(${platform}): prepare store release\n\nMobile-Release-Platform: ${platform}`,
      );
    }
    const sha = git(source, "rev-parse", "HEAD");
    if (changed) {
      assertPreparation(source, sha, platform);
    }
    clean(source);
    git(
      source,
      "bundle",
      "create",
      path.join(recovery, "release.bundle"),
      `${changed ? base : `${base}^`}..HEAD`,
    );
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `release_sha=${sha}\nplatform=${platform}\n`);
    }
    console.log(`Prepared ${platform} release source ${sha}. Recovery: ${recovery}`);
    run("/bin/bash", [`scripts/${platform}-release-upload.sh`, ...uploadArgs], source, {
      stdio: "inherit",
      env: { ...process.env, GIT_COMMIT: sha, GIT_SHA: sha },
    });
    console.log(`Verified uploaded release: ${uploadedRef(root, platform, sha)}`);
    uploaded = true;
    return sha;
  } finally {
    collectArtifacts(source, recovery, platform);
    if (uploaded) {
      git(root, "worktree", "remove", "--force", source);
    } else {
      console.error(
        `Release attempt retained at ${recovery}. Inspect the first failure and store state before another upload.`,
      );
    }
  }
}

function restoreBundle(root, recovery) {
  const bundle = path.join(recovery, "release.bundle");
  const heads = git(root, "bundle", "list-heads", bundle).split("\n");
  if (heads.length !== 1 || !heads[0].endsWith(" HEAD")) {
    throw new Error("Expected a recovery bundle with exactly one prepared HEAD.");
  }
  const sha = heads[0].split(" ")[0];
  git(root, "bundle", "verify", bundle);
  git(root, "fetch", "--no-tags", bundle, "HEAD");
  return sha;
}

async function finalize(root, platform, recovery, sourceSha) {
  clean(root);
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  const main = mainSha(root);
  let sha = sourceSha;
  if (sha) {
    const ref = uploadedRef(root, platform, sha);
    git(root, "fetch", "--no-tags", "origin", ref);
  } else {
    sha = restoreBundle(root, recovery);
  }
  const ref = uploadedRef(root, platform, sha);
  if (git(root, "merge-base", sha, main) === sha) {
    console.log(
      `Uploaded source ${sha} is already on main; no preparation changes need finalization.`,
    );
    return;
  }
  const base = assertPreparation(root, sha, platform);
  git(root, "merge-base", "--is-ancestor", base, main);
  const marker = `Mobile-Release-Source: ${sha}`;
  const landed = git(root, "log", main, "--format=%H", "--fixed-strings", `--grep=${marker}`);
  if (landed) {
    console.log(`Git finalization already recorded on main: ${landed.split("\n")[0]}`);
    return;
  }
  const branch = `release-metadata/${platform}-${sha}`;
  const repository = JSON.parse(
    run("gh", ["repo", "view", "--json", "nameWithOwner"], root),
  ).nameWithOwner;
  const gh = (args) => run("gh", [...args, "--repo", repository], root);
  let prs = JSON.parse(
    gh([
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      "main",
      "--state",
      "all",
      "--json",
      "number,state,headRefOid,url",
    ]),
  );
  if (prs.length > 1 || prs[0]?.state === "CLOSED") {
    throw new Error(`Resolve the existing finalization PR for ${branch} before retrying.`);
  }
  let pr = prs[0];
  if (!pr) {
    const work = path.join(recovery, "finalize");
    let published = false;
    try {
      const remote = git(root, "ls-remote", "origin", `refs/heads/${branch}`);
      let head;
      if (remote) {
        head = remote.split(/\s+/)[0];
        git(root, "fetch", "--no-tags", "origin", `refs/heads/${branch}`);
      } else {
        if (fs.existsSync(work)) {
          clean(work);
          head = git(work, "rev-parse", "HEAD");
          if (!git(work, "show", "-s", "--format=%B", head).split("\n").includes(marker)) {
            throw new Error(
              `Resolve the retained finalization workspace at ${work} before retrying.`,
            );
          }
        } else {
          git(root, "worktree", "add", "--detach", work, main);
          try {
            git(work, "cherry-pick", "--allow-empty", "--keep-redundant-commits", sha);
          } catch {
            throw new Error(
              `Store upload succeeded; resolve the Git conflict in ${work}. Preserve newer release notes/version data, run git cherry-pick --continue, and retain ${marker} in the final commit. Retry only finalization.`,
            );
          }
          git(
            work,
            "commit",
            "--amend",
            "--allow-empty",
            "-m",
            `chore(${platform}): record store release\n\nMobile-Release-Platform: ${platform}\n${marker}\nMobile-Release-Ref: ${ref}`,
          );
          head = git(work, "rev-parse", "HEAD");
        }
        assertPreparation(root, head, platform);
        git(work, "push", "origin", `HEAD:refs/heads/${branch}`);
      }
      const parent = assertPreparation(root, head, platform);
      git(root, "merge-base", "--is-ancestor", parent, main);
      const bodyPath = path.join(recovery, "finalization.md");
      fs.writeFileSync(
        bodyPath,
        `Records preparation metadata for the successfully uploaded ${platform} store release.\n\nBuild source: \`${sha}\`\nRelease record: \`${ref}\`\n\nThe store upload is complete. This PR only updates release metadata and must land with squash merging to preserve linear main history.\n`,
      );
      gh([
        "pr",
        "create",
        "--head",
        branch,
        "--base",
        "main",
        "--title",
        `chore(${platform}): record store release`,
        "--body-file",
        bodyPath,
      ]);
      prs = JSON.parse(
        gh([
          "pr",
          "list",
          "--head",
          branch,
          "--base",
          "main",
          "--state",
          "all",
          "--json",
          "number,state,headRefOid,url",
        ]),
      );
      pr = prs[0];
      if (!pr || pr.headRefOid !== head) {
        throw new Error(
          "Could not reconcile the created metadata PR. Retry finalization after inspecting GitHub.",
        );
      }
      published = true;
    } finally {
      if (published && fs.existsSync(work)) {
        git(root, "worktree", "remove", "--force", work);
      }
    }
  }
  git(root, "fetch", "--no-tags", "origin", `refs/heads/${branch}`);
  const parent = assertPreparation(root, pr.headRefOid, platform);
  git(root, "merge-base", "--is-ancestor", parent, main);
  if (!git(root, "show", "-s", "--format=%B", pr.headRefOid).split("\n").includes(marker)) {
    throw new Error("The finalization PR does not identify this uploaded source commit.");
  }
  if (pr.state !== "MERGED") {
    const mergeBody = path.join(recovery, "merge-message.txt");
    fs.writeFileSync(mergeBody, `${marker}\nMobile-Release-Ref: ${ref}\n`);
    gh([
      "pr",
      "merge",
      String(pr.number),
      "--squash",
      "--auto",
      "--match-head-commit",
      pr.headRefOid,
      "--subject",
      `chore(${platform}): record store release`,
      "--body-file",
      mergeBody,
    ]);
  }
  console.log(`Git finalization: ${pr.url}`);
  const deadline = Date.now() + 45 * 60_000;
  while (true) {
    const state = JSON.parse(
      gh(["pr", "view", String(pr.number), "--json", "state,headRefOid,mergeCommit"]),
    );
    if (state.headRefOid !== pr.headRefOid || state.state === "CLOSED") {
      throw new Error(`Finalization PR changed or closed: ${pr.url}. Inspect it before retrying.`);
    }
    if (state.state === "MERGED") {
      const currentMain = mainSha(root);
      git(root, "merge-base", "--is-ancestor", state.mergeCommit.oid, currentMain);
      if (
        git(root, "rev-list", "--parents", "-n", "1", state.mergeCommit.oid).split(" ").length !== 2
      ) {
        throw new Error(
          "Finalization landed with a merge commit; inspect repository merge settings.",
        );
      }
      console.log(
        `Release finalized on main at ${state.mergeCommit.oid}. Build source remains ${sha}.`,
      );
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Store upload succeeded; main finalization is still pending at ${pr.url}. Retry only finalization.`,
      );
    }
    await delay(10_000);
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/mobile-release.mjs <run|finalize> --platform <ios|android> [--recovery-dir <directory>] [--defer-finalization] [--source-sha <uploaded-commit>]\nRun prepares and uploads from clean current main. Finalize resumes Git recording only, without store access. Use --source-sha to recover an uploaded release whose Actions artifact is unavailable.",
    );
    return;
  }
  const operation = args.shift();
  let platform;
  let recovery;
  let sourceSha;
  let defer = false;
  const releaseArgs = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--") {
      continue;
    }
    if (arg === "--defer-finalization") {
      defer = true;
    } else if (
      [
        "--platform",
        "--recovery-dir",
        "--source-sha",
        "--version",
        "--revision",
        "--build-number",
      ].includes(arg)
    ) {
      const value = args.shift();
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      if (arg === "--platform") {
        platform = value;
      } else if (arg === "--recovery-dir") {
        recovery = path.resolve(value);
      } else if (arg === "--source-sha") {
        sourceSha = value;
      } else {
        releaseArgs.push(arg, value);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["run", "finalize"].includes(operation) || !Object.hasOwn(releasePaths, platform)) {
    throw new Error("Choose run or finalize and --platform ios or android.");
  }
  if (
    (operation === "finalize" && (defer || releaseArgs.length)) ||
    (platform === "android" && releaseArgs.length)
  ) {
    throw new Error("Release overrides are accepted only for an iOS run.");
  }
  if (sourceSha && (operation !== "finalize" || !/^[a-f0-9]{40}$/.test(sourceSha))) {
    throw new Error("--source-sha requires finalize and a full uploaded commit SHA.");
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (!recovery) {
    if ((operation === "finalize" && !sourceSha) || defer) {
      throw new Error("This operation requires --recovery-dir.");
    }
    const parent = path.join(root, ".artifacts");
    fs.mkdirSync(parent, { recursive: true });
    recovery = fs.mkdtempSync(path.join(parent, `${platform}-release-`));
  }
  if (operation === "run") {
    prepareAndUpload(root, platform, recovery, releaseArgs);
    if (defer) {
      return;
    }
  }
  await finalize(root, platform, recovery, sourceSha);
}

try {
  await runCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

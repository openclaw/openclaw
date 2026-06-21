#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readJsonFile, writeCanonicalJsonExclusive } from "./lib/release-policy-evidence.mjs";
import {
  verifyStableMainCloseout,
  verifyStrictStableMainCloseout,
} from "./lib/stable-release-closeout.mjs";

const STRICT_FLAGS = [
  "tag",
  "policy-main-dir",
  "policy-main-sha",
  "stable-source-dir",
  "stable-source-sha",
  "release-tag-dir",
  "release-tag-sha",
  "release-json",
  "publish-manifest",
  "publish-descriptor",
  "postpublish-evidence",
  "postpublish-descriptor",
  "full-release-validation-run-id",
  "release-publish-run-id",
  "rollback-drill-id",
  "rollback-drill-date",
  "output",
];
const SHA_RE = /^[0-9a-f]{40}$/u;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`${key} requires a value.`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }

  const required = [
    "tag",
    "main-dir",
    "tag-dir",
    "release-json",
    "full-release-validation-run-id",
    "release-publish-run-id",
    "rollback-drill-id",
    "rollback-drill-date",
    "output",
  ];
  for (const key of required) {
    if (!values.has(key)) {
      throw new Error(`--${key} is required.`);
    }
  }
  return Object.fromEntries(values);
}

function parseStrictArgs(argv) {
  if (argv.length !== STRICT_FLAGS.length * 2) {
    throw new Error(`expected exactly ${STRICT_FLAGS.length} strict flag/value pairs`);
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!STRICT_FLAGS.includes(name)) {
      throw new Error(`unknown strict argument: ${flag}`);
    }
    if (Object.hasOwn(values, name)) {
      throw new Error(`duplicate strict argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values[name] = value;
  }
  return values;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function gitSha(dir) {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function strictPath(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be absolute`);
  }
  return path;
}

function verifyStrictCheckout(path, expectedSha, label) {
  strictPath(path, label);
  if (!SHA_RE.test(expectedSha)) {
    throw new Error(`${label} SHA must be 40 lowercase hexadecimal characters`);
  }
  const directory = realpathSync(path);
  if (!statSync(directory).isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  const head = git(directory, ["rev-parse", "HEAD"]);
  if (head !== expectedSha) {
    throw new Error(`${label} HEAD ${head} does not match ${expectedSha}`);
  }
  if (git(directory, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error(`${label} checkout must be clean`);
  }
  return directory;
}

function runLegacy(argv) {
  const args = parseArgs(argv);
  const mainDir = resolve(args["main-dir"]);
  const tagDir = resolve(args["tag-dir"]);
  const result = verifyStableMainCloseout({
    tag: args.tag,
    mainPackageJson: readJson(resolve(mainDir, "package.json")),
    tagPackageJson: readJson(resolve(tagDir, "package.json")),
    mainChangelog: readFileSync(resolve(mainDir, "CHANGELOG.md"), "utf8"),
    tagChangelog: readFileSync(resolve(tagDir, "CHANGELOG.md"), "utf8"),
    mainAppcast: readFileSync(resolve(mainDir, "appcast.xml"), "utf8"),
    release: readJson(resolve(args["release-json"])),
    releaseTagSha: gitSha(tagDir),
    mainSha: gitSha(mainDir),
    fullReleaseValidationRunId: args["full-release-validation-run-id"],
    releasePublishRunId: args["release-publish-run-id"],
    rollbackDrillId: args["rollback-drill-id"],
    rollbackDrillDate: args["rollback-drill-date"],
    allowStaleRollbackDrill: args["allow-stale-rollback-drill"] === "true",
    nowMs: Date.now(),
  });
  if (result.errors.length > 0 || !result.manifest) {
    throw new Error(`stable main closeout failed:\n- ${result.errors.join("\n- ")}`);
  }

  writeFileSync(resolve(args.output), `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`stable main closeout verified: ${args.tag}`);
}

function runStrict(argv) {
  const args = parseStrictArgs(argv);
  const policyMainDir = verifyStrictCheckout(
    args["policy-main-dir"],
    args["policy-main-sha"],
    "policy-main-dir",
  );
  const stableSourceDir = verifyStrictCheckout(
    args["stable-source-dir"],
    args["stable-source-sha"],
    "stable-source-dir",
  );
  const releaseTagDir = verifyStrictCheckout(
    args["release-tag-dir"],
    args["release-tag-sha"],
    "release-tag-dir",
  );
  for (const name of [
    "release-json",
    "publish-manifest",
    "publish-descriptor",
    "postpublish-evidence",
    "postpublish-descriptor",
    "output",
  ]) {
    strictPath(args[name], `--${name}`);
  }
  const release = readJsonFile(args["release-json"], "release JSON");
  const publish = readJsonFile(args["publish-manifest"], "publish manifest");
  const publishDescriptor = readJsonFile(args["publish-descriptor"], "publish descriptor");
  const postpublish = readJsonFile(args["postpublish-evidence"], "postpublish evidence");
  const postpublishDescriptor = readJsonFile(
    args["postpublish-descriptor"],
    "postpublish descriptor",
  );
  const stableLines = readJsonFile(
    resolve(policyMainDir, "release/stable-lines.json"),
    "stable lines",
  );
  const result = verifyStrictStableMainCloseout({
    tag: args.tag,
    policyMainSha: args["policy-main-sha"],
    stableSourceSha: args["stable-source-sha"],
    releaseTagSha: args["release-tag-sha"],
    policyMainAppcast: readFileSync(resolve(policyMainDir, "appcast.xml"), "utf8"),
    stableLines: stableLines.value,
    stableSourcePackageJson: readJson(resolve(stableSourceDir, "package.json")),
    tagPackageJson: readJson(resolve(releaseTagDir, "package.json")),
    stableSourceChangelog: readFileSync(resolve(stableSourceDir, "CHANGELOG.md"), "utf8"),
    tagChangelog: readFileSync(resolve(releaseTagDir, "CHANGELOG.md"), "utf8"),
    release: release.value,
    publishManifest: publish.value,
    publishManifestBytes: publish.bytes,
    publishDescriptor: publishDescriptor.value,
    postpublishEvidence: postpublish.value,
    postpublishEvidenceBytes: postpublish.bytes,
    postpublishDescriptor: postpublishDescriptor.value,
    fullReleaseValidationRunId: args["full-release-validation-run-id"],
    releasePublishRunId: args["release-publish-run-id"],
    rollbackDrillId: args["rollback-drill-id"],
    rollbackDrillDate: args["rollback-drill-date"],
    allowStaleRollbackDrill: false,
    nowMs: Date.now(),
  });
  if (result.errors.length > 0 || !result.manifest) {
    throw new Error(`strict stable closeout failed: ${result.errors.join("; ")}`);
  }
  writeCanonicalJsonExclusive(args.output, result.manifest);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--policy-main-dir")) {
    runStrict(argv);
    return;
  }
  runLegacy(argv);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

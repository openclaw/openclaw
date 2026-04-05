#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE_DOCS_DIR = path.join(ROOT, "docs");
const SOURCE_CONFIG_PATH = path.join(SOURCE_DOCS_DIR, "docs.json");
const JA_NAV_PATH = path.join(SOURCE_DOCS_DIR, ".i18n", "ja-navigation.json");
const JA_TM_PATH = path.join(SOURCE_DOCS_DIR, ".i18n", "ja-JP.tm.jsonl");
const ZH_NAV_PATH = path.join(SOURCE_DOCS_DIR, ".i18n", "zh-Hans-navigation.json");
const ZH_TM_PATH = path.join(SOURCE_DOCS_DIR, ".i18n", "zh-CN.tm.jsonl");

function parseArgs(argv) {
  const args = {
    target: "",
    sourceRepo: "",
    sourceSha: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    switch (part) {
      case "--target":
        args.target = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--source-repo":
        args.sourceRepo = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--source-sha":
        args.sourceSha = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        throw new Error(`unknown arg: ${part}`);
    }
  }

  if (!args.target) {
    throw new Error("missing --target");
  }

  return args;
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function composeDocsConfig() {
  const sourceConfig = readJson(SOURCE_CONFIG_PATH);
  const jaNavigation = readJson(JA_NAV_PATH);
  const zhNavigation = readJson(ZH_NAV_PATH);
  const languages = sourceConfig?.navigation?.languages;

  if (!Array.isArray(languages)) {
    throw new Error("docs/docs.json is missing navigation.languages");
  }

  const withoutGenerated = languages.filter(
    (entry) => entry?.language !== "zh-Hans" && entry?.language !== "ja",
  );
  const enIndex = withoutGenerated.findIndex((entry) => entry?.language === "en");
  const generated = [zhNavigation, jaNavigation];
  if (enIndex === -1) {
    withoutGenerated.push(...generated);
  } else {
    withoutGenerated.splice(enIndex + 1, 0, ...generated);
  }

  return {
    ...sourceConfig,
    navigation: {
      ...sourceConfig.navigation,
      languages: withoutGenerated,
    },
  };
}

function syncDocsTree(targetRoot) {
  const targetDocsDir = path.join(targetRoot, "docs");
  ensureDir(targetDocsDir);

  run("rsync", [
    "-a",
    "--delete",
    "--filter",
    "P ja-JP/",
    "--filter",
    "P zh-CN/",
    "--filter",
    "P .i18n/ja-JP.tm.jsonl",
    "--filter",
    "P .i18n/zh-CN.tm.jsonl",
    "--exclude",
    "ja-JP/",
    "--exclude",
    "zh-CN/",
    "--exclude",
    ".i18n/ja-JP.tm.jsonl",
    "--exclude",
    ".i18n/zh-CN.tm.jsonl",
    `${SOURCE_DOCS_DIR}/`,
    `${targetDocsDir}/`,
  ]);

  const targetJaTmPath = path.join(targetDocsDir, ".i18n", "ja-JP.tm.jsonl");
  if (!fs.existsSync(targetJaTmPath) && fs.existsSync(JA_TM_PATH)) {
    ensureDir(path.dirname(targetJaTmPath));
    fs.copyFileSync(JA_TM_PATH, targetJaTmPath);
  }

  const targetZhTmPath = path.join(targetDocsDir, ".i18n", "zh-CN.tm.jsonl");
  if (!fs.existsSync(targetZhTmPath) && fs.existsSync(ZH_TM_PATH)) {
    ensureDir(path.dirname(targetZhTmPath));
    fs.copyFileSync(ZH_TM_PATH, targetZhTmPath);
  }

  writeJson(path.join(targetDocsDir, "docs.json"), composeDocsConfig());
}

function writeSyncMetadata(targetRoot, args) {
  const metadata = {
    repository: args.sourceRepo || "",
    sha: args.sourceSha || "",
    syncedAt: new Date().toISOString(),
  };
  writeJson(path.join(targetRoot, ".openclaw-sync", "source.json"), metadata);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetRoot = path.resolve(args.target);

  if (!fs.existsSync(targetRoot)) {
    throw new Error(`target does not exist: ${targetRoot}`);
  }

  syncDocsTree(targetRoot);
  writeSyncMetadata(targetRoot, args);
}

main();

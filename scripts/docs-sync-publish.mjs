#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE_DOCS_DIR = path.join(ROOT, "docs");
const SOURCE_CONFIG_PATH = path.join(SOURCE_DOCS_DIR, "docs.json");
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
  const zhNavigation = readJson(ZH_NAV_PATH);
  const languages = sourceConfig?.navigation?.languages;

  if (!Array.isArray(languages)) {
    throw new Error("docs/docs.json is missing navigation.languages");
  }

  const withoutZh = languages.filter((entry) => entry?.language !== "zh-Hans");
  const jaIndex = withoutZh.findIndex((entry) => entry?.language === "ja");
  if (jaIndex === -1) {
    withoutZh.push(zhNavigation);
  } else {
    withoutZh.splice(jaIndex, 0, zhNavigation);
  }

  return {
    ...sourceConfig,
    navigation: {
      ...sourceConfig.navigation,
      languages: withoutZh,
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
    "P zh-CN/",
    "--filter",
    "P .i18n/zh-CN.tm.jsonl",
    "--exclude",
    "zh-CN/",
    "--exclude",
    ".i18n/zh-CN.tm.jsonl",
    `${SOURCE_DOCS_DIR}/`,
    `${targetDocsDir}/`,
  ]);

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

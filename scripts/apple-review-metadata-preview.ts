#!/usr/bin/env -S node --import tsx

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Item = {
  check: string;
  detail: string;
};

const rootDir = resolve("/Users/alma/openclaw");
const iosDir = resolve(rootDir, "apps/ios");
const sourceDir = resolve(iosDir, "fastlane/metadata");
const fastlaneEnvPath = resolve(iosDir, "fastlane/.env");
const outputDir = resolve(iosDir, "build/app-store-metadata-preview");

const requiredReviewInfo = {
  "review_information/first_name.txt": "IOS_APP_REVIEW_FIRST_NAME",
  "review_information/last_name.txt": "IOS_APP_REVIEW_LAST_NAME",
  "review_information/email_address.txt": "IOS_APP_REVIEW_EMAIL",
  "review_information/phone_number.txt": "IOS_APP_REVIEW_PHONE",
} as const;

const optionalReviewInfo = {
  "review_information/notes.txt": "IOS_APP_REVIEW_NOTES_APPEND",
} as const;

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const rawLine of readText(path).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function envValue(key: string, fileEnv: Record<string, string>): string {
  const processValue = process.env[key]?.trim();
  if (processValue) {
    return processValue;
  }
  return fileEnv[key]?.trim() ?? "";
}

function main() {
  const failures: Item[] = [];
  const warnings: Item[] = [];
  const fileEnv = loadEnvFile(fastlaneEnvPath);

  if (!existsSync(sourceDir)) {
    failures.push({
      check: "metadata-source",
      detail: `Missing metadata source directory: ${sourceDir}`,
    });
  }

  for (const [relativePath, envKey] of Object.entries(requiredReviewInfo)) {
    const value = envValue(envKey, fileEnv);
    if (!value) {
      failures.push({
        check: "review-info",
        detail: `Missing ${envKey}; cannot render ${relativePath}.`,
      });
    }
  }

  if (failures.length > 0) {
    console.log("[Apple Review Metadata Preview]");
    console.log(`BLOCKED ${failures.length} failure${failures.length === 1 ? "" : "s"}.`);
    console.log("\n[Failures]");
    for (const failure of failures) {
      console.log(`- [${failure.check}] ${failure.detail}`);
    }
    console.log("\n[Next steps]");
    console.log("- Fill apps/ios/fastlane/.env with App Review contact values.");
    console.log("- Re-run: pnpm ios:review:preview");
    process.exit(1);
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(sourceDir, outputDir, { recursive: true });

  for (const [relativePath, envKey] of Object.entries(requiredReviewInfo)) {
    const filePath = resolve(outputDir, relativePath);
    const token = `__${envKey}__`;
    const content = readText(filePath);
    if (!content.includes(token)) {
      failures.push({
        check: "token-replacement",
        detail: `Expected token ${token} in ${relativePath}.`,
      });
      continue;
    }
    writeFileSync(filePath, content.replaceAll(token, envValue(envKey, fileEnv)));
  }

  for (const [relativePath, envKey] of Object.entries(optionalReviewInfo)) {
    const filePath = resolve(outputDir, relativePath);
    const token = `__${envKey}__`;
    const content = readText(filePath);
    if (!content.includes(token)) {
      failures.push({
        check: "token-replacement",
        detail: `Expected token ${token} in ${relativePath}.`,
      });
      continue;
    }
    const value = envValue(envKey, fileEnv);
    if (!value) {
      warnings.push({
        check: "review-notes",
        detail: `${envKey} is empty; preview will omit submission-specific reviewer instructions.`,
      });
    }
    writeFileSync(filePath, content.replaceAll(token, value));
  }

  const unresolvedTokens: string[] = [];
  for (const relativePath of [
    ...Object.keys(requiredReviewInfo),
    ...Object.keys(optionalReviewInfo),
  ]) {
    const content = readText(resolve(outputDir, relativePath));
    const matches = content.match(/__IOS_APP_REVIEW_[A-Z_]+__/g) ?? [];
    unresolvedTokens.push(...matches.map((token) => `${relativePath}: ${token}`));
  }

  if (unresolvedTokens.length > 0) {
    failures.push({
      check: "token-replacement",
      detail: `Unresolved review-info tokens remain: ${unresolvedTokens.join(", ")}`,
    });
  }

  console.log("[Apple Review Metadata Preview]");
  console.log(
    failures.length === 0
      ? `READY Rendered staged metadata preview${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}.`
      : `BLOCKED ${failures.length} failure${failures.length === 1 ? "" : "s"}${warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`,
  );
  console.log(`Source: ${sourceDir}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Review notes preview: ${resolve(outputDir, "review_information/notes.txt")}`);

  if (failures.length > 0) {
    console.log("\n[Failures]");
    for (const failure of failures) {
      console.log(`- [${failure.check}] ${failure.detail}`);
    }
  }

  if (warnings.length > 0) {
    console.log("\n[Warnings]");
    for (const warning of warnings) {
      console.log(`- [${warning.check}] ${warning.detail}`);
    }
  }

  console.log("\n[Next steps]");
  console.log("- Open the staged files and confirm the review text reads naturally.");
  console.log("- Re-run after each submission-specific review-note update.");
  console.log("- Final submission-side Apple gate: pnpm release:apple:submit-check");
  console.log("- Upload metadata only after this preview matches the intended Apple review path.");

  if (failures.length > 0) {
    process.exit(1);
  }
}

main();

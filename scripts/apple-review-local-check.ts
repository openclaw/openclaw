#!/usr/bin/env -S node --import tsx

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Item = {
  check: string;
  detail: string;
};

const rootDir = resolve("/Users/alma/openclaw");
const fastlaneEnvPath = resolve(rootDir, "apps/ios/fastlane/.env");

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

function looksPlaceholderLike(key: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  switch (key) {
    case "IOS_APP_REVIEW_FIRST_NAME":
      return ["jane", "your_first_name", "first_name"].includes(normalized);
    case "IOS_APP_REVIEW_LAST_NAME":
      return ["doe", "your_last_name", "last_name"].includes(normalized);
    case "IOS_APP_REVIEW_EMAIL":
      return (
        normalized === "review-contact@example.com" ||
        normalized.endsWith("@example.com") ||
        normalized.endsWith("@example.invalid") ||
        normalized.endsWith("@vericlaw.invalid")
      );
    case "IOS_APP_REVIEW_PHONE":
      return normalized === "+1 415 555 0101" || normalized === "+1 415 555 0100";
    case "IOS_APP_REVIEW_NOTES_APPEND":
      return (
        normalized.includes("pairing_or_demo_account_details_for_app_review") ||
        normalized.includes("example.invalid") ||
        normalized.includes("reviewer@example.com / password123!")
      );
    default:
      return false;
  }
}

function keychainHasAscSecret(fileEnv: Record<string, string>): boolean {
  const keyID = envValue("ASC_KEY_ID", fileEnv);
  const issuerID = envValue("ASC_ISSUER_ID", fileEnv);
  if (!keyID || !issuerID) {
    return false;
  }

  const service = envValue("ASC_KEYCHAIN_SERVICE", fileEnv) || "openclaw-asc-key";
  const account =
    envValue("ASC_KEYCHAIN_ACCOUNT", fileEnv) ||
    process.env.USER?.trim() ||
    process.env.LOGNAME?.trim() ||
    "";

  if (!account) {
    return false;
  }

  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

function main() {
  const failures: Item[] = [];
  const warnings: Item[] = [];
  const fileEnv = loadEnvFile(fastlaneEnvPath);

  const ascJsonPath = envValue("APP_STORE_CONNECT_API_KEY_PATH", fileEnv);
  const ascP8Path = envValue("ASC_KEY_PATH", fileEnv);
  const ascKeyID = envValue("ASC_KEY_ID", fileEnv);
  const ascIssuerID = envValue("ASC_ISSUER_ID", fileEnv);
  const ascKeyContent = envValue("ASC_KEY_CONTENT", fileEnv);

  if (ascJsonPath) {
    if (!existsSync(resolve(ascJsonPath))) {
      failures.push({
        check: "asc-auth",
        detail: `APP_STORE_CONNECT_API_KEY_PATH points to a missing file: ${resolve(ascJsonPath)}`,
      });
    }
  } else if (ascP8Path) {
    if (!ascKeyID || !ascIssuerID) {
      failures.push({
        check: "asc-auth",
        detail: "ASC_KEY_PATH is set, but ASC_KEY_ID and ASC_ISSUER_ID are still required.",
      });
    } else if (!existsSync(resolve(ascP8Path))) {
      failures.push({
        check: "asc-auth",
        detail: `ASC_KEY_PATH points to a missing file: ${resolve(ascP8Path)}`,
      });
    }
  } else if (!(ascKeyID && ascIssuerID && (ascKeyContent || keychainHasAscSecret(fileEnv)))) {
    failures.push({
      check: "asc-auth",
      detail:
        "Missing usable App Store Connect API auth. Set APP_STORE_CONNECT_API_KEY_PATH, ASC_KEY_PATH, or ASC_KEY_ID/ASC_ISSUER_ID with ASC_KEY_CONTENT or a Keychain-backed secret.",
    });
  }

  const reviewKeys = [
    "IOS_APP_REVIEW_FIRST_NAME",
    "IOS_APP_REVIEW_LAST_NAME",
    "IOS_APP_REVIEW_EMAIL",
    "IOS_APP_REVIEW_PHONE",
    "IOS_APP_REVIEW_NOTES_APPEND",
  ] as const;

  for (const key of reviewKeys) {
    if (!envValue(key, fileEnv)) {
      failures.push({
        check: "review-info",
        detail: `Missing ${key} in apps/ios/fastlane/.env or current shell environment.`,
      });
      continue;
    }
    if (looksPlaceholderLike(key, envValue(key, fileEnv))) {
      failures.push({
        check: "review-info",
        detail: `${key} still looks like a copied placeholder/example value.`,
      });
    }
  }

  const reviewEmail = envValue("IOS_APP_REVIEW_EMAIL", fileEnv);
  if (reviewEmail && !reviewEmail.includes("@")) {
    failures.push({
      check: "review-info",
      detail: "IOS_APP_REVIEW_EMAIL does not look like an email address.",
    });
  }

  const reviewPhone = envValue("IOS_APP_REVIEW_PHONE", fileEnv);
  if (reviewPhone && !reviewPhone.startsWith("+")) {
    warnings.push({
      check: "review-info",
      detail:
        "IOS_APP_REVIEW_PHONE does not start with '+'. E.164-like formatting is safest for App Review.",
    });
  }

  for (const relativePath of [
    "apps/ios/APP_STORE_SUBMISSION_KIT.md",
    "apps/ios/screenshots/README.md",
    "apps/ios/screenshots/session-2026-03-07/onboarding.png",
    "apps/ios/screenshots/session-2026-03-07/settings.png",
    "apps/ios/screenshots/session-2026-03-07/talk-mode.png",
    "apps/ios/screenshots/session-2026-03-07/canvas-cool.png",
  ]) {
    if (!existsSync(resolve(rootDir, relativePath))) {
      failures.push({
        check: "screenshots",
        detail: `Missing required submission file: ${relativePath}`,
      });
    }
  }

  console.log("[Apple Review Local Check]");
  console.log(`Fastlane env: ${existsSync(fastlaneEnvPath) ? fastlaneEnvPath : "missing"}`);
  console.log(
    failures.length === 0
      ? `READY Local submission inputs look complete${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}.`
      : `BLOCKED ${failures.length} failure${failures.length === 1 ? "" : "s"}${warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`,
  );

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
  console.log("- Fill apps/ios/fastlane/.env with ASC auth and App Review values.");
  console.log("- Preview the injected metadata locally: pnpm ios:review:preview");
  console.log("- Re-run: pnpm ios:review:local-check");
  console.log("- Then verify Apple environment: pnpm ios:doctor");
  console.log("- Final submission-side Apple gate: pnpm release:apple:submit-check");

  if (
    failures.some((failure) => failure.check === "asc-auth") ||
    failures.some((failure) => failure.check === "review-info")
  ) {
    console.log("\n[Suggested .env block]");
  }

  if (failures.some((failure) => failure.check === "asc-auth")) {
    console.log("ASC_KEY_ID=XXXXXXXXXX");
    console.log("ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
    console.log("ASC_KEY_PATH=/absolute/path/to/AuthKey_XXXXXXXXXX.p8");
  }

  if (failures.some((failure) => failure.check === "review-info")) {
    console.log("IOS_APP_REVIEW_FIRST_NAME=");
    console.log("IOS_APP_REVIEW_LAST_NAME=");
    console.log("IOS_APP_REVIEW_EMAIL=");
    console.log("IOS_APP_REVIEW_PHONE=+1 415 555 0101");
    console.log("IOS_APP_REVIEW_NOTES_APPEND=");
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}

main();

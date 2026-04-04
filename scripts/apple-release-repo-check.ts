#!/usr/bin/env -S node --import tsx

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Failure = {
  check: string;
  detail: string;
};

function readText(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

function pushMissingFileFailure(failures: Failure[], path: string, check: string) {
  if (!existsSync(resolve(path))) {
    failures.push({
      check,
      detail: `Missing required file: ${path}`,
    });
  }
}

function checkAssetCatalogReferences(params: {
  failures: Failure[];
  check: string;
  contentsJsonPath: string;
}) {
  const contentsPath = resolve(params.contentsJsonPath);
  if (!existsSync(contentsPath)) {
    params.failures.push({
      check: params.check,
      detail: `Missing asset catalog manifest: ${params.contentsJsonPath}`,
    });
    return;
  }

  const contents = JSON.parse(readText(params.contentsJsonPath)) as {
    images?: Array<{ filename?: string }>;
  };
  const assetDir = dirname(contentsPath);
  const missing = (contents.images ?? [])
    .flatMap((image) => {
      if (!image.filename) {
        return [];
      }
      return existsSync(resolve(assetDir, image.filename)) ? [] : [image.filename];
    })
    .toSorted();

  if (missing.length > 0) {
    params.failures.push({
      check: params.check,
      detail: `Asset catalog references missing files: ${missing.join(", ")}`,
    });
  }
}

function checkReadmeContains(params: {
  failures: Failure[];
  check: string;
  path: string;
  expected: string;
  message: string;
}) {
  const content = readText(params.path);
  if (!content.includes(params.expected)) {
    params.failures.push({
      check: params.check,
      detail: params.message,
    });
  }
}

function checkReadmeDoesNotContain(params: {
  failures: Failure[];
  check: string;
  path: string;
  forbidden: RegExp;
  message: string;
}) {
  const content = readText(params.path);
  if (params.forbidden.test(content)) {
    params.failures.push({
      check: params.check,
      detail: params.message,
    });
  }
}

function checkPackageScripts(params: { failures: Failure[]; check: string; scripts: string[] }) {
  const pkg = JSON.parse(readText("package.json")) as {
    scripts?: Record<string, string>;
  };
  const packageScripts = pkg.scripts ?? {};
  for (const scriptName of params.scripts) {
    if (!packageScripts[scriptName]) {
      params.failures.push({
        check: params.check,
        detail: `package.json is missing script '${scriptName}'`,
      });
    }
  }
}

function checkRequiredTextFiles(params: { failures: Failure[]; check: string; paths: string[] }) {
  for (const path of params.paths) {
    pushMissingFileFailure(params.failures, path, params.check);
  }
}

function checkContainsNoPlaceholder(params: {
  failures: Failure[];
  check: string;
  path: string;
  forbidden: RegExp;
  message: string;
}) {
  const content = readText(params.path).trim();
  if (params.forbidden.test(content)) {
    params.failures.push({
      check: params.check,
      detail: params.message,
    });
  }
}

function checkExactText(params: {
  failures: Failure[];
  check: string;
  path: string;
  expected: string;
  message: string;
}) {
  const content = readText(params.path).trim();
  if (content !== params.expected) {
    params.failures.push({
      check: params.check,
      detail: params.message,
    });
  }
}

function checkContainsText(params: {
  failures: Failure[];
  check: string;
  path: string;
  expected: string;
  message: string;
}) {
  const content = readText(params.path);
  if (!content.includes(params.expected)) {
    params.failures.push({
      check: params.check,
      detail: params.message,
    });
  }
}

function checkAtLeastOneMatchingFile(params: {
  failures: Failure[];
  check: string;
  paths: string[];
}) {
  const found = params.paths.some((path) => existsSync(resolve(path)));
  if (!found) {
    params.failures.push({
      check: params.check,
      detail: `Expected at least one required file to exist: ${params.paths.join(" or ")}`,
    });
  }
}

function main() {
  const failures: Failure[] = [];

  for (const path of [
    "scripts/with-xcode-developer-dir.sh",
    "scripts/resolve-xcode-developer-dir.sh",
    "scripts/resolve-ios-simulator.sh",
    "scripts/ios-build.sh",
    "scripts/ios-doctor.sh",
    "scripts/ios-run.sh",
  ]) {
    pushMissingFileFailure(failures, path, "apple-release-repo-check");
  }

  for (const path of ["PRIVACY.md", "SUPPORT.md"]) {
    pushMissingFileFailure(failures, path, "apple-release-materials");
  }

  checkRequiredTextFiles({
    failures,
    check: "apple-release-metadata",
    paths: [
      "apps/ios/fastlane/metadata/en-US/name.txt",
      "apps/ios/fastlane/metadata/en-US/subtitle.txt",
      "apps/ios/fastlane/metadata/en-US/description.txt",
      "apps/ios/fastlane/metadata/en-US/keywords.txt",
      "apps/ios/fastlane/metadata/en-US/marketing_url.txt",
      "apps/ios/fastlane/metadata/en-US/privacy_url.txt",
      "apps/ios/fastlane/metadata/en-US/promotional_text.txt",
      "apps/ios/fastlane/metadata/en-US/release_notes.txt",
      "apps/ios/fastlane/metadata/en-US/support_url.txt",
      "apps/ios/fastlane/metadata/review_information/first_name.txt",
      "apps/ios/fastlane/metadata/review_information/last_name.txt",
      "apps/ios/fastlane/metadata/review_information/email_address.txt",
      "apps/ios/fastlane/metadata/review_information/phone_number.txt",
      "apps/ios/fastlane/metadata/review_information/notes.txt",
    ],
  });

  checkAtLeastOneMatchingFile({
    failures,
    check: "apple-release-screenshots",
    paths: [
      "apps/ios/screenshots/session-2026-03-07/onboarding.png",
      "apps/ios/screenshots/session-2026-03-07/settings.png",
      "apps/ios/screenshots/session-2026-03-07/talk-mode.png",
      "apps/ios/screenshots/session-2026-03-07/canvas-cool.png",
    ],
  });

  checkPackageScripts({
    failures,
    check: "apple-release-repo-check",
    scripts: [
      "ios:doctor",
      "ios:review:local-check",
      "ios:review:preview",
      "ios:build",
      "ios:run",
      "mac:test",
      "release:apple:submit-check",
    ],
  });

  pushMissingFileFailure(
    failures,
    "apps/ios/APP_STORE_SUBMISSION_KIT.md",
    "apple-release-materials",
  );

  checkAssetCatalogReferences({
    failures,
    check: "ios-appicon-catalog",
    contentsJsonPath: "apps/ios/Sources/Assets.xcassets/AppIcon.appiconset/Contents.json",
  });

  checkReadmeContains({
    failures,
    check: "ios-readme-release-gate",
    path: "apps/ios/README.md",
    expected: "Pre-Release Hardening",
    message: "apps/ios/README.md should describe the app as Pre-Release Hardening.",
  });
  checkReadmeContains({
    failures,
    check: "ios-readme-release-gate",
    path: "apps/ios/README.md",
    expected: "synchronized GitHub + App Store release",
    message: "apps/ios/README.md should state the synchronized GitHub + App Store release target.",
  });
  checkReadmeDoesNotContain({
    failures,
    check: "ios-readme-release-gate",
    path: "apps/ios/README.md",
    forbidden: /\bSuper Alpha\b/i,
    message: "apps/ios/README.md still contains 'Super Alpha'.",
  });
  checkReadmeContains({
    failures,
    check: "mac-readme-release-gate",
    path: "apps/macos/README.md",
    expected: "pnpm mac:test",
    message: "apps/macos/README.md should point release validation to `pnpm mac:test`.",
  });

  checkReadmeContains({
    failures,
    check: "ios-settings-legal-access",
    path: "apps/ios/Sources/Settings/SettingsTab.swift",
    expected: "Privacy Policy",
    message: "iOS settings should expose an in-app Privacy Policy entry.",
  });

  checkContainsNoPlaceholder({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/email_address.txt",
    forbidden: /@vericlaw\.invalid|replace-before-submit/i,
    message: "Review contact email is still a placeholder.",
  });

  checkContainsNoPlaceholder({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/phone_number.txt",
    forbidden: /^\+1 415 555 0100$/i,
    message: "Review contact phone number is still the sample placeholder.",
  });

  checkExactText({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/first_name.txt",
    expected: "__IOS_APP_REVIEW_FIRST_NAME__",
    message: "Review contact first name should stay templated in git.",
  });
  checkExactText({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/last_name.txt",
    expected: "__IOS_APP_REVIEW_LAST_NAME__",
    message: "Review contact last name should stay templated in git.",
  });
  checkExactText({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/email_address.txt",
    expected: "__IOS_APP_REVIEW_EMAIL__",
    message: "Review contact email should stay templated in git.",
  });
  checkExactText({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/phone_number.txt",
    expected: "__IOS_APP_REVIEW_PHONE__",
    message: "Review contact phone number should stay templated in git.",
  });
  checkContainsText({
    failures,
    check: "apple-review-contact",
    path: "apps/ios/fastlane/metadata/review_information/notes.txt",
    expected: "__IOS_APP_REVIEW_NOTES_APPEND__",
    message: "Review notes should keep the local submission-details token in git.",
  });

  if (failures.length > 0) {
    console.error("apple-release-repo-check: repository-side Apple release checks failed:");
    for (const failure of failures) {
      console.error(`  - [${failure.check}] ${failure.detail}`);
    }
    process.exit(1);
  }

  console.log("apple-release-repo-check: repository-side Apple release checks passed.");
}

main();

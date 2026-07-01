import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_I18N_LOCALES } from "./native-app-i18n.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REQUIRED_LOCALES = ["en", ...NATIVE_I18N_LOCALES];
const FORMAT_RE = /%(?:\d+\$)?[@a-z]/giu;
const APPLE_LOCALE_DIRECTORIES: Record<string, string> = {
  "ja-JP": "ja",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

const CATALOGS = [
  {
    path: "apps/ios/Resources/Localizable.xcstrings",
    coverage: {
      "apps/ios/ShareExtension/ShareViewController.swift": [
        "Add a message, then tap Send.",
        "Cancel",
        "Edit text, then tap Send.",
        "Invalid saved gateway URL.",
        "Message is empty.",
        "OpenClaw is not connected to a gateway yet.",
        "Preparing share…",
        "Send failed: %@",
        "Send to OpenClaw",
        "Sending to OpenClaw gateway…",
        "Sent to OpenClaw.",
      ],
      "apps/ios/Sources/Design/SettingsChannelsDestination.swift": ["Logout"],
      "apps/ios/Sources/Gateway/GatewayProblemView.swift": ["Done"],
      "apps/ios/Sources/Gateway/GatewayQuickSetupSheet.swift": [
        "Close",
        "Connect",
        "Connect to a Gateway?",
        "Connecting…",
        "Don’t show this again",
        "No gateways found yet. Make sure your gateway is running and Bonjour discovery is enabled.",
        "Not now",
        "Quick Setup",
      ],
      "apps/ios/Sources/Gateway/GatewayTrustPromptAlert.swift": [
        "Cancel",
        "First-time TLS connection.\n\nVerify this SHA-256 fingerprint out-of-band before trusting:\n%@",
        "Trust and connect",
        "Trust this gateway?",
      ],
      "apps/ios/Sources/Onboarding/OnboardingWizardView.swift": ["Save"],
      "apps/ios/Sources/RootTabs.swift": ["Agent", "Chat", "Control", "Settings", "Talk"],
      "apps/ios/WatchApp/Sources/WatchInboxView.swift": [
        "Approve",
        "Chat",
        "Continue on iPhone",
        "Deny",
        "Message OpenClaw",
        "No chat synced",
        "Open all approvals",
        "Refresh",
        "Review again",
        "Talk to Claw",
        "Tap the message pill below to start from your watch.",
        "You",
      ],
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMessageViews.swift": ["Writing"],
    },
  },
  {
    path: "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
    coverage: {
      "apps/macos/Sources/OpenClaw/ChannelsSettings+ChannelSections.swift": [
        "Logout",
        "Refresh",
        "Save",
      ],
      "apps/macos/Sources/OpenClaw/CronSettings+Rows.swift": ["Run now"],
    },
  },
] as const;

type Catalog = {
  sourceLanguage?: string;
  strings?: Record<
    string,
    {
      localizations?: Record<string, { stringUnit?: { state?: string; value?: string } }>;
    }
  >;
};

function formatTokens(value: string): string[] {
  return [...value.matchAll(FORMAT_RE)].map((match) => match[0]).toSorted();
}

function stringsLiteral(value: string): string {
  return JSON.stringify(value);
}

export async function checkAppleAppI18n() {
  let checked = 0;
  for (const spec of CATALOGS) {
    const catalogPath = path.join(ROOT, spec.path);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
    if (catalog.sourceLanguage !== "en" || !catalog.strings) {
      throw new Error(`invalid Apple string catalog: ${spec.path}`);
    }

    const expectedKeys = new Set(Object.values(spec.coverage).flat());
    const actualKeys = new Set(Object.keys(catalog.strings));
    const missingKeys = [...expectedKeys].filter((key) => !actualKeys.has(key));
    const extraKeys = [...actualKeys].filter((key) => !expectedKeys.has(key));
    if (missingKeys.length || extraKeys.length) {
      throw new Error(
        [
          `Apple catalog ${spec.path} does not match its phased source coverage.`,
          `missing=${missingKeys.join(",") || "none"}`,
          `extra=${extraKeys.join(",") || "none"}`,
        ].join("\n"),
      );
    }

    for (const [sourcePath, keys] of Object.entries(spec.coverage)) {
      const source = await readFile(path.join(ROOT, sourcePath), "utf8");
      const absent = keys.filter((key) => {
        const escapedKey = JSON.stringify(key).slice(1, -1);
        return !source.includes(key) && !source.includes(escapedKey);
      });
      if (absent.length) {
        throw new Error(
          `Apple i18n coverage ${sourcePath} no longer contains: ${absent.join(", ")}`,
        );
      }
    }

    for (const [key, entry] of Object.entries(catalog.strings)) {
      const sourceTokens = formatTokens(key);
      for (const locale of REQUIRED_LOCALES) {
        const unit = entry.localizations?.[locale]?.stringUnit;
        const value = unit?.value?.trim();
        if (!value || unit?.state !== "translated") {
          throw new Error(
            `Apple catalog ${spec.path} is missing ${locale} for ${JSON.stringify(key)}`,
          );
        }
        if (formatTokens(value).join("\u0000") !== sourceTokens.join("\u0000")) {
          throw new Error(
            `Apple catalog ${spec.path} has placeholder drift in ${locale} for ${JSON.stringify(key)}`,
          );
        }
      }
      checked += 1;
    }
  }
  process.stdout.write(
    `apple-app-i18n: catalogs=${CATALOGS.length} keys=${checked} locales=${NATIVE_I18N_LOCALES.join(",")}\n`,
  );
}

export async function compileMacosLocalizations(outputDir: string) {
  await checkAppleAppI18n();
  const spec = CATALOGS[1];
  const catalog = JSON.parse(await readFile(path.join(ROOT, spec.path), "utf8")) as Catalog;
  if (!catalog.strings) {
    throw new Error(`invalid Apple string catalog: ${spec.path}`);
  }

  for (const locale of REQUIRED_LOCALES) {
    const localeDir = APPLE_LOCALE_DIRECTORIES[locale] ?? locale;
    const lprojDir = path.join(outputDir, `${localeDir}.lproj`);
    const lines = Object.entries(catalog.strings)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        const value = entry.localizations?.[locale]?.stringUnit?.value;
        if (!value) {
          throw new Error(
            `Apple catalog ${spec.path} is missing ${locale} for ${JSON.stringify(key)}`,
          );
        }
        return `${stringsLiteral(key)} = ${stringsLiteral(value)};`;
      });
    await mkdir(lprojDir, { recursive: true });
    await writeFile(path.join(lprojDir, "Localizable.strings"), `${lines.join("\n")}\n`, "utf8");
  }
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const [command, flag, value] = process.argv.slice(2);
  if (command === "check") {
    await checkAppleAppI18n();
  } else if (command === "compile-macos" && flag === "--output" && value) {
    await compileMacosLocalizations(path.resolve(value));
  } else {
    throw new Error(
      "usage: node --import tsx scripts/apple-app-i18n.ts check|compile-macos --output <dir>",
    );
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseHints } from "../../src/config/schema.hints.js";
import { configHintTranslationKey } from "../../ui/src/i18n/lib/config-hint-translation.ts";
import { registerActivityEnglish } from "../../ui/src/i18n/locales/en-activity.ts";
import { registerDebugEnglish } from "../../ui/src/i18n/locales/en-debug.ts";
import { registerDesktopEnglish } from "../../ui/src/i18n/locales/en-desktop.ts";
import { registerDevicesEnglish } from "../../ui/src/i18n/locales/en-devices.ts";
import { registerLoginEnglish } from "../../ui/src/i18n/locales/en-login.ts";
import { registerMeetingsEnglish } from "../../ui/src/i18n/locales/en-meetings.ts";
import { registerMemoryImportEnglish } from "../../ui/src/i18n/locales/en-memory-import.ts";
import { registerModelAccountsEnglish } from "../../ui/src/i18n/locales/en-model-accounts.ts";
import { registerNewSessionSetupEnglish } from "../../ui/src/i18n/locales/en-new-session-setup.ts";
import { registerPluginConsentEnglish } from "../../ui/src/i18n/locales/en-plugin-consent.ts";
import { registerSessionPlacementEnglish } from "../../ui/src/i18n/locales/en-session-placement.ts";
import { registerSettingsEnglish } from "../../ui/src/i18n/locales/en-settings.ts";
import { registerSkillLibraryEnglish } from "../../ui/src/i18n/locales/en-skill-library.ts";
import { registerTranscriptsEnglish } from "../../ui/src/i18n/locales/en-transcripts.ts";
import { registerUpdateActionsEnglish } from "../../ui/src/i18n/locales/en-update-actions.ts";
import { en } from "../../ui/src/i18n/locales/en.ts";
import {
  mergeControlUiTranslationMaps,
  setControlUiCatalogValue,
} from "./control-ui-i18n-catalog-values.ts";
import type { TranslationMap } from "./control-ui-i18n-sync-plan.ts";

// Host-only source composition for generation, verification, and Vite. The locale
// loader tracks these imports and reloads them in an isolated namespace.
const localesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../ui/src/i18n/locales",
);
const sourceFiles = [
  "en.ts",
  "en-agents.ts",
  "en-activity.ts",
  "en-debug.ts",
  "en-desktop.ts",
  "en-devices.ts",
  "en-login.ts",
  "en-meetings.ts",
  "en-memory-import.ts",
  "en-model-accounts.ts",
  "en-session-placement.ts",
  "en-new-session-setup.ts",
  "en-plugin-consent.ts",
  "en-settings.ts",
  "en-skill-library.ts",
  "en-update-actions.ts",
  "en-transcripts.ts",
];

export function loadControlUiSourceCatalog(): TranslationMap {
  // Read fragment data without registering it into the shared runtime catalog.
  // en.ts's empty anchors retain source order for extracted whole subtrees.
  return mergeControlUiTranslationMaps(
    registerSkillLibraryEnglish.catalog,
    // Preserve partial-fragment key order while keeping shared labels eager.
    {
      ...en,
      debug: registerDebugEnglish.catalog.debug,
      desktop: registerDesktopEnglish.catalog.desktop,
    },
    registerActivityEnglish.catalog,
    registerDevicesEnglish.catalog,
    registerLoginEnglish.catalog,
    registerMeetingsEnglish.catalog,
    registerMemoryImportEnglish.catalog,
    registerModelAccountsEnglish.catalog,
    registerSessionPlacementEnglish.catalog,
    registerNewSessionSetupEnglish.catalog,
    registerPluginConsentEnglish.catalog,
    registerSettingsEnglish.catalog,
    registerUpdateActionsEnglish.catalog,
    registerTranscriptsEnglish.catalog,
    loadControlUiCoreHintCatalog(),
  );
}

export async function readControlUiSourceCatalog(): Promise<string> {
  const sources = await Promise.all(
    sourceFiles.map((fileName) => readFile(path.join(localesDir, fileName), "utf8")),
  );
  return [...sources, JSON.stringify(loadControlUiCoreHintCatalog())].join("\n");
}

function loadControlUiCoreHintCatalog(): TranslationMap {
  const catalog: TranslationMap = {};
  for (const [hintPath, hint] of Object.entries(buildBaseHints()).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const field of ["label", "help"] as const) {
      const text = hint[field];
      if (text) {
        setControlUiCatalogValue(catalog, configHintTranslationKey(hintPath, field, text), text);
      }
    }
  }
  return catalog;
}

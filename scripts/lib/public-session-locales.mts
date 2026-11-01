import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../src/shared/control-ui-locale.ts";
import { PUBLIC_SESSION_COPY } from "../../src/shared/public-session-copy.ts";
import {
  loadControlUiTranslationMemory,
  materializePreparedControlUiLocaleCatalog,
  prepareControlUiCatalogSource,
} from "./control-ui-i18n-catalog-values.ts";
import { flattenTranslations } from "./control-ui-i18n-sync-plan.ts";

const namespace = "publicReader.";

/** Project only verified reader keys; missing or stale keys use runtime English. */
export function loadPublicSessionLocales(
  rootDir = process.cwd(),
  recordInput?: (file: string) => void,
): Record<string, Record<string, string>> {
  recordInput?.(path.join(rootDir, "src/shared/public-session-copy.ts"));
  recordInput?.(path.join(rootDir, "src/shared/control-ui-locale.ts"));
  const source = prepareControlUiCatalogSource(
    new Map(Object.entries(PUBLIC_SESSION_COPY).map(([key, text]) => [namespace + key, text])),
  );
  const locales: Record<string, Record<string, string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) {
      continue;
    }
    const memoryPath = path.join(rootDir, "ui/src/i18n/.i18n", locale + ".tm.jsonl");
    const exists = fs.existsSync(memoryPath);
    if (exists) {
      recordInput?.(memoryPath);
    }
    const memory = loadControlUiTranslationMemory(memoryPath);
    if (exists && memory.size === 0) {
      throw new Error("Control UI " + locale + " translation memory is empty");
    }
    locales[locale] = Object.fromEntries(
      [...flattenTranslations(materializePreparedControlUiLocaleCatalog(source, memory))].map(
        ([key, value]) => [key.slice(namespace.length), value],
      ),
    );
  }
  return locales;
}

/** Runtime bundles carry dictionaries, never a filesystem or full UI catalog. */
export function createPublicSessionLocalesPlugin(
  rootDir = process.cwd(),
  recordInput?: (file: string) => void,
): TsdownPlugin {
  const runtimePath = path.resolve(rootDir, "src/gateway/control-ui-public-session-locales.ts");
  return {
    name: "openclaw:public-session-locales",
    transform(_code, id) {
      if (path.normalize(id) !== runtimePath) {
        return undefined;
      }
      const locales = loadPublicSessionLocales(rootDir, (file) => {
        recordInput?.(file);
        this.addWatchFile(file);
      });
      return {
        code: "export const PUBLIC_SESSION_LOCALES = " + JSON.stringify(locales) + ";",
        map: null,
      };
    },
  };
}

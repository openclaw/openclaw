// Every row on a Settings page names the setting it edits, or says it is not a setting, and
// every hand-built setting ID is listed once in src/shared/control-ui-settings and drawn once.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/ast";
import {
  CONTROL_UI_SETTING_ID_ALIASES,
  CONTROL_UI_SETTINGS_PAGES,
} from "../src/shared/control-ui-settings/index.ts";
import { isTest, readInventorySources } from "./control-ui-solid-inventory.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";

/** Sources that draw Settings pages. */
export const SETTINGS_SOURCES = [
  "ui/src/components/mcp-servers-card.tsx",
  "ui/src/features/github-connections/",
  "ui/src/pages/about/",
  "ui/src/pages/agents/",
  "ui/src/pages/approvals/",
  "ui/src/pages/channels/",
  "ui/src/pages/cloud-workers/",
  "ui/src/pages/config/",
  "ui/src/pages/connection/",
  "ui/src/pages/custodian/",
  "ui/src/pages/debug/",
  "ui/src/pages/device/",
  "ui/src/pages/devices/",
  "ui/src/pages/labs/",
  "ui/src/pages/logs/",
  "ui/src/pages/model-providers/",
  "ui/src/pages/plugins/",
  "ui/src/pages/profile/",
  "ui/src/pages/search/",
  "ui/src/pages/secrets/",
  "ui/src/pages/skills/",
];
/** Files under those folders that draw pages outside Settings, with the page they draw. */
export const NOT_SETTINGS_SOURCES: Readonly<Record<string, string>> = {};
/** Rows that name their setting through a required prop of their own. */
const SELF_NAMED_ROWS: Readonly<Record<string, (value: string) => string>> = {
  LocalToggleRow: (preference) => `local.${preference}`,
};
const ROW_COMPONENTS = new Set([
  "SettingsDetailsRow",
  "SettingsDisclosure",
  "SettingsNavRow",
  "SettingsRow",
  "SettingsSelectRow",
  "SettingsToggleRow",
]);
/** Classes that draw one row of a Settings page. */
const ROW_CLASSES = new Set(["settings-row", "provider-row"]);
const BASELINE = "config/control-ui-setting-ids-baseline.txt";
const SNAPSHOT = "config/control-ui-setting-ids.txt";
const GUIDANCE =
  'Give the row `setting="<id>"` (raw rows: `id="<id>"`) with an ID listed in src/shared/control-ui-settings, or mark a status, fact or action row `info` (raw rows: `data-settings-info`).';

export function isSettingsSource(file: string) {
  return (
    /\.tsx$/u.test(file) &&
    !isTest(file) &&
    !(file in NOT_SETTINGS_SOURCES) &&
    SETTINGS_SOURCES.some((source) =>
      source.endsWith("/") ? file.startsWith(source) : file === source,
    )
  );
}

type SettingsList = {
  pages: ReadonlyArray<{ path: string; settings: Readonly<Record<string, unknown>> }>;
  aliases: Readonly<Record<string, string>>;
};

function registryIds(pages: SettingsList["pages"]) {
  const ids = new Map<string, string>();
  for (const page of pages) {
    for (const id of Object.keys(page.settings)) {
      if (ids.has(id)) {
        throw new Error(`Setting ID ${id} is listed for both ${ids.get(id)} and ${page.path}`);
      }
      ids.set(id, page.path);
    }
  }
  return ids;
}

/**
 * Literal setting values: a string, both branches of a conditional, or a `prefix.${item}`
 * template naming one row per item. Other expressions forward an ID named elsewhere.
 */
function settingLiterals(node: ts.Node | undefined): string[] {
  let value = node;
  while (value && (ts.isJsxExpression(value) || ts.isParenthesizedExpression(value))) {
    value = value.expression;
  }
  if (!value) {
    return [];
  }
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return [value.text];
  }
  if (ts.isConditionalExpression(value)) {
    return [...settingLiterals(value.whenTrue), ...settingLiterals(value.whenFalse)];
  }
  if (ts.isTemplateExpression(value) && value.head.text.endsWith(".")) {
    return [`${value.head.text}*`];
  }
  return [];
}

function hasRowClass(node: ts.Node | undefined): boolean {
  if (!node) {
    return false;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.split(/\s+/u).some((token) => ROW_CLASSES.has(token));
  }
  let found = false;
  node.forEachChild((child) => {
    found ||= hasRowClass(child);
  });
  return found;
}

export function checkSettingIds(
  root = process.cwd(),
  {
    write = false,
    writeBaseline = false,
    list = { pages: CONTROL_UI_SETTINGS_PAGES, aliases: CONTROL_UI_SETTING_ID_ALIASES },
  }: { write?: boolean; writeBaseline?: boolean; list?: SettingsList } = {},
): string[] {
  const failures: string[] = [];
  const ids = registryIds(list.pages);
  const baselinePath = path.join(root, BASELINE);
  const baseline = new Set(
    fs.existsSync(baselinePath)
      ? fs.readFileSync(baselinePath, "utf8").split("\n").filter(Boolean)
      : [],
  );
  const aliases = new Set(Object.keys(list.aliases));
  const references = new Map<string, Array<{ file: string; at: string }>>();
  const unnamed = new Map<string, string[]>();
  const sources = readInventorySources(root, { roots: ["ui/src"] });
  const files = [...sources]
    .filter(
      ([file, text]) =>
        file.endsWith(".tsx") &&
        !isTest(file) &&
        /setting|-row|Settings[A-Za-z]*Row|SettingsDisclosure/u.test(text),
    )
    .map(([fileName, text]) => ({ fileName, text }));
  using parser = createNativeTypeScriptParser({ cwd: root });
  for (const tree of parser.parseSourceFiles(files)) {
    const file = path.relative(root, tree.fileName).split(path.sep).join("/");
    const scoped = isSettingsSource(file);
    const where = (node: ts.Node) =>
      `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
    const refer = (id: string, node: ts.Node) => {
      const list = references.get(id) ?? [];
      list.push({ file, at: where(node) });
      references.set(id, list);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree);
        const attributes = new Map<string, ts.JsxAttribute>();
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute)) {
            attributes.set(attribute.name.getText(tree), attribute);
          }
        }
        const named = SELF_NAMED_ROWS[tag];
        const settings = named
          ? settingLiterals(attributes.get("preference")?.initializer).map(named)
          : settingLiterals(attributes.get("setting")?.initializer);
        const raw = /^[a-z]/u.test(tag) && hasRowClass(attributes.get("class")?.initializer);
        if (raw) {
          settings.push(...settingLiterals(attributes.get("id")?.initializer));
        }
        for (const setting of settings) {
          refer(setting, node);
        }
        const identified = raw
          ? attributes.has("id") || attributes.has("data-settings-info")
          : named
            ? true
            : attributes.has("setting") || attributes.has("info");
        if (scoped && (raw || ROW_COMPONENTS.has(tag)) && !identified) {
          const list = unnamed.get(file) ?? [];
          list.push(`${where(node)}: <${tag}> has no setting ID`);
          unnamed.set(file, list);
        }
      }
      node.forEachChild(visit);
    };
    visit(tree);
  }

  for (const [id, all] of references) {
    // Files still waiting for their IDs may use `setting` for something else.
    const places = all.filter((place) => !baseline.has(place.file)).map((place) => place.at);
    if (places.length === 0) {
      continue;
    }
    if (!ids.has(id)) {
      failures.push(
        `${places.join(", ")}: setting ID ${id} is not listed in src/shared/control-ui-settings`,
      );
    } else if (places.length > 1) {
      failures.push(`Setting ID ${id} is drawn more than once: ${places.join(", ")}`);
    }
  }
  for (const id of ids.keys()) {
    if (!references.has(id)) {
      failures.push(
        `Setting ID ${id} is listed for ${ids.get(id)} but no row draws it; remove it or give it an alias`,
      );
    }
  }

  for (const [file, problems] of unnamed) {
    if (!baseline.has(file)) {
      failures.push(...problems.map((problem) => `${problem}. ${GUIDANCE}`));
    }
  }
  if (writeBaseline) {
    // Only for adopting the check: the list may shrink afterwards, never grow.
    fs.writeFileSync(baselinePath, `${[...unnamed.keys()].toSorted().join("\n")}\n`);
    return checkSettingIds(root, { write, list });
  }
  for (const file of baseline) {
    if (!unnamed.has(file)) {
      failures.push(`${BASELINE}: ${file} names all its settings now; remove it from the list`);
    }
  }

  // Published IDs stay valid: a listed ID may leave only by becoming an alias.
  const snapshotPath = path.join(root, SNAPSHOT);
  const published = fs.existsSync(snapshotPath)
    ? fs.readFileSync(snapshotPath, "utf8").split("\n").filter(Boolean)
    : [];
  for (const id of published) {
    if (!ids.has(id) && !aliases.has(id)) {
      failures.push(
        `Setting ID ${id} was removed. Links to it would stop landing: add it to CONTROL_UI_SETTING_ID_ALIASES, or delete it from ${SNAPSHOT} on purpose.`,
      );
    }
  }
  const expected = [...new Set([...published, ...ids.keys()])].toSorted();
  if (expected.join("\n") !== published.join("\n")) {
    if (write) {
      fs.writeFileSync(snapshotPath, `${expected.join("\n")}\n`);
    } else {
      failures.push(
        `${SNAPSHOT} is missing new setting IDs; run pnpm check:control-ui-setting-ids --write`,
      );
    }
  }
  return failures;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const failures = checkSettingIds(root, {
    write: argv.includes("--write"),
    writeBaseline: argv.includes("--write-baseline"),
  });
  if (failures.length > 0) {
    console.error(
      ["Control UI setting IDs:", ...failures.map((failure) => `  ${failure}`)].join("\n"),
    );
    return 1;
  }
  console.log("Control UI setting IDs OK.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}

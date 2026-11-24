// Every row on a Settings page names the setting it edits, or says it is not a setting, and
// every hand-built setting ID is listed once in src/shared/control-ui-settings and drawn once.
// Bundled plugin Settings views follow the same rule; their IDs come from the plugin manifest's
// controlUi.settingsViews[].settings.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript/ast";
import { normalizeManifestControlUi } from "../src/plugins/manifest-control-ui.ts";
import {
  CONTROL_UI_SETTING_ID_ALIASES,
  CONTROL_UI_SETTINGS_PAGES,
} from "../src/shared/control-ui-settings/index.ts";
import {
  isTest,
  PLUGIN_UI_SOURCE_ROOTS,
  readInventorySources,
} from "./control-ui-solid-inventory.mts";
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
const SNAPSHOT = "config/control-ui-setting-ids.txt";
const guidance = (source: string) =>
  `Give the row \`setting="<id>"\` (raw rows: \`id="<id>"\`) with an ID listed in ${source}, or mark a status, fact or action row \`info\` (raw rows: \`data-settings-info\`).`;
const CORE_LIST = "src/shared/control-ui-settings";

export function isSettingsSource(file: string) {
  return (
    file.endsWith(".tsx") &&
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

type PluginSettings = { manifest: string; roots: string[]; ids: Set<string> };

/** Bundled plugins that draw Settings views, with the setting IDs their manifests declare. */
function pluginSettings(root: string) {
  const plugins = new Map<string, PluginSettings>();
  for (const source of PLUGIN_UI_SOURCE_ROOTS) {
    const manifest = `${source.split("/").slice(0, 2).join("/")}/openclaw.plugin.json`;
    const file = path.join(root, manifest);
    if (!fs.existsSync(file)) {
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const controlUi = normalizeManifestControlUi(raw.controlUi, raw.channels, raw.id);
    if (!controlUi.ok) {
      throw new Error(`${manifest}: ${controlUi.error}`);
    }
    if (!controlUi.value?.settingsViews) {
      continue;
    }
    const plugin = plugins.get(manifest) ?? {
      manifest,
      roots: [],
      ids: new Set(controlUi.value.settingsViews.flatMap((view) => Object.keys(view.settings))),
    };
    plugin.roots.push(source);
    plugins.set(manifest, plugin);
  }
  return [...plugins.values()];
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
    list = { pages: CONTROL_UI_SETTINGS_PAGES, aliases: CONTROL_UI_SETTING_ID_ALIASES },
  }: { write?: boolean; list?: SettingsList } = {},
): string[] {
  const failures: string[] = [];
  const ids = registryIds(list.pages);
  const aliases = new Set(Object.keys(list.aliases));
  const references = new Map<
    string,
    Array<{ file: string; at: string; plugin: PluginSettings | undefined }>
  >();
  const unnamed = new Map<string, string[]>();
  const plugins = pluginSettings(root);
  const pluginOf = (file: string) =>
    plugins.find((plugin) =>
      plugin.roots.some((source) => file === source || file.startsWith(`${source}/`)),
    );
  const sources = readInventorySources(root, {
    roots: ["ui/src", ...plugins.flatMap((plugin) => plugin.roots)],
  });
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
    const plugin = pluginOf(file);
    const scoped = plugin !== undefined || isSettingsSource(file);
    const where = (node: ts.Node) =>
      `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
    const refer = (id: string, node: ts.Node) => {
      const places = references.get(id) ?? [];
      places.push({ file, at: where(node), plugin });
      references.set(id, places);
    };
    // A row component imported under another name is still that row.
    const imported = new Map<string, string>();
    for (const statement of tree.statements) {
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : undefined;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          imported.set(binding.name.text, (binding.propertyName ?? binding.name).text);
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const local = node.tagName.getText(tree);
        const tag = imported.get(local) ?? local;
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
          const problems = unnamed.get(file) ?? [];
          problems.push(
            `${where(node)}: <${tag}> has no setting ID. ${guidance(plugin ? `${plugin.manifest} controlUi.settingsViews[].settings` : CORE_LIST)}`,
          );
          unnamed.set(file, problems);
        }
      }
      node.forEachChild(visit);
    };
    visit(tree);
  }

  for (const [id, all] of references) {
    const places = all.filter((place) => !place.plugin).map((place) => place.at);
    if (places.length === 0) {
      continue;
    }
    if (!ids.has(id)) {
      failures.push(`${places.join(", ")}: setting ID ${id} is not listed in ${CORE_LIST}`);
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

  // A plugin draws only the IDs its manifest declares for its views, each exactly once.
  for (const plugin of plugins) {
    const key = `${plugin.manifest} controlUi.settingsViews[].settings`;
    for (const [id, all] of references) {
      const places = all.filter((place) => place.plugin === plugin).map((place) => place.at);
      if (places.length > 0 && !plugin.ids.has(id)) {
        failures.push(`${places.join(", ")}: setting ID ${id} is not declared in ${key}`);
      } else if (places.length > 1) {
        failures.push(`Setting ID ${id} is drawn more than once: ${places.join(", ")}`);
      }
    }
    for (const id of plugin.ids) {
      if (!references.get(id)?.some((place) => place.plugin === plugin)) {
        failures.push(`Setting ID ${id} is declared in ${key} but no row draws it`);
      }
      if (ids.has(id)) {
        failures.push(`Setting ID ${id} is declared in ${key} and listed in ${CORE_LIST}`);
      }
    }
  }

  for (const problems of unnamed.values()) {
    failures.push(...problems);
  }

  // Published IDs stay valid: a listed ID may leave only by becoming an alias.
  const snapshotPath = path.join(root, SNAPSHOT);
  const published = fs.existsSync(snapshotPath)
    ? fs.readFileSync(snapshotPath, "utf8").split("\n").filter(Boolean)
    : [];
  const current = new Set(ids.keys());
  for (const plugin of plugins) {
    plugin.ids.forEach((id) => current.add(id));
  }
  for (const id of published) {
    if (!current.has(id) && !aliases.has(id)) {
      failures.push(
        `Setting ID ${id} was removed. Links to it would stop landing: add it to CONTROL_UI_SETTING_ID_ALIASES, or delete it from ${SNAPSHOT} on purpose.`,
      );
    }
  }
  const expected = [...new Set([...published, ...current])].toSorted();
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
  const failures = checkSettingIds(root, { write: argv.includes("--write") });
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

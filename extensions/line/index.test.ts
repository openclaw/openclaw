import { execFileSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function normalizeModuleSpecifier(specifier: string): string | null {
  if (specifier.startsWith("./src/")) {
    return specifier;
  }
  if (specifier.startsWith("../../extensions/line/src/")) {
    return `./src/${specifier.slice("../../extensions/line/src/".length)}`;
  }
  return null;
}

function collectModuleExportNames(filePath: string): string[] {
  const sourcePath = filePath.replace(/\.js$/, ".ts");
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          names.add(element.name.text);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) {
        names.add(statement.name.text);
      }
    }
  }

  return Array.from(names).toSorted();
}

function collectRuntimeApiOverlapExports(params: {
  lineRuntimePath: string;
  runtimeApiPath: string;
}): string[] {
  const runtimeApiSource = readFileSync(params.runtimeApiPath, "utf8");
  const runtimeApiFile = ts.createSourceFile(
    params.runtimeApiPath,
    runtimeApiSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const runtimeApiLocalModules = new Set<string>();
  let pluginSdkLineRuntimeSeen = false;

  for (const statement of runtimeApiFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!moduleSpecifier) {
      continue;
    }
    if (moduleSpecifier === "openclaw/plugin-sdk/line-runtime") {
      pluginSdkLineRuntimeSeen = true;
      continue;
    }
    if (!pluginSdkLineRuntimeSeen) {
      continue;
    }
    const normalized = normalizeModuleSpecifier(moduleSpecifier);
    if (normalized) {
      runtimeApiLocalModules.add(normalized);
    }
  }

  const lineRuntimeSource = readFileSync(params.lineRuntimePath, "utf8");
  const lineRuntimeFile = ts.createSourceFile(
    params.lineRuntimePath,
    lineRuntimeSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const overlapExports = new Set<string>();

  for (const statement of lineRuntimeFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    const normalized = moduleSpecifier ? normalizeModuleSpecifier(moduleSpecifier) : null;
    if (!normalized || !runtimeApiLocalModules.has(normalized)) {
      continue;
    }

    if (!statement.exportClause) {
      for (const name of collectModuleExportNames(
        path.join(process.cwd(), "extensions", "line", normalized),
      )) {
        overlapExports.add(name);
      }
      continue;
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) {
        overlapExports.add(element.name.text);
      }
    }
  }

  return Array.from(overlapExports).toSorted();
}

function collectRuntimeApiPreExports(runtimeApiPath: string): string[] {
  const runtimeApiSource = readFileSync(runtimeApiPath, "utf8");
  const runtimeApiFile = ts.createSourceFile(
    runtimeApiPath,
    runtimeApiSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const preExports = new Set<string>();

  for (const statement of runtimeApiFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!moduleSpecifier) {
      continue;
    }
    if (moduleSpecifier === "openclaw/plugin-sdk/line-runtime") {
      break;
    }
    const normalized = normalizeModuleSpecifier(moduleSpecifier);
    if (!normalized || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) {
        preExports.add(element.name.text);
      }
    }
  }

  return Array.from(preExports).toSorted();
}

describe("line runtime api", () => {
  it("loads through Jiti without duplicate export errors", () => {
    const root = process.cwd();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-jiti-"));
    const runtimeApiPath = path.join(fixtureRoot, "runtime-api.ts");
    const pluginSdkRoot = path.join(fixtureRoot, "plugin-sdk");

    fs.mkdirSync(pluginSdkRoot, { recursive: true });

    const writeFile = (relativePath: string, contents: string) => {
      const filePath = path.join(fixtureRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf8");
      return filePath;
    };

    const botAccessPath = writeFile(
      "src/bot-access.js",
      `export const firstDefined = (...values) => values.find((value) => value !== undefined);
export const isSenderAllowed = () => true;
export const normalizeAllowFrom = (value) => value;
export const normalizeDmAllowFromWithStore = (value) => value;
`,
    );
    const downloadPath = writeFile(
      "src/download.js",
      `export const downloadLineMedia = () => "downloaded";
`,
    );
    const probePath = writeFile(
      "src/probe.js",
      `export const probeLineBot = () => "probed";
`,
    );
    const templateMessagesPath = writeFile(
      "src/template-messages.js",
      `export const buildTemplateMessageFromPayload = () => ({ type: "template" });
`,
    );
    const sendPath = writeFile(
      "src/send.js",
      `export const createQuickReplyItems = () => [];
export const pushFlexMessage = () => "flex";
export const pushLocationMessage = () => "location";
export const pushMessageLine = () => "push";
export const pushMessagesLine = () => "pushMany";
export const pushTemplateMessage = () => "template";
export const pushTextMessageWithQuickReplies = () => "quick";
export const sendMessageLine = () => "send";
`,
    );

    const writePluginSdkShim = (subpath: string, contents: string) => {
      writeFile(path.join("plugin-sdk", `${subpath}.ts`), contents);
    };

    writePluginSdkShim(
      "core",
      `export const clearAccountEntryFields = () => ({});
`,
    );
    writePluginSdkShim(
      "channel-config-schema",
      `export const buildChannelConfigSchema = () => ({});
`,
    );
    writePluginSdkShim(
      "reply-runtime",
      `export {};
`,
    );
    writePluginSdkShim(
      "testing",
      `export {};
`,
    );
    writePluginSdkShim(
      "channel-contract",
      `export {};
`,
    );
    writePluginSdkShim(
      "setup",
      `export const DEFAULT_ACCOUNT_ID = "default";
export const formatDocsLink = (href, fallback) => href ?? fallback;
export const setSetupChannelEnabled = () => {};
export const splitSetupEntries = (entries) => entries;
`,
    );
    writePluginSdkShim(
      "status-helpers",
      `export const buildComputedAccountStatusSnapshot = () => ({});
export const buildTokenChannelStatusSummary = () => "ok";
`,
    );
    writePluginSdkShim(
      "line-runtime",
      `export { firstDefined, isSenderAllowed, normalizeAllowFrom, normalizeDmAllowFromWithStore } from ${JSON.stringify(botAccessPath)};
export { downloadLineMedia } from ${JSON.stringify(downloadPath)};
export { probeLineBot } from ${JSON.stringify(probePath)};
export { buildTemplateMessageFromPayload } from ${JSON.stringify(templateMessagesPath)};
export {
  createQuickReplyItems,
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from ${JSON.stringify(sendPath)};
`,
    );

    fs.writeFileSync(
      runtimeApiPath,
      `export { clearAccountEntryFields } from "openclaw/plugin-sdk/core";
export { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export { buildComputedAccountStatusSnapshot, buildTokenChannelStatusSummary } from "openclaw/plugin-sdk/status-helpers";
export { DEFAULT_ACCOUNT_ID, formatDocsLink, setSetupChannelEnabled, splitSetupEntries } from "openclaw/plugin-sdk/setup";
export { firstDefined, isSenderAllowed, normalizeAllowFrom, normalizeDmAllowFromWithStore } from ${JSON.stringify(botAccessPath)};
export { downloadLineMedia } from ${JSON.stringify(downloadPath)};
export { probeLineBot } from ${JSON.stringify(probePath)};
export { buildTemplateMessageFromPayload } from ${JSON.stringify(templateMessagesPath)};
export {
  createQuickReplyItems,
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from ${JSON.stringify(sendPath)};
export * from "openclaw/plugin-sdk/line-runtime";
`,
      "utf8",
    );

    const script = `
import path from "node:path";
import { createJiti } from "jiti";

const root = ${JSON.stringify(root)};
const runtimeApiPath = ${JSON.stringify(runtimeApiPath)};
const pluginSdkRoot = ${JSON.stringify(pluginSdkRoot)};
const alias = Object.fromEntries([
  "core",
  "channel-config-schema",
  "reply-runtime",
  "testing",
  "channel-contract",
  "setup",
  "status-helpers",
  "line-runtime",
].map((name) => ["openclaw/plugin-sdk/" + name, path.join(pluginSdkRoot, name + ".ts")]));
const jiti = createJiti(path.join(root, "openclaw.mjs"), {
  interopDefault: true,
  tryNative: false,
  fsCache: false,
  moduleCache: false,
  extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  alias,
});
const mod = jiti(runtimeApiPath);
console.log(
  JSON.stringify({
    buildTemplateMessageFromPayload: typeof mod.buildTemplateMessageFromPayload,
    downloadLineMedia: typeof mod.downloadLineMedia,
    isSenderAllowed: typeof mod.isSenderAllowed,
    probeLineBot: typeof mod.probeLineBot,
    pushMessageLine: typeof mod.pushMessageLine,
  }),
);
`;

    try {
      const raw = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: root,
        encoding: "utf-8",
      });
      expect(JSON.parse(raw)).toEqual({
        buildTemplateMessageFromPayload: "function",
        downloadLineMedia: "function",
        isSenderAllowed: "function",
        probeLineBot: "function",
        pushMessageLine: "function",
      });
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 240_000);

  it("keeps the LINE pre-export block aligned with plugin-sdk/line-runtime overlap", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");
    const lineRuntimePath = path.join(process.cwd(), "src", "plugin-sdk", "line-runtime.ts");

    expect(collectRuntimeApiPreExports(runtimeApiPath)).toEqual(
      collectRuntimeApiOverlapExports({
        lineRuntimePath,
        runtimeApiPath,
      }),
    );
  });
});

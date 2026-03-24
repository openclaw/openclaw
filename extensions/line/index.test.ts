import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});

import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("line runtime api", () => {
  it("loads through Jiti without duplicate export errors", () => {
    const root = process.cwd();
    const runtimeApiPath = path.join(root, "extensions", "line", "runtime-api.ts");
    const script = `
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const root = ${JSON.stringify(root)};
const runtimeApiPath = ${JSON.stringify(runtimeApiPath)};
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const exportedSubpaths = Object.keys(pkg.exports ?? {})
  .filter((key) => key.startsWith("./plugin-sdk/"))
  .map((key) => key.slice("./plugin-sdk/".length))
  .filter((name) => name && !name.includes("/"));
const aliasEntries = exportedSubpaths.map((name) => {
  const distPath = path.join(root, "dist", "plugin-sdk", name + ".js");
  const srcPath = path.join(root, "src", "plugin-sdk", name + ".ts");
  return [
    "openclaw/plugin-sdk/" + name,
    fs.existsSync(distPath) ? distPath : srcPath,
  ];
});
const alias = Object.fromEntries(aliasEntries);
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
  }, 240_000);
});

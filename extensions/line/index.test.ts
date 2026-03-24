import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("line runtime api", () => {
  it("loads through Jiti without duplicate export errors", () => {
    const root = process.cwd();
    const runtimeApiPath = path.join(root, "extensions", "line", "runtime-api.ts");
    const pluginSdkSubpaths = [
      "core",
      "channel-config-schema",
      "reply-runtime",
      "testing",
      "channel-contract",
      "setup",
      "status-helpers",
      "line-runtime",
    ];
    const script = `
import path from "node:path";
import { createJiti } from "jiti";

const root = ${JSON.stringify(root)};
const runtimeApiPath = ${JSON.stringify(runtimeApiPath)};
const alias = Object.fromEntries(
  ${JSON.stringify(pluginSdkSubpaths)}.map((name) => [
    "openclaw/plugin-sdk/" + name,
    path.join(root, "dist", "plugin-sdk", name + ".js"),
  ]),
);
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

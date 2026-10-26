import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRuntime,
  pathEmitCommand,
  pathFindCommand,
  pathResolveCommand,
  stderrText,
  stdoutText,
} from "./cli.test-support.js";

describe("openclaw path human output", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    ["resolve", pathResolveCommand],
    ["find", pathFindCommand],
  ] as const)(
    "normalizes file-derived terminal controls in %s human reports",
    async (verb, run) => {
      const filePath = join(tempDirs.make("oc-path-cli-human-"), "report.jsonc");
      const key = "café\u009b2J\u009d0;FORGED\u009c";
      const value = "中文🍵\u009b2J\u009d0;VALUE\u009c";
      const before = JSON.stringify({ [key]: value });
      writeFileSync(filePath, before, "utf-8");
      const address = `oc://report.jsonc/${verb === "find" ? "*" : key}`;
      const human = createTestRuntime();
      await run(address, { file: filePath, human: true }, human);
      expect(human.exitCode).toBe(0);
      expect(stderrText(human)).toBe("");
      expect(stdoutText(human)).toBe(
        verb === "find"
          ? '1 match for oc://report.jsonc/*:\n  oc://report.jsonc/café  →  leaf @ L1: "中文🍵" (string)'
          : 'leaf @ L1: "中文🍵" (string)',
      );

      const json = createTestRuntime();
      await run(address, { file: filePath, json: true }, json);
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(stdoutText(json))).toMatchObject(
        verb === "find"
          ? { matches: [{ path: `oc://report.jsonc/${key}`, match: { valueText: value } }] }
          : { resolved: true, match: { valueText: value } },
      );
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    },
  );

  it("keeps terminal controls in explicit human byte exports", async () => {
    const filePath = join(tempDirs.make("oc-path-cli-human-"), "report.jsonc");
    const before = '{"café":"中文🍵\u009b2J\u009d0;VALUE\u009c"}';
    writeFileSync(filePath, before, "utf-8");
    const rt = createTestRuntime();
    await pathEmitCommand(filePath, { human: true }, rt);
    expect(rt.exitCode).toBe(0);
    expect(stdoutText(rt)).toBe(before);
    expect(readFileSync(filePath, "utf-8")).toBe(before);
  });
});

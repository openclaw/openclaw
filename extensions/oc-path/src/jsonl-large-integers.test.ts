/**
 * JSON integers past 2^53 must stay distinguishable: parsing them as doubles
 * collapses neighbouring literals, so those literals keep their exact source
 * text. Every other spelling keeps the normalized `String(value)` reading.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRuntime,
  pathFindCommand,
  pathResolveCommand,
  stdoutText,
} from "./cli.test-support.js";
import { parseJsonc } from "./oc-path/jsonc/parse.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("openclaw path JSON number identity", () => {
  it("keeps integers past 2^53 exact in find and resolve", async () => {
    const workspaceDir = tempDirs.make("oc-path-large-int-");
    const filePath = join(workspaceDir, "events.jsonl");
    writeFileSync(filePath, '{"id":9007199254740992}\n{"id":9007199254740993}\n', "utf-8");
    const options = { cwd: workspaceDir, json: true };
    const second = createTestRuntime();
    await pathFindCommand("oc://events.jsonl/[id=9007199254740993]/id", options, second);
    expect(JSON.parse(stdoutText(second)).matches).toMatchObject([
      { path: "oc://events.jsonl/L2/id", match: { valueText: "9007199254740993", line: 2 } },
    ]);
    const resolved = createTestRuntime();
    await pathResolveCommand("oc://events.jsonl/L2/id", options, resolved);
    expect(JSON.parse(stdoutText(resolved)).match).toMatchObject({
      valueText: "9007199254740993",
      line: 2,
    });
  });

  it("keeps ordinary number spellings on the normalized reading", async () => {
    const workspaceDir = tempDirs.make("oc-path-normalized-");
    writeFileSync(join(workspaceDir, "events.jsonl"), '{"id":1e3}\n{"id":1.0}\n', "utf-8");
    const options = { cwd: workspaceDir, json: true };
    const exponent = createTestRuntime();
    await pathFindCommand("oc://events.jsonl/[id=1000]/id", options, exponent);
    expect(JSON.parse(stdoutText(exponent)).matches).toMatchObject([
      { path: "oc://events.jsonl/L1/id", match: { valueText: "1000", line: 1 } },
    ]);
    const decimal = createTestRuntime();
    await pathFindCommand("oc://events.jsonl/[id=1]/id", options, decimal);
    expect(JSON.parse(stdoutText(decimal)).matches).toMatchObject([
      { path: "oc://events.jsonl/L2/id", match: { valueText: "1", line: 2 } },
    ]);
  });

  it("stores source text only for integers outside the safe range", () => {
    expect(parseJsonc("42").root).toEqual({ kind: "number", value: 42, line: 1 });
    expect(parseJsonc("1e3").root).toEqual({ kind: "number", value: 1000, line: 1 });
    expect(parseJsonc("-0").root).toEqual({ kind: "number", value: -0, line: 1 });
    expect(parseJsonc("9007199254740993").root).toEqual({
      kind: "number",
      value: 9007199254740992,
      raw: "9007199254740993",
      line: 1,
    });
  });
});

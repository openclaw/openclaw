/**
 * JSON integers past 2^53 must stay distinguishable: parsing them as doubles
 * collapses neighbouring literals, so find/resolve compare exact source text.
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("openclaw path JSONL large integers", () => {
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
});

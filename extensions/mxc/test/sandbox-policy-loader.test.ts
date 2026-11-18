import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { expect, test } from "vitest";
import { loadSandboxBaselinePolicy } from "../src/sandbox-policy-loader.js";

test.each([0, null])("rejects invalid timeout %s at policy admission", async (timeoutSeconds) => {
  await using workspace = await tempWorkspace({
    rootDir: tmpdir(),
    prefix: "openclaw-mxc-policy-",
  });
  const file = join(workspace.dir, "policy.json");
  writeFileSync(file, JSON.stringify({ process: { timeoutSeconds } }), "utf-8");
  expect(() => loadSandboxBaselinePolicy({ policyPaths: [file] })).toThrow(/timeoutSeconds/u);
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCliProcessChild } from "../../../src/cli/cli-process-child.test-helpers.js";
import { resolveTestNodeExecPath } from "../../../src/test-utils/node-process.js";

const fixture = fileURLToPath(new URL("./sdk-loading.test-support.mjs", import.meta.url));
const cases = [
  ["helpers", "success"],
  ...[
    "provider-completions",
    "provider-responses",
    "transport-completions",
    "transport-responses",
    "transport-azure",
    "anthropic",
    "anthropic-injected",
  ].flatMap((family) => ["success", "abort", "reject"].map((mode) => [family, mode])),
  ["transport-responses", "revoke"],
  ...["abort", "reject", "revoke"].map((mode) => ["websocket", mode]),
];

describe("built AI package cold loading", () => {
  // A fresh ESM cache is the contract under test; warm source mocks cannot prove it.
  it.each(cases)("%s: %s", async (family, mode) => {
    const result = await runCliProcessChild({
      nodeExecutable: resolveTestNodeExecPath(),
      nodeArgs: [fixture, family, mode],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      timeoutMs: 15_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ family, mode, passed: true });
  });
});

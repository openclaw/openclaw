import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../../test/helpers/run-node-script.js";

it("shares live attempt prompts and releases their owners after completion", async ({ signal }) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/attempt-system-prompt-retention.ts",
      "--assert-shared",
    ],
    process.env,
    undefined,
    { cwd: fileURLToPath(new URL("../../../../", import.meta.url)), signal },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each(["initial", "after-reset"])(
  "collects failed %s admission owners while the runtime remains usable",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./runtime.admission-retention.test-support.ts", import.meta.url)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);

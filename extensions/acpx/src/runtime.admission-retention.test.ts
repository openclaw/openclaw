import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { it } from "vitest";
import { admissionRetentionEntrypoint } from "./runtime.admission-retention-entrypoint.test-support.js";

it.each(["initial", "after-reset"])(
  "collects failed %s admission owners while the runtime remains usable",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(admissionRetentionEntrypoint)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);

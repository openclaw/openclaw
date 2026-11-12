import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

it("bounds live skill-catalog metadata across repeated session preparations", async () => {
  await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "installed-skill-retention.test-support",
          distWorkerPath: "agents/installed-skill-retention.test-support.js",
        }),
      ),
    ],
    { timeout: 20_000 },
  );
}, 25_000);

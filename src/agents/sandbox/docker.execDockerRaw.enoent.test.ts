import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { execDockerRaw } from "./docker.js";

describe("execDockerRaw", () => {
  it("wraps docker ENOENT with an actionable configuration error", async () => {
    await withEnvAsync({ PATH: "" }, async () => {
      let err: unknown;
      try {
        await execDockerRaw(["version"]);
      } catch (caught) {
        err = caught;
      }

      expect(err).toBeInstanceOf(Error);
      const error = err as Error & { code?: string };
      expect(error.code).toBe("INVALID_CONFIG");
      expect(error.message).toBe(
        'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.',
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "times out and aborts a stalled docker subprocess",
    async () => {
      const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-docker-timeout-"));
      try {
        const dockerPath = path.join(binDir, "docker");
        await fs.writeFile(dockerPath, "#!/bin/sh\nsleep 5\n", "utf8");
        await fs.chmod(dockerPath, 0o755);

        await withEnvAsync({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
          const startedAt = Date.now();
          await expect(execDockerRaw(["ps"], { timeoutMs: 50 })).rejects.toMatchObject({
            name: "TimeoutError",
          });
          expect(Date.now() - startedAt).toBeLessThan(2000);
        });
      } finally {
        await fs.rm(binDir, { recursive: true, force: true });
      }
    },
  );
});

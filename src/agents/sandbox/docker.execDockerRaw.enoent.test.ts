// Docker command tests cover actionable errors when sandbox mode cannot find
// the docker executable.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { execDockerRaw } from "./docker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("execDockerRaw", () => {
  it("wraps docker ENOENT with an actionable configuration error", async () => {
    // ENOENT otherwise looks like a low-level spawn failure; operators need the
    // sandbox config remediation in the error text.
    // Bun substitutes its default search path for PATH="".
    await withEnvAsync({ PATH: tempDirs.make("openclaw-missing-docker-") }, async () => {
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
});

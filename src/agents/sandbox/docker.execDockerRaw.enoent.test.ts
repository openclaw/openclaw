// Docker command tests cover actionable errors when sandbox mode cannot find
// the docker executable. Error text guides the operator rather than suggesting
// direct agent-executable config commands.
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { execDockerRaw } from "./docker.js";

describe("execDockerRaw", () => {
  it("wraps docker ENOENT with an operator-visible configuration error", async () => {
    // ENOENT otherwise looks like a low-level spawn failure; operators need the
    // sandbox config remediation in the error text.
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
        'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker, or ask the operator to disable sandbox mode.',
      );
    });
  });
});

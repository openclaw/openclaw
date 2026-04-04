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
      expect(err).toMatchObject({ code: "INVALID_CONFIG" });
      expect((err as Error).message).toContain("Sandbox mode requires Docker");
      expect((err as Error).message).toContain("agents.defaults.sandbox.mode=off");
    });
  });
});

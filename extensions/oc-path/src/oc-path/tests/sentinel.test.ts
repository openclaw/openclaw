// OC Path tests cover sentinel plugin behavior.
import { describe, expect, it } from "vitest";
import { OcEmitSentinelError, REDACTED_SENTINEL, guardSentinel } from "../sentinel.js";

describe("guardSentinel", () => {
  it("includes the OcPath in the refusal message", () => {
    try {
      guardSentinel(REDACTED_SENTINEL, "oc://config/plugins.entries.foo.token");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcEmitSentinelError);
      expect(err).toMatchObject({
        message: `emit refused to write "${REDACTED_SENTINEL}" sentinel literal at oc://config/plugins.entries.foo.token`,
      });
    }
  });
});

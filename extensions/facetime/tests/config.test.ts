import { describe, expect, it } from "vitest";
import {
  defaultFaceTimeHelperPort,
  resolveFaceTimeConfig,
  validateFaceTimeConfig,
} from "../src/config.js";

describe("facetime config", () => {
  it("resolves helper port defaults", () => {
    const config = resolveFaceTimeConfig({
      whitelistHandles: ["mailto:omar@example.com"],
    });

    expect(config.helperPort).toBe(defaultFaceTimeHelperPort());
    expect("audio" in config).toBe(false);
    expect(config.realtime.model).toBe("gpt-realtime-2.1");
    expect(config.realtime.voice).toBe("marin");
    expect(config.realtime.brain).toBe("agent-consult");
    expect(config.realtime.toolPolicy).toBe("owner");
    expect(config.realtime.instructions).toContain("configured OpenClaw agent");
    expect(config.realtime.instructions).not.toContain("Lobster");
    expect(config.realtime.instructions).not.toContain("Omar");
  });

  it("requires at least one whitelist handle", () => {
    const validation = validateFaceTimeConfig(resolveFaceTimeConfig({}));

    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("whitelistHandles");
  });
});

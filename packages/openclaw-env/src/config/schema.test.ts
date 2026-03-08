import { describe, expect, it } from "vitest";
import { OpenClawEnvConfigSchema } from "./schema.js";

describe("OpenClawEnvConfigSchema", () => {
  it("applies defaults for minimal config", () => {
    const cfg = OpenClawEnvConfigSchema.parse({ schema_version: "openclaw_env.v1" });
    expect(cfg.openclaw.image).toBe("openclaw:local");
    expect(cfg.workspace.mode).toBe("ro");
    expect(cfg.workspace.write_allowlist).toEqual([]);
    expect(cfg.network.mode).toBe("off");
    expect(cfg.secrets.mode).toBe("none");
    expect(cfg.limits.cpus).toBe(2);
    expect(cfg.limits.memory).toBe("4g");
    expect(cfg.limits.pids).toBe(256);
    expect(cfg.runtime.user).toBe("1000:1000");
    expect(cfg.write_guards.enabled).toBe(false);
    expect(cfg.write_guards.dry_run_audit).toBe(false);
    expect(cfg.write_guards.poll_interval_ms).toBe(2000);
  });

  it("rejects invalid network mode", () => {
    expect(() =>
      OpenClawEnvConfigSchema.parse({
        schema_version: "openclaw_env.v1",
        network: { mode: "wat" },
      }),
    ).toThrow();
  });

  it("rejects workspace write_allowlist when workspace.mode=rw", () => {
    expect(() =>
      OpenClawEnvConfigSchema.parse({
        schema_version: "openclaw_env.v1",
        workspace: {
          path: ".",
          mode: "rw",
          write_allowlist: [".openclaw-cache"],
        },
      }),
    ).toThrow();
  });
});

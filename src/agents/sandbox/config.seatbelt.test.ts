import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { DEFAULT_SANDBOX_SEATBELT_PROFILE_DIR } from "./constants.js";

describe("resolveSandboxConfigForAgent (seatbelt)", () => {
  it("defaults backend to docker", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.backend).toBe("docker");
  });

  it("resolves seatbelt defaults with profileDir fallback", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
            },
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.backend).toBe("seatbelt");
    expect(sandbox.seatbelt.profile).toBe("demo-open");
    expect(sandbox.seatbelt.profileDir).toBe(DEFAULT_SANDBOX_SEATBELT_PROFILE_DIR);
  });

  it("merges seatbelt params with agent override precedence", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
              params: {
                ALPHA: "global",
                SHARED: "global",
              },
            },
          },
        },
        list: [
          {
            id: "work",
            sandbox: {
              seatbelt: {
                profileDir: "~/seatbelt-profiles-work",
                params: {
                  ALPHA: "agent",
                  BETA: "agent",
                },
              },
            },
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "work");
    expect(sandbox.seatbelt.profileDir).toBe(path.join(os.homedir(), "seatbelt-profiles-work"));
    expect(sandbox.seatbelt.params).toEqual({
      ALPHA: "agent",
      SHARED: "global",
      BETA: "agent",
    });
  });

  it("ignores agent seatbelt overrides under shared scope", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "shared",
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
              params: {
                ALPHA: "global",
              },
            },
          },
        },
        list: [
          {
            id: "work",
            sandbox: {
              seatbelt: {
                profile: "demo-restricted",
                params: {
                  ALPHA: "agent",
                },
              },
            },
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "work");
    expect(sandbox.seatbelt.profile).toBe("demo-open");
    expect(sandbox.seatbelt.params).toEqual({ ALPHA: "global" });
  });

  it("inherits seatbelt.profile from defaults for agent backend override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "seatbelt",
            seatbelt: {
              profile: "demo-open",
            },
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              backend: "seatbelt",
            },
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "worker");
    expect(sandbox.backend).toBe("seatbelt");
    expect(sandbox.seatbelt.profile).toBe("demo-open");
  });

  it("throws when seatbelt backend has no merged profile", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "seatbelt",
          },
        },
      },
    };

    expect(() => resolveSandboxConfigForAgent(cfg, "main")).toThrow(/sandbox.seatbelt.profile/);
  });

});

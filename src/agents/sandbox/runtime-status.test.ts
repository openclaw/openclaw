import { describe, expect, it } from "vitest";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

describe("resolveSandboxRuntimeStatus", () => {
  it("returns sandboxed=false for mode='all' when sessionKey is empty", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
            },
          },
        },
      } as never,
      sessionKey: "",
    });
    expect(result.mode).toBe("all");
    expect(result.sandboxed).toBe(false);
  });

  it("returns sandboxed=true for mode='all' with a non-empty sessionKey", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
            },
          },
        },
      } as never,
      sessionKey: "cron:test-session",
    });
    expect(result.mode).toBe("all");
    expect(result.sandboxed).toBe(true);
  });

  it("returns sandboxed=false for mode='off' with non-empty sessionKey", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
            },
          },
        },
      } as never,
      sessionKey: "cron:test-session",
    });
    expect(result.mode).toBe("off");
    expect(result.sandboxed).toBe(false);
  });

  it("returns sandboxed=false for mode='off' with empty sessionKey", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "off",
            },
          },
        },
      } as never,
      sessionKey: "",
    });
    expect(result.mode).toBe("off");
    expect(result.sandboxed).toBe(false);
  });

  it("returns sandboxed=false for missing sandbox config with empty sessionKey", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: {} as never,
      sessionKey: "",
    });
    expect(result.mode).toBe("off");
    expect(result.sandboxed).toBe(false);
  });

  it("returns sandboxed=false for mode='all' with undefined sessionKey", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
            },
          },
        },
      } as never,
    });
    expect(result.mode).toBe("all");
    expect(result.sandboxed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";

// We need to test the internal defaultSandboxConfig function, but it's not exported.
// Instead, we test the behavior through resolveSandboxContext which uses it.

describe("Agent-specific sandbox config", () => {
  it("should use global sandbox config when no agent-specific config exists", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");
    
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "all",
          scope: "agent",
        },
      },
      routing: {
        agents: {
          main: {
            workspace: "~/clawd",
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
    });

    expect(context).toBeDefined();
    expect(context?.enabled).toBe(true);
  });

  it("should override with agent-specific sandbox mode 'off'", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");
    
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "all", // Global default
          scope: "agent",
        },
      },
      routing: {
        agents: {
          main: {
            workspace: "~/clawd",
            sandbox: {
              mode: "off", // Agent override
            },
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
    });

    // Should be null because mode is "off"
    expect(context).toBeNull();
  });

  it("should use agent-specific sandbox mode 'all'", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");
    
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "off", // Global default
        },
      },
      routing: {
        agents: {
          family: {
            workspace: "~/clawd-family",
            sandbox: {
              mode: "all", // Agent override
              scope: "agent",
            },
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
      workspaceDir: "/tmp/test-family",
    });

    expect(context).toBeDefined();
    expect(context?.enabled).toBe(true);
  });

  it("should use agent-specific scope", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");
    
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "all",
          scope: "session", // Global default
        },
      },
      routing: {
        agents: {
          work: {
            workspace: "~/clawd-work",
            sandbox: {
              mode: "all",
              scope: "agent", // Agent override
            },
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:work:slack:channel:456",
      workspaceDir: "/tmp/test-work",
    });

    expect(context).toBeDefined();
    // The container name should use agent scope (agent:work)
    expect(context?.containerName).toContain("agent-work");
  });

  it("should use agent-specific workspaceRoot", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");
    
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceRoot: "~/.clawdbot/sandboxes", // Global default
        },
      },
      routing: {
        agents: {
          isolated: {
            workspace: "~/clawd-isolated",
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceRoot: "/tmp/isolated-sandboxes", // Agent override
            },
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:isolated:main",
      workspaceDir: "/tmp/test-isolated",
    });

    expect(context).toBeDefined();
    expect(context?.workspaceDir).toContain("/tmp/isolated-sandboxes");
  });

  it("should prefer agent config over global for multiple agents", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");
    
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "non-main",
          scope: "session",
        },
      },
      routing: {
        agents: {
          main: {
            workspace: "~/clawd",
            sandbox: {
              mode: "off", // main: no sandbox
            },
          },
          family: {
            workspace: "~/clawd-family",
            sandbox: {
              mode: "all", // family: always sandbox
              scope: "agent",
            },
          },
        },
      },
    };

    // main agent should not be sandboxed
    const mainContext = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:telegram:group:789",
      workspaceDir: "/tmp/test-main",
    });
    expect(mainContext).toBeNull();

    // family agent should be sandboxed
    const familyContext = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
      workspaceDir: "/tmp/test-family",
    });
    expect(familyContext).toBeDefined();
    expect(familyContext?.enabled).toBe(true);
  });
});

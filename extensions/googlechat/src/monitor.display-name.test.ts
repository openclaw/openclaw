import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { resolveBotDisplayName } from "./monitor.js";

describe("resolveBotDisplayName", () => {
  it("prefers explicit account name", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            identity: { name: "Identity Agent" },
          },
        ],
      },
    } as OpenClawConfig;

    const name = resolveBotDisplayName({
      accountName: "Google Chat Bot",
      agentId: "main",
      config,
    });

    expect(name).toBe("Google Chat Bot");
  });

  it("uses agent identity name when account name is not set", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            identity: { name: "Identity Agent" },
          },
        ],
      },
    } as OpenClawConfig;

    const name = resolveBotDisplayName({
      agentId: "main",
      config,
    });

    expect(name).toBe("Identity Agent");
  });

  it("falls back to legacy agent name when identity is not set", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            name: "Legacy Agent Name",
          },
        ],
      },
    } as OpenClawConfig;

    const name = resolveBotDisplayName({
      agentId: "main",
      config,
    });

    expect(name).toBe("Legacy Agent Name");
  });

  it("falls back to OpenClaw when no name is configured", () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
          },
        ],
      },
    } as OpenClawConfig;

    const name = resolveBotDisplayName({
      agentId: "main",
      config,
    });

    expect(name).toBe("OpenClaw");
  });
});

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools memory plugin allowlist", () => {
  it("includes memory-core tools when agent allowlist uses group:memory", () => {
    const cfg: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: ["memory-core"],
        slots: {
          memory: "memory-core",
        },
        entries: {
          "memory-core": {
            enabled: true,
          },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "openai",
            model: "text-embedding-3-small",
            fallback: "none",
            sources: ["memory"],
          },
        },
        list: [
          {
            id: "nova",
            workspace: "~/workspace-nova",
            tools: {
              allow: ["group:fs", "group:runtime", "group:memory"],
            },
          },
        ],
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      agentId: "nova",
      sessionKey: "agent:nova:main",
      workspaceDir: "/tmp/test-nova",
      agentDir: "/tmp/agent-nova",
      senderIsOwner: true,
    });

    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_get");
  });
});

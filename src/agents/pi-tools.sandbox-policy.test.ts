import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";

function listToolNames(cfg: OpenClawConfig): string[] {
  const workspaceDir = "/tmp/openclaw-sandbox-policy";
  const sandbox = createPiToolsSandboxContext({
    workspaceDir,
    fsBridge: createHostSandboxFsBridge(workspaceDir),
  });
  return createOpenClawCodingTools({
    config: cfg,
    agentId: "tavern",
    sessionKey: "agent:tavern:main",
    sandbox,
    workspaceDir,
  })
    .map((tool) => tool.name)
    .toSorted();
}

describe("pi-tools sandbox policy", () => {
  it("re-exposes omitted sandbox tools via sandbox alsoAllow", () => {
    const names = listToolNames({
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
    } as OpenClawConfig);

    expect(names).toContain("message");
    expect(names).toContain("tts");
  });

  it("re-enables default-denied sandbox tools when explicitly allowed", () => {
    const names = listToolNames({
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [{ id: "tavern" }],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
    } as OpenClawConfig);

    expect(names).toContain("browser");
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    const names = listToolNames({
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [{ id: "tavern" }],
      },
      tools: {
        sandbox: {
          tools: {
            allow: [],
            alsoAllow: ["browser"],
          },
        },
      },
    } as OpenClawConfig);

    expect(names).toContain("browser");
    expect(names).toContain("read");
  });

  it("keeps explicit sandbox deny precedence over explicit allow", () => {
    const names = listToolNames({
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [{ id: "tavern" }],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser", "message"],
            deny: ["browser"],
          },
        },
      },
    } as OpenClawConfig);

    expect(names).not.toContain("browser");
    expect(names).toContain("message");
  });
});

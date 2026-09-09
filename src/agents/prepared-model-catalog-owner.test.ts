import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import type { PublishedModelCatalogOwnerCandidate } from "./prepared-model-catalog.types.js";

const hostConfig = {
  agents: {
    entries: {
      "r-harris": {
        model: "openai/gpt-5.5",
        workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
      },
    },
  },
} satisfies OpenClawConfig;

function ownerCandidate(
  overrides: Partial<PublishedModelCatalogOwnerCandidate> = {},
): PublishedModelCatalogOwnerCandidate {
  return {
    agentId: "r-harris",
    agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
    workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
    config: hostConfig,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    modelCatalog: { entries: [], routeVariants: [] },
    ...overrides,
  };
}

describe("published model catalog owner resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds a router-safe published owner to the configured agent identity", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
    vi.stubEnv("HOME", "/home/openclaw");

    expect(resolvePublishedModelCatalogOwner(ownerCandidate())).toMatchObject({
      agentId: "r-harris",
      agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
      workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
    });
  });

  it("derives the router-safe workspace when the published owner omits workspaceDir", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
    vi.stubEnv("HOME", "/home/openclaw");
    const { workspaceDir: _workspaceDir, ...candidate } = ownerCandidate();

    expect(resolvePublishedModelCatalogOwner(candidate).workspaceDir).toBe(
      "/home/openclaw/.openclaw/agents/r-harris/workspace",
    );
  });

  it("fails closed when a router-safe published path has no unique configured identity", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
    vi.stubEnv("HOME", "/home/openclaw");

    expect(() =>
      resolvePublishedModelCatalogOwner(
        ownerCandidate({
          agentId: "missing",
        }),
      ),
    ).toThrow("did not identify one configured agent");
  });

  it("keeps shared directory matches ambiguous without an explicit owner id", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
    vi.stubEnv("HOME", "/home/openclaw");
    const config = {
      agents: {
        entries: {
          first: {
            workspace: "/tmp/shared-workspace-a",
            agentDir: "/tmp/shared-agent",
          },
          second: {
            workspace: "/tmp/shared-workspace-b",
            agentDir: "/tmp/shared-agent",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolvePublishedModelCatalogOwner(
        ownerCandidate({
          agentId: undefined,
          agentDir: "/tmp/shared-agent",
          workspaceDir: undefined,
          config,
        }),
      ),
    ).toThrow("did not identify one configured agent");
  });
});

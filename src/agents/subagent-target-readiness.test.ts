import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { __resetRuntimePathMapCacheForTests } from "./sandbox/runtime-path-map.js";
import {
  collectSubagentAllowlistAudit,
  resolveConfiguredSubagentTargetReadiness,
  resolveSubagentTargetReadiness,
} from "./subagent-target-readiness.js";

async function withRuntimePathMap<T>(
  stateDir: string,
  document: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const runtimePathMapPath = path.join(stateDir, "config", "runtime-path-map.json");
  await fs.mkdir(path.dirname(runtimePathMapPath), { recursive: true });
  await fs.writeFile(runtimePathMapPath, JSON.stringify(document, null, 2), "utf8");
  const previous = process.env.OPENCLAW_LOCAL_PATH_MAP;
  process.env.OPENCLAW_LOCAL_PATH_MAP = runtimePathMapPath;
  __resetRuntimePathMapCacheForTests();
  try {
    return await run();
  } finally {
    __resetRuntimePathMapCacheForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_LOCAL_PATH_MAP;
    } else {
      process.env.OPENCLAW_LOCAL_PATH_MAP = previous;
    }
  }
}

async function writePromptPack(rootDir: string): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "AGENTS.md"), "# helper\n", "utf8");
}

describe("subagent target readiness", () => {
  it("treats configured explicit subagent workspaces under lead mounts as ready", async () => {
    await withStateDirEnv("subagent-target-ready-", async ({ stateDir }) => {
      await withRuntimePathMap(
        stateDir,
        {
          container_host_roots: [{ container: "/agent-homes/deb", host: "workspace-deb" }],
        },
        async () => {
          const hostWorkspaceDir = path.join(stateDir, "workspace-deb", "subagents", "jeffy");
          await writePromptPack(hostWorkspaceDir);

          const readiness = resolveConfiguredSubagentTargetReadiness(
            {
              agents: {
                list: [
                  {
                    id: "jeffy",
                    workspace: "/agent-homes/deb/subagents/jeffy",
                  },
                ],
              },
            },
            "jeffy",
          );

          expect(readiness.status).toBe("ready");
          expect(readiness.hostWorkspaceDir).toBe(hostWorkspaceDir);
        },
      );
    });
  });

  it("uses the canonical state-dir runtime path map when OPENCLAW_LOCAL_PATH_MAP is unset", async () => {
    await withStateDirEnv("subagent-target-default-runtime-map-", async ({ stateDir }) => {
      const runtimePathMapPath = path.join(stateDir, "config", "runtime-path-map.json");
      await fs.mkdir(path.dirname(runtimePathMapPath), { recursive: true });
      await fs.writeFile(
        runtimePathMapPath,
        JSON.stringify(
          {
            container_host_roots: [{ container: "/agent-homes/scout", host: "workspace-scout" }],
          },
          null,
          2,
        ),
        "utf8",
      );

      const previous = process.env.OPENCLAW_LOCAL_PATH_MAP;
      delete process.env.OPENCLAW_LOCAL_PATH_MAP;
      __resetRuntimePathMapCacheForTests();

      try {
        const hostWorkspaceDir = path.join(stateDir, "workspace-scout");
        await writePromptPack(hostWorkspaceDir);

        const readiness = resolveConfiguredSubagentTargetReadiness(
          {
            agents: {
              list: [{ id: "scout", workspace: "/agent-homes/scout" }],
            },
          },
          "scout",
        );

        expect(readiness.status).toBe("ready");
        expect(readiness.runtimeMapped).toBe(true);
        expect(readiness.hostWorkspaceDir).toBe(hostWorkspaceDir);
      } finally {
        __resetRuntimePathMapCacheForTests();
        if (previous === undefined) {
          delete process.env.OPENCLAW_LOCAL_PATH_MAP;
        } else {
          process.env.OPENCLAW_LOCAL_PATH_MAP = previous;
        }
      }
    });
  });

  it("classifies configured workspaces with missing prompt packs as missing_workspace", async () => {
    await withStateDirEnv("subagent-target-missing-workspace-", async ({ stateDir }) => {
      await withRuntimePathMap(
        stateDir,
        {
          container_host_roots: [{ container: "/agent-homes/angela", host: "workspace-angela" }],
        },
        async () => {
          const readiness = resolveConfiguredSubagentTargetReadiness(
            {
              agents: {
                list: [{ id: "salt", workspace: "/agent-homes/angela/subagents/salt" }],
              },
            },
            "salt",
          );

          expect(readiness.status).toBe("missing_workspace");
          expect(readiness.hostWorkspaceDir).toBe(
            path.join(stateDir, "workspace-angela", "subagents", "salt"),
          );
          expect(readiness.reasons).toContain("workspace is missing AGENTS.md");
        },
      );
    });
  });

  it("classifies allowlisted helpers without explicit runtime config as stale_allowlist", () => {
    const readiness = resolveSubagentTargetReadiness({
      cfg: {
        agents: {
          list: [{ id: "reverend-run", subagents: { allowAgents: ["dmc"] } }],
        },
      },
      requesterAgentId: "reverend-run",
      targetAgentId: "dmc",
      classifyStaleAllowlist: true,
    });

    expect(readiness.status).toBe("stale_allowlist");
  });

  it("audits allowlist entries using the shared readiness classification", async () => {
    await withStateDirEnv("subagent-target-audit-", async ({ stateDir }) => {
      await withRuntimePathMap(
        stateDir,
        {
          container_host_roots: [{ container: "/agent-homes/deb", host: "workspace-deb" }],
        },
        async () => {
          await writePromptPack(path.join(stateDir, "workspace-deb", "subagents", "jeffy"));

          const audit = collectSubagentAllowlistAudit({
            agents: {
              list: [
                { id: "deb", subagents: { allowAgents: ["jeffy"] } },
                { id: "jeffy", workspace: "/agent-homes/deb/subagents/jeffy" },
                { id: "reverend-run", subagents: { allowAgents: ["dmc"] } },
              ],
            },
          });
          const statuses = Object.fromEntries(audit.map((entry) => [entry.agentId, entry.status]));

          expect(statuses).toEqual({
            dmc: "stale_allowlist",
            jeffy: "ready",
          });
        },
      );
    });
  });
});

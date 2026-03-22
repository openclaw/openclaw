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

const LEAD_ID = "test-lead";
const WORKER_ID = "test-worker";
const WORKER_ID_B = "test-worker-b";
const CONTAINER_ROOT = "/agent-homes";

function containerPath(...segments: string[]): string {
  return [CONTAINER_ROOT, ...segments].join("/");
}

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
    const hostRoot = `workspace-${LEAD_ID}`;
    await withStateDirEnv("subagent-target-ready-", async ({ stateDir }) => {
      await withRuntimePathMap(
        stateDir,
        {
          container_host_roots: [{ container: containerPath(LEAD_ID), host: hostRoot }],
        },
        async () => {
          const hostWorkspaceDir = path.join(stateDir, hostRoot, "subagents", WORKER_ID);
          await writePromptPack(hostWorkspaceDir);

          const readiness = resolveConfiguredSubagentTargetReadiness(
            {
              agents: {
                list: [
                  {
                    id: WORKER_ID,
                    workspace: containerPath(LEAD_ID, "subagents", WORKER_ID),
                  },
                ],
              },
            },
            WORKER_ID,
          );

          expect(readiness.status).toBe("ready");
          expect(readiness.hostWorkspaceDir).toBe(hostWorkspaceDir);
        },
      );
    });
  });

  it("uses the canonical state-dir runtime path map when OPENCLAW_LOCAL_PATH_MAP is unset", async () => {
    const hostRoot = `workspace-${WORKER_ID}`;
    await withStateDirEnv("subagent-target-default-runtime-map-", async ({ stateDir }) => {
      const runtimePathMapPath = path.join(stateDir, "config", "runtime-path-map.json");
      await fs.mkdir(path.dirname(runtimePathMapPath), { recursive: true });
      await fs.writeFile(
        runtimePathMapPath,
        JSON.stringify(
          {
            container_host_roots: [{ container: containerPath(WORKER_ID), host: hostRoot }],
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
        const hostWorkspaceDir = path.join(stateDir, hostRoot);
        await writePromptPack(hostWorkspaceDir);

        const readiness = resolveConfiguredSubagentTargetReadiness(
          {
            agents: {
              list: [{ id: WORKER_ID, workspace: containerPath(WORKER_ID) }],
            },
          },
          WORKER_ID,
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
    const hostRoot = `workspace-${LEAD_ID}`;
    await withStateDirEnv("subagent-target-missing-workspace-", async ({ stateDir }) => {
      await withRuntimePathMap(
        stateDir,
        {
          container_host_roots: [{ container: containerPath(LEAD_ID), host: hostRoot }],
        },
        async () => {
          const readiness = resolveConfiguredSubagentTargetReadiness(
            {
              agents: {
                list: [
                  { id: WORKER_ID, workspace: containerPath(LEAD_ID, "subagents", WORKER_ID) },
                ],
              },
            },
            WORKER_ID,
          );

          expect(readiness.status).toBe("missing_workspace");
          expect(readiness.hostWorkspaceDir).toBe(
            path.join(stateDir, hostRoot, "subagents", WORKER_ID),
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
          list: [{ id: LEAD_ID, subagents: { allowAgents: [WORKER_ID] } }],
        },
      },
      requesterAgentId: LEAD_ID,
      targetAgentId: WORKER_ID,
      classifyStaleAllowlist: true,
    });

    expect(readiness.status).toBe("stale_allowlist");
  });

  it("audits allowlist entries using the shared readiness classification", async () => {
    const hostRoot = `workspace-${LEAD_ID}`;
    await withStateDirEnv("subagent-target-audit-", async ({ stateDir }) => {
      await withRuntimePathMap(
        stateDir,
        {
          container_host_roots: [{ container: containerPath(LEAD_ID), host: hostRoot }],
        },
        async () => {
          await writePromptPack(path.join(stateDir, hostRoot, "subagents", WORKER_ID));

          const audit = collectSubagentAllowlistAudit({
            agents: {
              list: [
                { id: LEAD_ID, subagents: { allowAgents: [WORKER_ID] } },
                { id: WORKER_ID, workspace: containerPath(LEAD_ID, "subagents", WORKER_ID) },
                { id: WORKER_ID_B, subagents: { allowAgents: [LEAD_ID] } },
              ],
            },
          });
          const statuses = Object.fromEntries(audit.map((entry) => [entry.agentId, entry.status]));

          expect(statuses).toEqual({
            [LEAD_ID]: "stale_allowlist",
            [WORKER_ID]: "ready",
          });
        },
      );
    });
  });
});

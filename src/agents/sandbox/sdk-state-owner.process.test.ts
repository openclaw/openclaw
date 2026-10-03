import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../../cli/cli-process-child.test-helpers.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { sdkStateOwnerFixtureEntrypoint } from "./sdk-state-owner-runtime.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
afterEach(() => vi.unstubAllEnvs());
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(sdkStateOwnerFixtureEntrypoint),
);

async function snapshot(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries.map(async (entry): Promise<[string, string] | undefined> => {
      const file = path.join(entry.parentPath, entry.name);
      const bytes = entry.isFile() ? await fs.readFile(file) : undefined;
      // Read-only SQLite opens can create an empty WAL and rebuild its shared-memory index.
      if (
        entry.name.endsWith(".sqlite-shm") ||
        (entry.name.endsWith(".sqlite-wal") && bytes?.length === 0)
      ) {
        return undefined;
      }
      return [
        path.relative(root, file),
        bytes ? createHash("sha256").update(bytes).digest("hex") : "dir",
      ];
    }),
  ).then((rows) =>
    rows
      .filter((row) => row !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

type Outcome = {
  api: string;
  result?: {
    enabled?: boolean;
    sandboxed?: boolean;
    backendId?: string;
    workspaceAccess?: string;
  } | null;
  error?: { code: string; message: string };
};
type Reply = {
  phase: string;
  data: {
    outcomes: Outcome[];
    callerSql: number;
    backendCalls: number;
    entries?: Array<{ containerName: string }>;
  };
};

describe("plugin SDK sandbox process ownership", () => {
  it("refuses foreign live-owner mutations while preserving disabled and standalone SDK calls", async () => {
    const root = roots.make("openclaw-sdk-state-owner-");
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    let parentOwner = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(parentOwner).not.toBeNull();
    const replies = new Map<string, ReturnType<typeof createDeferred<Reply>>>();
    const waitFor = (phase: string) => {
      const pending = replies.get(phase) ?? createDeferred<Reply>();
      replies.set(phase, pending);
      return pending.promise;
    };
    let consumed = 0;
    try {
      // A live Gateway has admitted both stores before exposing plugin capabilities.
      // Missing schemas would test unrelated cold-start refusal instead of the SDK gate.
      const databases = parentOwner!.run(() => ({
        state: openOpenClawStateDatabase({ env }).path,
        agent: openOpenClawAgentDatabase({ env, agentId: "main" }).path,
      }));
      await closeOpenClawAgentDatabaseByPathAsync(databases.agent, "main");
      await closeOpenClawStateDatabaseByPathAsync(databases.state);
      const result = await runCliProcessChild({
        nodeArgs: entrypoint,
        env,
        onStdout(stdout) {
          const lines = stdout.split("\n");
          while (consumed < lines.length - 1) {
            const line = lines[consumed++]!;
            if (!line.startsWith("sdk-owner-proof:")) {
              continue;
            }
            const reply: Reply = JSON.parse(line.slice("sdk-owner-proof:".length));
            void waitFor(reply.phase);
            replies.get(reply.phase)!.resolve(reply);
          }
        },
        async interact(child) {
          const exited = once(child, "exit");
          const receive = (phase: string) =>
            awaitGateBeforeSettlement(waitFor(phase), exited, `SDK fixture exited before ${phase}`);
          const request = (phase: string) => {
            replies.delete(phase);
            child.stdin.write(`${phase}\n`);
            return receive(phase);
          };
          await receive("ready");
          const expectNoMutation = async (phase: string, refused: boolean, worker = false) => {
            const before = await snapshot(root);
            const { data } = await request(phase);
            const diagnostic = JSON.stringify(data);
            expect(data.backendCalls, diagnostic).toBe(0);
            expect(data.outcomes).toHaveLength(2);
            if (refused) {
              for (const outcome of data.outcomes) {
                expect(outcome.error, diagnostic).toMatchObject({
                  code: "GATEWAY_STATE_OWNER_REQUIRED",
                });
                expect(outcome.error?.message).toMatch(/Gateway|embedded/);
              }
            } else {
              expect(data.outcomes, diagnostic).toEqual([
                { api: "resolveSandboxContext", result: null },
                {
                  api: "prepareWorkspaceAuthority",
                  result: { sandboxed: false, workspaceAccess: worker ? "none" : "rw" },
                },
              ]);
            }
            expect(await snapshot(root)).toEqual(before);
          };
          const expectProvisioned = async (phase: string) => {
            const { data } = await request(phase);
            expect(data.outcomes, JSON.stringify(data)).toEqual([
              {
                api: "resolveSandboxContext",
                result: expect.objectContaining({ enabled: true, backendId: "docker" }),
              },
              {
                api: "prepareWorkspaceAuthority",
                result: { sandboxed: true, workspaceAccess: "rw" },
              },
            ]);
            expect(data.backendCalls).toBe(2);
            for (const api of ["resolveSandboxContext", "prepareWorkspaceAuthority"]) {
              expect(data.entries).toContainEqual(
                expect.objectContaining({
                  containerName: `synthetic-agent:main:subagent:${phase}-${api}`,
                }),
              );
              expect(
                (await fs.stat(path.join(root, "workspace", `${phase}-${api}`))).isDirectory(),
              ).toBe(true);
            }
          };
          for (const role of ["gateway", "agent-embedded"] as const) {
            if (role === "agent-embedded") {
              parentOwner = await acquireGatewayLock({
                env,
                role,
                allowInTests: true,
                timeoutMs: 0,
              });
              expect(parentOwner).not.toBeNull();
            }
            await expectNoMutation(`foreign-${role}-on`, true);
            await expectNoMutation(`foreign-${role}-off`, false);
            await parentOwner?.release();
            parentOwner = null;
          }
          await expectNoMutation("offline-off", false);
          await expectNoMutation("worker-off", false, true);
          await expectProvisioned("offline-on");
          for (const role of ["gateway", "agent-embedded"] as const) {
            await expectProvisioned(role);
            // Ownership outlives both SDK calls and blocks a second process until explicit close.
            await expect(
              acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 }),
            ).rejects.toThrow();
            await request("release");
          }
          const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
          expect(successor).not.toBeNull();
          await successor?.release();
          child.stdin.end();
        },
      });
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await closeOpenClawAgentDatabasesAsync(root);
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      await parentOwner?.release();
    }
  });
});

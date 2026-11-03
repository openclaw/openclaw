import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../../cli/cli-process-child.test-helpers.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
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
import type { SdkStateOwnerReply } from "./sdk-state-owner.child.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
afterEach(() => vi.unstubAllEnvs());
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(sdkStateOwnerFixtureEntrypoint),
);

async function snapshot(root: string) {
  const rows: [string, string][] = [];
  for (const entry of (await listDirectoryTreeStrict(root)).map((walkEntry) => walkEntry.dirent)) {
    const file = path.join(entry.parentPath, entry.name);
    const bytes = entry.isFile() ? await fs.readFile(file) : undefined;
    // Read-only SQLite opens may rebuild SHM or create an empty WAL.
    if (
      entry.name.endsWith(".sqlite-shm") ||
      (entry.name.endsWith(".sqlite-wal") && bytes?.length === 0)
    ) {
      continue;
    }
    rows.push([
      path.relative(root, file),
      bytes ? createHash("sha256").update(bytes).digest("hex") : "dir",
    ]);
  }
  return rows.toSorted(([left], [right]) => left.localeCompare(right));
}

function expectedOutcomes(sandboxed: boolean, workspaceAccess = "rw") {
  return [
    {
      api: "resolveSandboxContext",
      result: sandboxed ? expect.objectContaining({ enabled: true, backendId: "docker" }) : null,
    },
    { api: "prepareWorkspaceAuthority", result: { sandboxed, workspaceAccess } },
  ];
}

it("SDK refuses foreign live-owner mutations while preserving disabled and standalone calls", async () => {
  const root = roots.make("openclaw-sdk-state-owner-");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0");
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_TEST_LOG_FILE: path.join(
      roots.make("openclaw-sdk-state-owner-logs-"),
      "sdk-owner.log",
    ),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  const acquire = (role: "gateway" | "agent-embedded" = "gateway") =>
    acquireGatewayLock({ env, role, allowInTests: true, timeoutMs: 0 });
  let parentOwner = await acquire();
  expect(parentOwner).not.toBeNull();
  const replies = new Map<string, ReturnType<typeof createDeferred<SdkStateOwnerReply>>>();
  const waitFor = (phase: string) => {
    const pending = replies.get(phase) ?? createDeferred<SdkStateOwnerReply>();
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
          const reply: SdkStateOwnerReply = JSON.parse(line.slice("sdk-owner-proof:".length));
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
        const check = async (
          phase: string,
          mode: "refused" | "disabled" | "provisioned",
          access = "rw",
        ) => {
          const provisioned = mode === "provisioned";
          const before = provisioned ? undefined : await snapshot(root);
          const { data } = await request(phase);
          const diagnostic = JSON.stringify(data);
          expect(data.backendCalls, diagnostic).toBe(provisioned ? 2 : 0);
          expect(data.outcomes).toHaveLength(2);
          if (mode === "refused") {
            for (const outcome of data.outcomes) {
              expect(outcome.error, diagnostic).toMatchObject({
                code: "GATEWAY_STATE_OWNER_REQUIRED",
                message: expect.stringMatching(/Gateway|embedded/),
              });
            }
          } else {
            expect(data.outcomes, diagnostic).toEqual(expectedOutcomes(provisioned, access));
          }
          if (!provisioned) {
            expect(await snapshot(root)).toEqual(before);
            return;
          }
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
            parentOwner = await acquire(role);
            expect(parentOwner).not.toBeNull();
          }
          await check(`foreign-${role}-on`, "refused");
          await check(`foreign-${role}-off`, "disabled");
          await parentOwner?.release();
          parentOwner = null;
        }
        await check("offline-off", "disabled");
        await check("worker-off", "disabled", "none");
        await check("offline-on", "provisioned");
        for (const role of ["gateway", "agent-embedded"] as const) {
          await check(role, "provisioned");
          // Ownership outlives both SDK calls and blocks a second process until explicit close.
          await expect(acquire()).rejects.toThrow();
          await request("release");
        }
        const successor = await acquire();
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

import { fileURLToPath } from "node:url";
import type { AcpProcessStarted } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const script = fileURLToPath(new URL("../test/fixtures/silent-agent.mjs", import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.each([{ ignoreTerm: false }, { ignoreTerm: true }])(
  "stops a peer that never answers initialize and fails the spawn (ignoreTerm=$ignoreTerm)",
  async ({ ignoreTerm }) => {
    await withOpenClawTestState({ label: "acpx-startup-deadline" }, async (state) => {
      const spawned: AcpProcessStarted[] = [];
      const runtime = new AcpxRuntime(
        {
          cwd: state.root,
          sessionStore: createFileSessionStore({ stateDir: state.root }),
          agentRegistry: createAgentRegistry({
            overrides: {
              silent: [process.execPath, script, ...(ignoreTerm ? ["--ignore-term"] : [])],
            },
          }),
          permissionMode: "deny-all",
          timeoutMs: 400,
          processLifecycle: { onSpawned: (started) => void spawned.push(started) },
        },
        { openclawStartupDeadline: { killGraceMs: 300 } },
      );
      try {
        // Each retry must fail on its own deadline and leave nothing behind.
        for (const attempt of [1, 2]) {
          const startedAt = Date.now();
          await expect(
            runtime.ensureSession({
              sessionKey: `agent:main:acp:silent-${attempt}`,
              agent: "silent",
              mode: "oneshot",
            }),
          ).rejects.toMatchObject({
            code: "ACP_SESSION_INIT_FAILED",
            detailCode: "ACP_HANDSHAKE_TIMEOUT",
            message: expect.stringContaining('ACP agent "silent"'),
          });
          expect(Date.now() - startedAt).toBeLessThan(5_000);
          expect(spawned).toHaveLength(attempt);
        }
        await expect.poll(() => spawned.filter(({ pid }) => isAlive(pid))).toEqual([]);
      } finally {
        for (const { pid } of spawned) {
          if (isAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        await runtime.shutdown();
      }
    });
  },
);

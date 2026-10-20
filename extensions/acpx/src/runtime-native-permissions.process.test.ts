import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { fixtureSession, type RuntimeHandle } from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";

const peer = fileURLToPath(
  new URL("../../../test/fixtures/acp/approval-effect-agent.mjs", import.meta.url),
);

it("isolates native delegated writes from classic ACP policy without retaining turn approval", async () => {
  await withOpenClawTestState({ label: "acpx-native-permissions" }, async (state) => {
    const directory = state.path("peer");
    const nativeCwd = state.path("native");
    const classicCwd = state.path("classic");
    await Promise.all([directory, nativeCwd, classicCwd].map((dir) => fs.mkdir(dir)));
    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: createFileSessionStore({ stateDir: state.root }),
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer, directory] },
      }),
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
      onPermissionRequest: async () => ({ outcome: "allow_once" }),
      timeoutMs: 5_000,
    });
    const nativeTarget = {
      ...fixtureSession("native"),
      agentId: "main",
      cwd: nativeCwd,
      bridgeSession: { agentId: "main", sessionKey: "native-chat", native: true },
    };
    const approve = async () => ({ outcome: "allow_once" as const });
    const prompt = async (handle: RuntimeHandle, requestId: string, approved = false) => {
      const turn = runtime.startTurn({
        handle,
        text: requestId,
        mode: "prompt",
        requestId,
        ...(approved ? { onPermissionRequest: approve } : {}),
      });
      for await (const event of turn.events) {
        void event;
      }
      return (await turn.result).status;
    };
    const effectPath = (cwd: string) => path.join(cwd, "native-effect.txt");
    const expectEffect = async () =>
      expect(await fs.readFile(effectPath(nativeCwd), "utf8")).toBe("approved native effect");
    const expectNoEffect = async (cwd: string) =>
      expect(fs.readFile(effectPath(cwd))).rejects.toMatchObject({ code: "ENOENT" });
    try {
      let native = await runtime.ensureSession(nativeTarget);
      const classic = await runtime.ensureSession({
        ...fixtureSession("classic"),
        agentId: "main",
        cwd: classicCwd,
      });
      const [nativeResult, classicResult] = await Promise.all([
        prompt(native, "native-allowed", true),
        prompt(classic, "classic-allowed"),
      ]);
      expect(nativeResult).toBe("completed");
      await expectEffect();
      expect(classicResult).toBe("failed");
      await expectNoEffect(classicCwd);

      await expect(
        runtime.ensureSession({ ...nativeTarget, bridgeSession: undefined }),
      ).rejects.toThrow("tool ownership changed");

      for (const transition of ["retained", "reconnected", "reset"]) {
        if (transition === "reconnected") {
          await runtime.close({ handle: native, reason: "reconnect native client" });
          native = await runtime.ensureSession(nativeTarget);
        } else if (transition === "reset") {
          await runtime.prepareFreshSession({ handle: native });
          native = await runtime.ensureSession(nativeTarget);
        }
        await fs.unlink(effectPath(nativeCwd));
        await expect(prompt(native, `native-unowned-${transition}`)).resolves.toBe("completed");
        await expectNoEffect(nativeCwd);
        await expect(prompt(native, `native-reapproved-${transition}`, true)).resolves.toBe(
          "completed",
        );
        await expectEffect();
      }
    } finally {
      await runtime.shutdown();
    }
  });
});

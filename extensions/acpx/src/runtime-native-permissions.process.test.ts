import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  fixtureSession,
  runPrompt,
  withProcessRuntime,
  type RuntimeHandle,
} from "./runtime-process.test-support.js";

const peer = fileURLToPath(
  new URL("../../../test/fixtures/acp/approval-effect-agent.mjs", import.meta.url),
);
const approve = async () => ({ outcome: "allow_once" as const });

it("isolates native delegated writes from classic ACP policy without retaining turn approval", () =>
  withProcessRuntime(
    "acpx-native-permissions",
    async ({ state, runtime }) => {
      const nativeCwd = state.path("native");
      const classicCwd = state.path("classic");
      await Promise.all([nativeCwd, classicCwd].map((dir) => fs.mkdir(dir)));
      const nativeTarget = {
        ...fixtureSession("native"),
        agentId: "main",
        cwd: nativeCwd,
        bridgeSession: { agentId: "main", sessionKey: "native-chat", native: true },
      };
      const prompt = async (handle: RuntimeHandle, requestId: string, approved = false) => {
        const turn = await runPrompt(runtime, {
          handle,
          text: requestId,
          mode: "prompt",
          requestId,
          ...(approved ? { onPermissionRequest: approve } : {}),
        });
        return turn.result.status;
      };
      const effectPath = (cwd: string) => path.join(cwd, "native-effect.txt");
      const expectEffect = async () =>
        expect(await fs.readFile(effectPath(nativeCwd), "utf8")).toBe("approved native effect");
      const expectNoEffect = async (cwd: string) =>
        expect(fs.readFile(effectPath(cwd))).rejects.toMatchObject({ code: "ENOENT" });
      let native = await runtime.ensureSession(nativeTarget);
      const classic = await runtime.ensureSession({
        ...fixtureSession("classic"),
        agentId: "main",
        cwd: classicCwd,
      });
      const results = await Promise.all([
        prompt(native, "native-allowed", true),
        prompt(classic, "classic-allowed"),
      ]);
      expect(results).toEqual(["completed", "failed"]);
      await expectEffect();
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
    },
    {
      script: peer,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
      onPermissionRequest: approve,
    },
  ));

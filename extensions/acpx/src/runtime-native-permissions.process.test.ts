import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
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
      sessionKey: "native",
      agentId: "main",
      agent: "fixture",
      mode: "persistent" as const,
      cwd: nativeCwd,
      bridgeSession: { agentId: "main", sessionKey: "native-chat", native: true },
    };
    const prompt = async (input: Parameters<AcpxRuntime["startTurn"]>[0]) => {
      const turn = runtime.startTurn(input);
      for await (const event of turn.events) {
        void event;
      }
      return await turn.result;
    };
    try {
      let native = await runtime.ensureSession(nativeTarget);
      const classic = await runtime.ensureSession({
        sessionKey: "classic",
        agentId: "main",
        agent: "fixture",
        mode: "persistent",
        cwd: classicCwd,
      });
      const [nativeResult, classicResult] = await Promise.all([
        prompt({
          handle: native,
          text: "Write the approved native effect.",
          mode: "prompt",
          requestId: "native-allowed",
          onPermissionRequest: async () => ({ outcome: "allow_once" }),
        }),
        prompt({
          handle: classic,
          text: "Write the approved native effect.",
          mode: "prompt",
          requestId: "classic-allowed",
        }),
      ]);
      expect(nativeResult).toMatchObject({ status: "completed" });
      expect(await fs.readFile(path.join(nativeCwd, "native-effect.txt"), "utf8")).toBe(
        "approved native effect",
      );
      expect(classicResult).toMatchObject({ status: "failed" });
      await expect(fs.readFile(path.join(classicCwd, "native-effect.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await runtime.prepareFreshSession({ handle: native });
      native = await runtime.ensureSession(nativeTarget);
      await fs.unlink(path.join(nativeCwd, "native-effect.txt"));
      const unowned = await prompt({
        handle: native,
        text: "Write again without a live native approval owner.",
        mode: "prompt",
        requestId: "native-unowned",
      });
      expect(unowned).toMatchObject({ status: "completed" });
      await expect(fs.readFile(path.join(nativeCwd, "native-effect.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const approved = await prompt({
        handle: native,
        text: "Write with a new live native approval.",
        mode: "prompt",
        requestId: "native-reapproved",
        onPermissionRequest: async () => ({ outcome: "allow_once" }),
      });
      expect(approved).toMatchObject({ status: "completed" });
      expect(await fs.readFile(path.join(nativeCwd, "native-effect.txt"), "utf8")).toBe(
        "approved native effect",
      );
    } finally {
      await runtime.shutdown();
    }
  });
});

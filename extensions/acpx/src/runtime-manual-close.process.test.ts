import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime } from "./runtime.js";

const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));

async function prompt(
  runtime: AcpxRuntime,
  handle: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>,
  text: string,
) {
  const chunks: string[] = [];
  for await (const event of runtime.runTurn({
    handle,
    text,
    requestId: text,
    mode: "prompt",
  })) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    }
  }
  return JSON.parse(chunks.join("")) as { sessionId: string; history: string[] };
}

it("starts a new ACP session after manual close and still resumes an unrelated session", async () => {
  await withOpenClawTestState({ label: "acpx-manual-close-fresh" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const store = createFileSessionStore({ stateDir: state.root });
    const options = {
      cwd: state.root,
      sessionStore: store,
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer, directory] },
      }),
      permissionMode: "deny-all" as const,
      timeoutMs: 5_000,
    };
    const closedTarget = { sessionKey: "agent:main:acp:closed", agentId: "main" };
    const keptTarget = { sessionKey: "agent:main:acp:kept", agentId: "main" };
    const first = new AcpxRuntime(options);
    let restarted: AcpxRuntime | undefined;
    try {
      const closed = await first.ensureSession({
        ...closedTarget,
        agent: "fixture",
        mode: "persistent",
      });
      const kept = await first.ensureSession({
        ...keptTarget,
        agent: "fixture",
        mode: "persistent",
      });
      expect((await prompt(first, closed, "before")).history).toEqual(["before"]);
      expect((await prompt(first, kept, "kept-before")).history).toEqual(["kept-before"]);
      await first.close({
        handle: closed,
        reason: "manual-close",
        discardPersistentState: true,
      });
      await expect(store.load(closed.acpxRecordId!)).resolves.toMatchObject({
        acpSessionId: closed.backendSessionId,
        acpx: { reset_on_next_ensure: true },
      });
      await expect(store.load(kept.acpxRecordId!)).resolves.toMatchObject({
        acpSessionId: kept.backendSessionId,
        closed: false,
      });
      expect((await store.load(kept.acpxRecordId!))?.acpx?.reset_on_next_ensure).not.toBe(true);
      await first.shutdown();

      restarted = new AcpxRuntime(options);
      const reopened = await restarted.ensureSession({
        ...closedTarget,
        agent: "fixture",
        mode: "persistent",
      });
      expect(reopened.backendSessionId).not.toBe(closed.backendSessionId);
      expect((await prompt(restarted, reopened, "after")).history).toEqual(["after"]);
      const keptAgain = await restarted.ensureSession({
        ...keptTarget,
        agent: "fixture",
        mode: "persistent",
      });
      expect(keptAgain.backendSessionId).toBe(kept.backendSessionId);
      expect((await prompt(restarted, keptAgain, "kept-after")).history).toEqual([
        "kept-before",
        "kept-after",
      ]);
    } finally {
      await Promise.allSettled([first.shutdown(), restarted?.shutdown()]);
    }
  });
});

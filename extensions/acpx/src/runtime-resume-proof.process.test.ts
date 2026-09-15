import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAcpSessionManager,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  testing,
  readAcpSessionEntry,
} from "openclaw/plugin-sdk/acp-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

it("persistent ACP subprocess resume preserves identity through failure, retry and explicit reset", async () => {
  await withOpenClawTestState({ label: "acp-resume-proof" }, async (state) => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {} } },
      acp: { backend: "acpx" },
    };
    await state.writeConfig(cfg);
    const peerDirectory = path.join(state.root, "peer");
    await fs.mkdir(peerDirectory);
    const marker = path.join(peerDirectory, "resume-error");
    const store = createFileSessionStore({ stateDir: path.join(state.root, "acpx") });
    const cwd = state.workspaceDir;
    const script = fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url));
    const createRuntime = () =>
      new AcpxRuntime({
        cwd,
        sessionStore: store,
        agentRegistry: createAgentRegistry({
          overrides: { "resume-proof": [process.execPath, script, peerDirectory] },
        }),
        permissionMode: "deny-all",
        timeoutMs: 5_000,
      });
    let runtime = createRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime });
    testing.resetAcpSessionManagerForTests();
    let manager = getAcpSessionManager();
    const sessionKey = "agent:main:acp:isolated-resume-proof";
    const target = { cfg, sessionKey, agentId: "main" };
    const removeRuntimeRecord = async (recordId: string) => {
      // Model a lost local runtime cache with the durable OpenClaw identity intact.
      await fs.unlink(
        path.join(state.root, "acpx", "sessions", `${encodeURIComponent(recordId)}.json`),
      );
    };
    const turn = async (text: string) => {
      const requestId = crypto.randomUUID();
      const admission = await createAdmittedHostCapabilityTestFixture({
        config: cfg,
        runId: requestId,
        agentId: "main",
        sessionId: "proof",
        sessionKey,
        workspaceDir: state.workspaceDir,
        abortSignal: new AbortController().signal,
      });
      const chunks: string[] = [];
      try {
        await manager.runTurn({
          ...target,
          admittedRunContext: admission.admittedRunContext,
          provenance: "human",
          text,
          mode: "prompt",
          requestId,
          onEvent(e) {
            if (e.type === "text_delta") {
              chunks.push(e.text);
            }
          },
        });
      } finally {
        admission.closeHost();
        admission.closeAdmission();
      }
      return chunks.join("");
    };
    const peerState = async (id: string) =>
      JSON.parse(await fs.readFile(path.join(peerDirectory, `${id}.json`), "utf8"));
    const peerFiles = async () =>
      (await fs.readdir(peerDirectory)).filter((name) => name.endsWith(".json"));
    try {
      const { handle } = await manager.initializeSession({
        ...target,
        agent: "resume-proof",
        mode: "persistent",
        cwd,
      });
      const nonce = "orchid-lantern-7492";
      expect(JSON.parse(await turn(nonce)).history).toEqual([nonce]);
      const original = readAcpSessionEntry(target)!.acp!.identity;
      expect(original?.acpxSessionId).toBeTruthy();
      await manager.closeSession({ ...target, reason: "proof-reconnect" });
      runtime = createRuntime();
      registerAcpRuntimeBackend({ id: "acpx", runtime });
      testing.resetAcpSessionManagerForTests();
      manager = getAcpSessionManager();
      await removeRuntimeRecord(handle.acpxRecordId!);
      await fs.writeFile(marker, "temporary initialization failure");
      const before = await peerState(original!.acpxSessionId!);
      await expect(turn("Reply with the nonce from earlier. No tools.")).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
      });
      expect(readAcpSessionEntry(target)!.acp!.identity).toEqual(original);
      expect(await store.load(handle.acpxRecordId!)).toBeUndefined();
      expect(await peerState(original!.acpxSessionId!)).toEqual(before);
      expect(await peerFiles()).toHaveLength(1);

      await fs.unlink(marker);
      expect(JSON.parse(await turn("continue")).history).toEqual([nonce, "continue"]);
      expect(readAcpSessionEntry(target)!.acp!.identity?.acpxSessionId).toBe(
        original!.acpxSessionId,
      );
      // A genuinely unavailable persisted target must remain an error until explicit reset.
      await manager.closeSession({ ...target, reason: "proof-missing-target" });
      runtime = createRuntime();
      registerAcpRuntimeBackend({ id: "acpx", runtime });
      testing.resetAcpSessionManagerForTests();
      manager = getAcpSessionManager();
      await removeRuntimeRecord(handle.acpxRecordId!);
      await fs.unlink(path.join(peerDirectory, `${original!.acpxSessionId}.json`));
      await expect(turn("missing target")).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
      });
      expect(readAcpSessionEntry(target)!.acp!.identity?.acpxSessionId).toBe(
        original!.acpxSessionId,
      );
      expect(await peerFiles()).toHaveLength(0);
      await manager.closeSession({
        ...target,
        reason: "reset",
        discardPersistentState: true,
        allowBackendUnavailable: true,
        clearMeta: true,
      });
      const { handle: fresh } = await manager.initializeSession({
        ...target,
        agent: "resume-proof",
        mode: "persistent",
        cwd,
      });
      expect(fresh.backendSessionId).not.toBe(original!.acpxSessionId);
      expect(JSON.parse(await turn("fresh")).history).toEqual(["fresh"]);
    } finally {
      await manager
        .closeSession({ ...target, reason: "proof-cleanup", requireAcpSession: false })
        .catch(() => {});
      testing.resetAcpSessionManagerForTests();
      unregisterAcpRuntimeBackend("acpx");
    }
  });
}, 30_000);

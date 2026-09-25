import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
} from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime } from "./runtime.js";

const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));
type Handle = Awaited<ReturnType<AcpxRuntime["ensureSession"]>>;

async function prompt(runtime: AcpxRuntime, handle: Handle, text: string) {
  const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId: text });
  let output = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      output += event.text;
    }
  }
  expect(await turn.result).toMatchObject({ status: "completed" });
  return JSON.parse(output);
}

it("resumes completed oneshots with the same history, cwd, and MCP owner across restarts", async () => {
  await withOpenClawTestState({ label: "acpx-completed-resume" }, async (state) => {
    const directory = path.join(state.root, "peer");
    const cwd = path.join(state.root, "project");
    await fs.mkdir(directory);
    await fs.mkdir(cwd);
    const store = createFileSessionStore({ stateDir: state.root });
    const server = { name: "openclaw-tools", command: process.execPath, args: [], env: [] };
    const createRuntime = () =>
      new AcpxRuntime({
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({
          overrides: { fixture: [process.execPath, peer, directory] },
        }),
        permissionMode: "deny-all",
        openclawToolsMcpBridgeEnabled: true,
        mcpServers: [server],
        timeoutMs: 5000,
      });
    let runtime = createRuntime();
    const handles: Handle[] = [];
    try {
      for (const agentId of ["main", "work"]) {
        const handle = await runtime.ensureSession({
          sessionKey: "shared-build",
          agentId,
          agent: "fixture",
          cwd,
          mode: "oneshot",
        });
        handles.push(handle);
        expect(handle.sessionResumeSupported).toBe(true);
        expect(await prompt(runtime, handle, `${agentId}-first`)).toMatchObject({
          history: [`${agentId}-first`],
          cwd,
        });
        await runtime.close({ handle, reason: "completed" });
      }
      expect(handles[0]!.backendSessionId).not.toBe(handles[1]!.backendSessionId);
      for (const suffix of ["second", "third"]) {
        await runtime.shutdown();
        runtime = createRuntime();
        for (const previous of handles) {
          const handle = await runtime.ensureSession({
            sessionKey: previous.sessionKey,
            agentId: previous.agentId,
            agent: "fixture",
            cwd,
            mode: "oneshot",
            resumeSessionId: previous.backendSessionId,
          });
          expect(handle.backendSessionId).toBe(previous.backendSessionId);
          expect(handle.sessionKey).toBe(previous.sessionKey);
          expect(handle.agentId).toBe(previous.agentId);
          expect(decodeAcpxRuntimeHandleState(handle.runtimeSessionName)?.mode).toBe("persistent");
          const result = await prompt(runtime, handle, `${previous.agentId}-${suffix}`);
          expect(result).toMatchObject({
            sessionId: previous.backendSessionId,
            history: (suffix === "second" ? ["first", "second"] : ["first", "second", "third"]).map(
              (part) => `${previous.agentId}-${part}`,
            ),
            cwd,
            loadedCwd: cwd,
            loadedMcpServers: [
              {
                ...server,
                args: ["--openclaw-agent-id", previous.agentId],
                env: [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: previous.sessionKey }],
              },
            ],
          });
          await runtime.close({ handle, reason: "completed" });
        }
      }
      expect(await fs.readdir(directory)).toHaveLength(2);
    } finally {
      await runtime.shutdown();
    }
  });
});

it.each(["ensure", "reconnect"])(
  "never creates fresh context when the resume target is lost at %s",
  async (phase) => {
    await withOpenClawTestState({ label: "acpx-missing-resume" }, async (state) => {
      const directory = path.join(state.root, "peer");
      await fs.mkdir(directory);
      const store = createFileSessionStore({ stateDir: state.root });
      const createRuntime = () =>
        new AcpxRuntime({
          cwd: state.root,
          sessionStore: store,
          agentRegistry: createAgentRegistry({
            overrides: { fixture: [process.execPath, peer, directory] },
          }),
          permissionMode: "deny-all",
          timeoutMs: 5000,
        });
      let runtime = createRuntime();
      const input = {
        sessionKey: "missing-build",
        agentId: "main",
        agent: "fixture",
        mode: "oneshot" as const,
      };
      try {
        const first = await runtime.ensureSession(input);
        await prompt(runtime, first, "original context");
        await runtime.close({ handle: first, reason: "completed" });
        const resume = { ...input, resumeSessionId: first.backendSessionId };
        const handle = phase === "reconnect" ? await runtime.ensureSession(resume) : undefined;
        await runtime.shutdown();
        runtime = createRuntime();
        await fs.unlink(path.join(directory, `${first.backendSessionId}.json`));
        if (handle) {
          const turn = runtime.startTurn({
            handle,
            text: "follow-up",
            mode: "prompt",
            requestId: "follow-up",
          });
          for await (const event of turn.events) {
            expect(event.type).not.toBe("text_delta");
          }
          expect(await turn.result).toMatchObject({ status: "failed" });
        } else {
          await expect(runtime.ensureSession(resume)).rejects.toThrow();
        }
        expect(await fs.readdir(directory)).toEqual([]);
      } finally {
        await runtime.shutdown();
      }
    });
  },
);

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const peer = fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url));

it.each([
  "session",
  "bridge",
  "openclaw-direct",
  ...(process.platform === "win32" ? [] : ["env-bridge"]),
])("scopes MCP at the real ACP boundary across reconnect (%s)", async (scenario) => {
  const bridge = scenario === "bridge" || scenario === "env-bridge";
  const agent = scenario === "openclaw-direct" ? "openclaw" : "fixture";
  await withOpenClawTestState({ label: "acpx-mcp-process" }, async (state) => {
    const directory = path.join(state.root, "peer");
    await fs.mkdir(directory);
    const wrapper = path.join(state.root, "openclaw.mjs");
    await fs.writeFile(
      wrapper,
      `process.argv.splice(2, 1); await import(${JSON.stringify(new URL("../test/fixtures/owner-agent.mjs", import.meta.url).href)});`,
    );
    const directCommand = [process.execPath, peer, directory];
    const bridgeCommand = [process.execPath, wrapper, "acp", directory];
    const command =
      scenario === "env-bridge"
        ? ["env", "OPENCLAW_HIDE_BANNER=1", ...bridgeCommand]
        : bridge
          ? bridgeCommand
          : directCommand;
    const servers = ["openclaw-plugin-tools", "openclaw-tools", "user-server"].map((name) => ({
      name,
      command: process.execPath,
      args: ["server.mjs"],
      env: [],
    }));
    const store = createFileSessionStore({ stateDir: state.root });
    const createRuntime = (configuredCommand = command) =>
      new AcpxRuntime({
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({ overrides: { [agent]: configuredCommand } }),
        pluginToolsMcpBridgeEnabled: true,
        openclawToolsMcpBridgeEnabled: true,
        mcpServers: servers,
        permissionMode: "deny-all",
        timeoutMs: 5000,
      });
    let runtime = createRuntime();
    const handles: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>[] = [];
    try {
      for (const agentId of ["main", "work"]) {
        const handle = await runtime.ensureSession({
          sessionKey: "shared",
          agentId,
          agent,
          mode: "persistent",
        });
        handles.push(handle);
      }
      const prompt = async (handle: (typeof handles)[number]) => {
        const turn = runtime.startTurn({
          handle,
          text: "show context",
          mode: "prompt",
          requestId: handle.agentId!,
        });
        let text = "";
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            text += event.text;
          }
        }
        expect(await turn.result).toMatchObject({ status: "completed" });
        return JSON.parse(text);
      };
      const verify = async (reconnected = false) => {
        const results = await Promise.all(handles.map(prompt));
        for (const [index, result] of results.entries()) {
          expect(reconnected ? result.loadedMcpServers : result.mcpServers).toEqual(
            bridge
              ? []
              : servers.map((server) =>
                  server.name === "user-server"
                    ? server
                    : Object.assign({}, server, {
                        args: [...server.args, "--openclaw-agent-id", handles[index]!.agentId],
                        env: [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: "shared" }],
                      }),
                ),
          );
        }
      };
      await verify();
      for (const handle of handles) {
        await runtime.close({ handle, reason: "restart" });
      }
      runtime = createRuntime(bridge ? directCommand : bridgeCommand);
      for (const handle of handles) {
        await runtime.setMode({ handle, mode: "review" });
        await runtime.setConfigOption({ handle, key: "tone", value: "brief" });
      }
      await verify(true);
    } finally {
      for (const handle of handles) {
        await runtime.close({ handle, reason: "test-complete", discardPersistentState: true });
      }
    }
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import {
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createParams,
  setupDynamicToolBuildFixture,
} from "./dynamic-tool-build.test-support.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";
import { buildCodexRuntimeThreadConfig } from "./thread-requests.js";

let root: string;
const closers: Array<() => void> = [];
beforeEach(async () => {
  root = await setupDynamicToolBuildFixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("GH_TOKEN", "synthetic-native-token");
  vi.stubEnv("GITHUB_TOKEN", "synthetic-native-fallback");
});
afterEach(async () => {
  resetGlobalHookRunner();
  await cleanupDynamicToolBuildFixture(root, closers);
});

async function fixture(
  options: { mode?: "full" | "deny"; assertCurrent?: () => void; mutateSelection?: boolean } = {},
) {
  const params = createParams(path.join(root, "session.jsonl"), root);
  params.agentId = "main";
  params.disableTools = false;
  params.config = {
    tools: {
      exec: { host: "gateway", mode: options.mode ?? "full" },
      github: { profileId: "ghp_11111111111111111111111111111111" },
    },
  };
  const { hostCapabilities: _unused, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt,
    pluginId: "codex",
    ...(options.assertCurrent
      ? {
          operatorSource: {
            profileId: "original",
            scopes: ["operator.admin"],
            assertCurrent: options.assertCurrent,
          },
        }
      : {}),
  });
  params.hostCapabilities = host.capabilities;
  closers.push(host.close);
  const environment = host.capabilities.preparedEnvironment!();
  const profileDir = environment.localIdentityEnv.GH_CONFIG_DIR!;
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(profileDir, "hosts.yml"),
    "github.com:\n  oauth_token: synthetic-selected-token\n",
    { mode: 0o600 },
  );
  if (options.mutateSelection) {
    params.config.tools!.github!.profileId = "ghp_22222222222222222222222222222222";
  }
  const nativeExecutionPolicy = await prepareTestNativeExecutionPolicy(params);
  const native = shouldEnableCodexAppServerNativeToolSurface(params, undefined, {
    nativeExecutionPolicy,
  });
  const tools = await buildDynamicToolsForTest(params, root, {
    sandbox: null,
    nativeToolSurfaceEnabled: native,
    nativeExecutionPolicy,
  });
  const bridge = createCodexDynamicToolBridge({ tools, signal: new AbortController().signal });
  let sequence = 0;
  return {
    params,
    host,
    native,
    profileDir,
    tools,
    execute: (command: string) =>
      bridge.handleToolCall({
        threadId: "thread",
        turnId: "turn",
        callId: "call-" + ++sequence,
        tool: "exec",
        arguments: { command, yieldMs: 10000 },
      }),
  };
}

describe.skipIf(process.platform === "win32")("Codex host-owned credential execution", () => {
  it("executes with the selected identity and never falls back when its profile disappears", async () => {
    const f = await fixture({ mutateSelection: true });
    expect(f.native).toBe(false);
    expect(f.tools.find((tool) => tool.name === "exec")?.catalogMode).toBe("direct-only");
    const effect = path.join(root, "effect");
    const script = path.join(root, "write-effect.cjs");
    await fs.writeFile(
      script,
      'require("node:fs").writeFileSync(process.argv[2], process.env.GH_TOKEN === "synthetic-selected-token" ? "selected" : "wrong");',
    );
    const command = [process.execPath, script, effect]
      .map((value) => JSON.stringify(value))
      .join(" ");
    const response = await f.execute(command);
    expect(response, JSON.stringify(response.contentItems)).toMatchObject({ success: true });
    expect(await fs.readFile(effect, "utf8")).toBe("selected");
    await fs.rm(effect);
    await fs.rm(f.profileDir, { recursive: true });
    const failed = await f.execute(command);
    expect(JSON.stringify(failed)).toContain("Reconnect or change GitHub Identity");
    expect(await fs.stat(effect).catch(() => undefined)).toBeUndefined();
    await fs.mkdir(f.profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(f.profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: synthetic-selected-token\n",
      { mode: 0o600 },
    );
    expect(await f.execute(command)).toMatchObject({ success: true });
    expect(await fs.readFile(effect, "utf8")).toBe("selected");
  });

  it.each(["denied", "closed", "revoked", "reassigned"] as const)(
    "starts no child for a %s caller",
    async (state) => {
      let caller = "original";
      const f = await fixture({
        mode: state === "denied" ? "deny" : "full",
        assertCurrent: () => {
          if (caller !== "original") {
            throw new Error("source no longer current");
          }
        },
      });
      expect(f.native).toBe(false);
      const effect = path.join(root, "forbidden-effect");
      const script = path.join(root, "forbidden.cjs");
      await fs.writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], "unexpected")');
      if (state === "closed") {
        f.host.close();
      }
      if (state === "revoked") {
        caller = "revoked";
      }
      if (state === "reassigned") {
        caller = "replacement";
      }
      const result = await f.execute(
        [process.execPath, script, effect].map((value) => JSON.stringify(value)).join(" "),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.contentItems)).toContain(
        state === "denied" ? "denied" : "no longer active",
      );
      expect(await fs.stat(effect).catch(() => undefined)).toBeUndefined();
    },
  );

  it.each(["closed", "revoked"] as const)(
    "rechecks a %s caller after an awaited hook before launch",
    async (state) => {
      let current = true;
      const f = await fixture({
        assertCurrent: () => {
          if (!current) {
            throw new Error("source no longer current");
          }
        },
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_tool_call",
            handler: async () => {
              entered.resolve();
              await release.promise;
              return {};
            },
          },
        ]),
      );
      const effect = path.join(root, "after-hook-effect");
      const script = path.join(root, "after-hook.cjs");
      await fs.writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], "unexpected")');
      const pending = f.execute(
        [process.execPath, script, effect].map((value) => JSON.stringify(value)).join(" "),
      );
      await entered.promise;
      if (state === "closed") {
        f.host.close();
      } else {
        current = false;
      }
      release.resolve();
      expect((await pending).success).toBe(false);
      expect(await fs.stat(effect).catch(() => undefined)).toBeUndefined();
    },
  );

  it("retains the native surface by default and disables inherited shell features for host-owned execution", async () => {
    const params = createParams(path.join(root, "default.jsonl"), root);
    params.disableTools = false;
    const { hostCapabilities: _unused, ...attempt } = params;
    const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
    closers.push(host.close);
    params.hostCapabilities = host.capabilities;
    const nativeExecutionPolicy = await prepareTestNativeExecutionPolicy(params);
    expect(
      shouldEnableCodexAppServerNativeToolSurface(params, undefined, { nativeExecutionPolicy }),
    ).toBe(true);
    expect(
      buildCodexRuntimeThreadConfig(
        { "features.shell_tool": true, "features.unified_exec": true },
        { nativeCodeModeEnabled: false },
      ),
    ).toMatchObject({
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.shell_tool": false,
      "features.unified_exec": false,
    });
  });
});

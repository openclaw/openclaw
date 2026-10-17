import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { registerPluginOnlyCallerIdentityCase } from "./agent-tools.caller-identity.test-support.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createSandboxedReadTool, wrapReadToolWithSkillContent } from "./agent-tools.read.js";
import { runWithAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "./cron-creator-authority-context.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import type { ReadToolDetails } from "./sessions/tools/tool-contracts.js";
import {
  expectReadWriteEditTools,
  getTextContent as extractToolText,
} from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";
import {
  createContainerWorkspaceSandboxFsBridge,
  createHostSandboxFsBridge,
  createSandboxFsBridgeFromResolver,
} from "./test-helpers/host-sandbox-fs-bridge.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";

const tinyPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);
const avifHeaderBuffer = Buffer.from("00000018667479706176696600000000617669666d696631", "hex");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-completion-grant-");
const openClawOnlyPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: true,
  includePluginTools: false,
};
const pluginOnlyPlan = {
  ...openClawOnlyPlan,
  includeOpenClawTools: false,
  includePluginTools: true,
};
const baseOnlyPlan = {
  ...openClawOnlyPlan,
  includeOpenClawTools: false,
  includeBaseCodingTools: true,
};
const skillLocator = "/skills/pond/SKILL.md";
const skillContent = "# Pond\ncomplete instructions";
const fullSkillResult: AgentToolResult<ReadToolDetails> = {
  content: [{ type: "text", text: skillContent }],
  details: { kind: "text", content: skillContent },
};

function skillReadTool(execute: Parameters<typeof wrapReadToolWithSkillContent>[0]["execute"]) {
  return wrapReadToolWithSkillContent(
    {
      name: "read",
      label: "read",
      description: "read a file",
      parameters: Type.Object({ path: Type.String() }),
      execute,
    },
    [{ filePath: skillLocator }],
    { instructionDeliveryCache: new Map<string, Promise<boolean>>() },
  );
}

function sandboxReadTool(root: string) {
  return createSandboxedReadTool({ root, bridge: createHostSandboxFsBridge(root) });
}
const provenance = (workspaceDir: string, relativePath: string) =>
  expect(readMemoryArtifactProvenance({ workspaceDir, relativePath })).resolves;
const addPatch = (file: string, content: string) => ({
  input: `*** Begin Patch\n*** Add File: ${file}\n+${content}\n*** End Patch`,
});
async function fileFixture(relativePath: string, content: string | Uint8Array) {
  const root = tempDirs.make("openclaw-tool-file-");
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return { root, filePath };
}

async function sandboxReadFixture(file: string, content: string | Uint8Array) {
  const fixture = await fileFixture(file, content);
  return { ...fixture, read: sandboxReadTool(fixture.root) };
}

async function writeSessionStore(
  storeTemplate: string,
  agentId: string,
  entries: Record<string, unknown>,
) {
  const storePath = storeTemplate.replaceAll("{agentId}", agentId);
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ agentId, sessionKey, storePath }, entry as SessionEntry);
  }
}

function createToolsForStoredSession(storeTemplate: string, sessionKey: string) {
  return createOpenClawCodingTools({
    sessionKey,
    config: {
      session: { store: storeTemplate },
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
    },
  });
}

function sessionEntry(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: Date.now(), ...fields };
}

function sessionStoreTemplate() {
  return path.join(sessionDirs.make(), "{agentId}", "sessions.json");
}

function beforeToolHook() {
  const handler = vi.fn();
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
  return handler;
}

type CronResolver = Parameters<typeof runWithCronCreatorAuthorityCapabilityResolver>[0];
function cronTools(
  capability: CronResolver["capability"],
  runId: string,
  resolve: CronResolver["resolve"],
  toolRunId = runId,
) {
  return runWithCronCreatorAuthorityCapabilityResolver({
    capability,
    runId,
    resolve,
    run: () => createOpenClawCodingTools({ runId: toolRunId, senderIsOwner: false }),
  });
}

function expectNoSubagentControlTools(tools: ReturnType<typeof createOpenClawCodingTools>) {
  expectToolNames(tools, [], ["sessions_spawn", "sessions_list", "sessions_history", "subagents"]);
}

type OpenClawCodingTool = ReturnType<typeof createOpenClawCodingTools>[number];
type OpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

function toolNameList(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}
function expectToolSurface(
  options: Parameters<typeof createOpenClawCodingTools>[0],
  present: string[],
  absent: string[] = [],
) {
  expectToolNames(createOpenClawCodingTools(options), present, absent);
}
function expectToolNames(
  tools: readonly { name: string }[],
  present: string[],
  absent: string[] = [],
) {
  const names = toolNameList(tools);
  expect(names).toEqual(expect.arrayContaining(present));
  for (const name of absent) {
    expect(names).not.toContain(name);
  }
}

function requireTool(tools: OpenClawCodingTool[], name: string): OpenClawCodingTool {
  return expectDefined(
    tools.find((candidate) => candidate.name === name),
    `expected ${name} tool`,
  );
}

function lastCoreOptions(): OpenClawToolsOptions {
  return expectDefined(
    vi.mocked(createOpenClawTools).mock.lastCall?.[0],
    "createOpenClawTools options",
  );
}

describe("createOpenClawCodingTools", () => {
  it.each([
    ["multi-page node", "node", `${"ok\n".repeat(2_100)}done`, false],
    ["oversized local", "local", `# Pond\n${"x".repeat(33 * 1024)}`, true],
  ] as const)(
    "serves %s skill instructions whole or refuses them",
    async (_name, backend, content, oversized) => {
      const virtual = backend === "node";
      const baseDir = virtual
        ? "node://node-1/skills/pond"
        : tempDirs.make("openclaw-assembled-local-skill-");
      const locator = virtual ? `${baseDir}/SKILL.md` : path.join(baseDir, "SKILL.md");
      if (!virtual) {
        await fs.writeFile(locator, content, "utf8");
      }
      const tools = createOpenClawCodingTools({
        config: { tools: { fs: { workspaceOnly: true } } },
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "pond" }],
          resolvedSkills: [
            {
              name: "pond",
              description: "Pond skill",
              filePath: locator,
              baseDir,
              ...(virtual ? { readContent: content } : {}),
              source: virtual ? "openclaw-node" : "test",
              sourceInfo: {
                source: virtual ? "openclaw-node" : "test",
                path: locator,
                scope: "temporary",
                origin: "top-level",
              },
              disableModelInvocation: false,
            },
          ],
        },
      });

      const result = await requireTool(tools, "read").execute("whole-skill-read", {
        path: locator,
      });

      if (oversized) {
        expect(extractToolText(result)).toMatch(
          /(?:cannot|omitted|exceeds).*whole|whole.*(?:cannot|exceeds)|partially served/i,
        );
        expect(extractToolText(result)).not.toContain("# Pond");
        expect(Buffer.byteLength(extractToolText(result), "utf8")).toBeLessThanOrEqual(32 * 1024);
        return;
      }

      expect(extractToolText(result)).toBe(content);
    },
  );

  const testConfig: OpenClawConfig = {};

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("passes explicit channel and requester facts to wrapped tool hooks", async () => {
    const beforeToolCall = beforeToolHook();
    const { root: tmpDir } = await fileFixture("note.txt", "hello");
    const memberRoleIds = ["maintainer-role"];
    const tools = createOpenClawCodingTools({
      workspaceDir: tmpDir,
      messageChannel: "discord",
      agentAccountId: "operations",
      currentChannelId: "telegram:-100123",
      hookChannelId: "-100123",
      memberRoleIds,
      senderId: "maintainer-user",
      senderIsOwner: false,
    });
    memberRoleIds.push("late-role");
    const readTool = requireTool(tools, "read");
    await readTool.execute("tool-hook-channel", { path: "note.txt" });

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(beforeToolCall.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        channelId: "-100123",
        requester: {
          channel: "discord",
          accountId: "operations",
          senderId: "maintainer-user",
          senderIsOwner: false,
          roleIds: ["maintainer-role"],
        },
      }),
    );
  });

  it("binds configured MCP cron authority only to the exact admitted run", async () => {
    const resolve = vi.fn().mockResolvedValue({
      tools: ["read", { name: "mcp_todoist_add_task", pluginId: "todoist" }],
      provenance: { version: 1, source: "final-executable-surface" },
    });
    let releaseRun: (() => void) | undefined;
    const holdRun = new Promise<void>((resolveHold) => {
      releaseRun = resolveHold;
    });
    let retainedResolver: (() => Promise<unknown>) | undefined;
    const buildTools = (
      capability: ReturnType<typeof createCronCreatorAuthorityCapability>,
      runId: string,
      toolRunId = runId,
    ) => cronTools(capability, runId, resolve, toolRunId);

    vi.mocked(createOpenClawTools).mockClear();
    const forgedTools = buildTools(undefined, "forged-run");
    expect(toolNameList(forgedTools)).not.toContain("automations");
    expect(lastCoreOptions().resolveCronCreatorToolAuthority).toBeUndefined();

    const capability = createCronCreatorAuthorityCapability("admitted-run")!;
    const activeRun = runWithCronCreatorAuthorityCapability(capability, async () => {
      const wrongRunTools = buildTools(capability, "other-run", "admitted-run");
      expect(toolNameList(wrongRunTools)).not.toContain("automations");
      expect(lastCoreOptions().resolveCronCreatorToolAuthority).toBeUndefined();

      const admittedTools = buildTools(capability, "admitted-run");
      expectToolNames(admittedTools, ["automations"], ["gateway", "nodes", "openclaw"]);
      retainedResolver = lastCoreOptions().resolveCronCreatorToolAuthority;
      expect(retainedResolver).toEqual(expect.any(Function));
      await expect(retainedResolver!()).resolves.toMatchObject({
        provenance: { source: "final-executable-surface" },
      });
      await holdRun;
    });

    releaseRun?.();
    await activeRun;
    await expect(retainedResolver!()).rejects.toThrow(
      "Configured MCP cron authority is no longer active for this run",
    );
    expect(
      toolNameList(createOpenClawCodingTools({ runId: "admitted-run", senderIsOwner: false })),
    ).not.toContain("automations");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("drops senderless Automations retention when exact authority aborts or errors", async () => {
    const resolve = async () => ({
      tools: ["read"],
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
    });
    const buildTools = (capability: CronResolver["capability"]) =>
      cronTools(capability, "lifecycle-run", resolve);

    const abortController = new AbortController();
    const abortedCapability = createCronCreatorAuthorityCapability("lifecycle-run")!;
    await runWithCronCreatorAuthorityCapability(
      abortedCapability,
      async () => {
        expect(toolNameList(buildTools(abortedCapability))).toContain("automations");
        abortController.abort(new Error("run cancelled"));
        expect(toolNameList(buildTools(abortedCapability))).not.toContain("automations");
      },
      abortController.signal,
    );
    expect(abortedCapability.active).toBe(false);

    const failedCapability = createCronCreatorAuthorityCapability("lifecycle-run")!;
    await expect(
      runWithCronCreatorAuthorityCapability(failedCapability, async () => {
        expect(toolNameList(buildTools(failedCapability))).toContain("automations");
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    expect(failedCapability.active).toBe(false);
    expect(
      toolNameList(createOpenClawCodingTools({ runId: "lifecycle-run", senderIsOwner: false })),
    ).not.toContain("automations");
  });

  it("re-wraps existing before_tool_call hooks once with the current context", async () => {
    const beforeToolCall = beforeToolHook();
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const wrapped = wrapToolWithBeforeToolCallHook(
      {
        ...stubTool("already_wrapped"),
        label: "Already wrapped",
        parameters: {},
        execute,
      },
      { agentId: "main", sessionId: "session-original" },
    );
    vi.mocked(createOpenClawTools).mockReturnValueOnce([wrapped as never]);

    const tools = createOpenClawCodingTools({ agentId: "main", sessionId: "session-new" });
    const tool = requireTool(tools, "already_wrapped");
    await tool.execute("call-wrapped", {});

    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(beforeToolCall.mock.calls[0]?.[1]).toMatchObject({
      agentId: "main",
      sessionId: "session-new",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("honors the shipped dispatcher deny tool_call", () => {
    expectToolSurface(
      {
        includeToolSearchControls: true,
        config: { tools: { profile: "coding", deny: ["tool_call"], toolSearch: true } },
      },
      ["read"],
      ["dispatch_action"],
    );
  });

  it("keeps Tool Search controls when core OpenClaw tools are not materialized", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    const tools = createOpenClawCodingTools({
      includeCoreTools: false,
      includeToolSearchControls: true,
      toolConstructionPlan: pluginOnlyPlan,
      config: { tools: { toolSearch: true } },
    });
    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expectToolNames(
      tools,
      ["tool_search", "tool_describe", "dispatch_action"],
      ["message", "exec"],
    );
  });

  it("keeps the injected ring-zero tool under policy and rejects a same-name replacement", () => {
    const injectedTool = {
      ...stubTool("openclaw"),
      label: "OpenClaw",
      description: "trusted ring-zero tool",
      execute: async () => ({ content: [], details: {} }),
    };
    const duplicateTool = {
      ...injectedTool,
      description: "duplicate plugin tool",
    };
    vi.mocked(createOpenClawTools).mockReturnValueOnce([duplicateTool]);

    const tools = runWithAgentRingZeroTools([injectedTool], () =>
      createOpenClawCodingTools({
        config: { tools: { allow: ["read"], deny: ["openclaw"] } },
        runtimeToolAllowlist: ["openclaw"],
        toolConstructionPlan: { ...pluginOnlyPlan, includeOpenClawTools: true },
      }),
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "openclaw", description: "trusted ring-zero tool" });
  });

  it("lets direct callers inherit overlapping globs into subagent spawns", () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist: attachToolAllowlistIntersection([], [["sessions_*"], ["*_spawn"]]),
      inheritRuntimeToolAllowlist: true,
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const inheritedAllow = lastCoreOptions().inheritedToolAllowlist;
    expect(inheritedAllow).toContain("sessions_spawn");
    expect(inheritedAllow?.includes("exec")).toBe(false);
  });

  it("preserves configured media tools through local model lean filtering", () => {
    expectToolSurface(
      {
        config: {
          agents: {
            defaults: { experimental: { localModelLean: true } },
            entries: {
              artist: {
                tools: {
                  alsoAllow: ["video_generate"],
                  byProvider: { ollama: { alsoAllow: ["tts"] } },
                },
              },
            },
          },
          tools: {
            alsoAllow: ["pdf"],
            byProvider: { "ollama/qwen3.5:9b": { alsoAllow: ["image_generate"] } },
          },
        },
        agentId: "artist",
        modelProvider: "ollama",
        modelId: "qwen3.5:9b",
        toolConstructionPlan: openClawOnlyPlan,
      },
      ["image_generate", "pdf", "tts", "video_generate"],
    );
  });

  it("preserves runtime allowlist groups containing message through restrictive profiles", () => {
    for (const runtimeToolAllowlist of [["group:messaging"], ["group:openclaw"], ["*"]]) {
      expectToolSurface(
        {
          config: { tools: { profile: "minimal" } },
          runtimeToolAllowlist,
          toolConstructionPlan: openClawOnlyPlan,
        },
        ["message"],
      );
    }
  });

  it.each([
    ["unverified forged completion flags", ["message"], false],
    ["wider trusted completion", ["message", "read"], true],
  ] satisfies Array<[string, string[], boolean]>)(
    "limits %s to the source only for verified completion delivery",
    async (_name, runtimeToolAllowlist, verifiedLineage) => {
      const storeTemplate = sessionStoreTemplate();
      const requesterSessionKey = "agent:main:discord:direct:alice";
      const requesterSessionId = "requester-session";
      const childSessionKey = "agent:main:subagent:child";
      const childSessionId = "verified-child-session";
      const modelProvider = "openai";
      const modelId = "gpt-5.4";
      const config: OpenClawConfig = { session: { store: storeTemplate } };
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceSessionKey: childSessionKey,
        sourceTool: "subagent_announce",
      };
      const trustedInternalHandoff = {
        kind: "subagent-completion" as const,
        sourceSessionKey: childSessionKey,
        sourceSessionId: childSessionId,
        targetSessionKey: requesterSessionKey,
        targetSessionId: requesterSessionId,
        provider: modelProvider,
        model: modelId,
      };

      if (verifiedLineage) {
        await writeSessionStore(storeTemplate, "main", {
          [childSessionKey]: sessionEntry(childSessionId, {
            spawnedBy: requesterSessionKey,
            spawnDepth: 1,
            subagentRole: "orchestrator",
            subagentControlScope: "children",
            inheritedToolPolicyVersion: 1,
          }),
        });
      }
      const request = {
        config,
        agentId: "main",
        sessionKey: requesterSessionKey,
        sessionId: requesterSessionId,
        modelProvider,
        modelId,
        runtimeToolAllowlist,
        inputProvenance,
        trustedInternalHandoff,
      };
      const conversationCapabilityProfile = await prepareConversationCapabilityProfile(request);
      expect(conversationCapabilityProfile.policy.requesterPolicySource).toBe(
        verifiedLineage ? "completion-handoff" : "current-request",
      );

      vi.mocked(createOpenClawTools).mockClear();
      createOpenClawCodingTools({
        ...request,
        conversationCapabilityProfile,
        sourceReplyDeliveryMode: "message_tool_only",
        inputProvenance: verifiedLineage ? undefined : inputProvenance,
        trustedInternalHandoff: verifiedLineage ? undefined : trustedInternalHandoff,
      });

      expect(lastCoreOptions().sourceReplyOnly).toBe(verifiedLineage);
    },
  );

  it("allows workspace-only reads from declared sandbox bind mounts", async () => {
    const workspaceDir = tempDirs.make("openclaw-sandbox-workspace-");
    const { root: bindRoot, filePath: boundFile } = await fileFixture(
      "example/tree-index.json",
      '{"ready":true}\n',
    );

    const sandbox = createAgentToolsSandboxContext({
      workspaceDir,
      workspaceAccess: "none",
      dockerOverrides: { binds: [`${bindRoot}:/cache/repos:ro`] },
    });
    sandbox.fsBridge = createSandboxFsBridgeFromResolver((filePath) => {
      const relativePath = path.posix.relative("/cache/repos", filePath);
      return {
        hostPath: path.join(bindRoot, relativePath),
        relativePath,
        containerPath: filePath,
      };
    });

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: true } } },
      sandbox,
    });

    const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);
    const result = await readTool.execute("read-declared-bind", {
      path: "/cache/repos/example/tree-index.json",
    });
    expect(extractToolText(result)).toContain('{"ready":true}');
    await expect(
      writeTool.execute("write-declared-bind", {
        path: "/cache/repos/example/tree-index.json",
        content: "overwritten",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    await expect(
      editTool.execute("edit-declared-bind", {
        path: "/cache/repos/example/tree-index.json",
        oldText: "true",
        newText: "false",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/i);
    await expect(fs.readFile(boundFile, "utf8")).resolves.toBe('{"ready":true}\n');
  });

  it("continues oversized data through the assembled shell-disabled read tool", async () => {
    const original = JSON.stringify({ generated: "x".repeat(52 * 1024) });
    const { root: workspaceDir } = await fileFixture("generated.json", original);
    const tools = createOpenClawCodingTools({
      workspaceDir,
      toolConstructionPlan: baseOnlyPlan,
    });
    expectToolNames(tools, [], ["exec", "process"]);
    const read = requireTool(tools, "read");
    expect(read.description).not.toMatch(/\b(?:bash|sed|head)\b/);

    const result = await read.execute("read-no-shell", { path: "generated.json" });
    const text = extractToolText(result);
    const continuation = (result.details as { continuation?: { cursor?: number } }).continuation;
    expect(text).not.toMatch(/\b(?:bash|sed|head)\b/);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(continuation?.cursor).toBeGreaterThan(0);
    expect(text).toContain(`cursor=${continuation?.cursor}`);
    const next = await read.execute("read-no-shell-next", {
      path: "generated.json",
      cursor: continuation?.cursor,
    });
    expect(extractToolText(next)).toBe(original.slice(continuation?.cursor));
  });

  it("includes plugin tools declared for the active built-in profile", () => {
    const resolvePluginToolsSpy = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([
        {
          name: "profiled_plugin_tool",
          label: "Profiled plugin tool",
          description: "Profiled plugin tool test fixture",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({
            content: [{ type: "text" as const, text: "ok" }],
            details: {},
          }),
        },
      ]);
    const preparedModelRuntime = {
      metadataSnapshot: {
        plugins: [
          {
            id: "profiled-plugin",
            contracts: { tools: ["profiled_plugin_tool"] },
            toolMetadata: { profiled_plugin_tool: { profiles: ["coding"] } },
          },
        ],
      },
    } as never;

    try {
      const tools = createOpenClawCodingTools({
        config: { tools: { profile: "coding" } },
        includeCoreTools: false,
        preparedModelRuntime,
        toolConstructionPlan: pluginOnlyPlan,
      });

      expect(tools.map((tool) => tool.name)).toEqual(["profiled_plugin_tool"]);
      expect(resolvePluginToolsSpy.mock.calls[0]?.[0].options?.pluginToolAllowlist).toContain(
        "profiled_plugin_tool",
      );
    } finally {
      resolvePluginToolsSpy.mockRestore();
    }
  });

  registerPluginOnlyCallerIdentityCase({ testConfig, requireTool });

  it("materializes additive runtime tools while preserving normal deny policy", async () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const config: OpenClawConfig = { tools: { profile: "coding", deny: ["workboard_block"] } };

    createOpenClawCodingTools({
      config,
      conversationCapabilityProfile: await prepareConversationCapabilityProfile({
        config,
        runtimePluginToolGrant: {
          pluginId: "workboard",
          toolNames: ["workboard_heartbeat", "workboard_complete"],
        },
      }),
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const options = lastCoreOptions();
    expect(options.pluginToolAllowlist).not.toContain("workboard_heartbeat");
    expect(
      createPluginToolAllowlist(options.pluginToolAllowlist).allowsTool(
        "workboard",
        "workboard_heartbeat",
      ),
    ).toBe(true);
    expect(options).not.toHaveProperty("runtimePluginToolGrant");
    expect(options.pluginToolDenylist).toContain("workboard_block");
  });

  it("removes message from persisted visible child sessions on every turn", async () => {
    const storeTemplate = sessionStoreTemplate();
    const agentId = "visible-subagent-message";
    const childSessionKey = `agent:${agentId}:dashboard:child`;
    const rootSessionKey = `agent:${agentId}:dashboard:root`;
    await writeSessionStore(storeTemplate, agentId, {
      [childSessionKey]: sessionEntry("visible-child", {
        spawnDepth: 1,
        spawnedBy: `agent:${agentId}:main`,
        subagentRole: "leaf",
        subagentControlScope: "none",
      }),
      [rootSessionKey]: sessionEntry("root-dashboard", { spawnDepth: 0 }),
    });

    const firstChildTurn = createToolsForStoredSession(storeTemplate, childSessionKey);
    const resumedChildTurn = createToolsForStoredSession(storeTemplate, childSessionKey);
    const rootTurn = createToolsForStoredSession(storeTemplate, rootSessionKey);

    expect(toolNameList(firstChildTurn)).not.toContain("message");
    expect(toolNameList(resumedChildTurn)).not.toContain("message");
    expect(toolNameList(rootTurn)).toContain("message");
  });

  it("enforces apply_patch availability and canonical names across model/provider constraints", () => {
    expectToolSurface({ config: testConfig }, ["exec", "process", "apply_patch"]);
    const model = { config: testConfig, modelProvider: "openai", modelId: "gpt-5.4" };
    const disabled: OpenClawConfig = { tools: { exec: { applyPatch: { enabled: false } } } };
    const allowModels: OpenClawConfig = {
      tools: { exec: { applyPatch: { allowModels: ["gpt-5.4"] } } },
    };
    for (const [options, enabled] of [
      [model, true],
      [{ ...model, config: disabled }, false],
      [{ config: disabled, modelProvider: "anthropic", modelId: "claude-opus-4-6" }, false],
      [{ ...model, config: allowModels }, true],
      [{ ...model, config: allowModels, modelId: "gpt-5.4-mini" }, false],
    ] satisfies Array<[Parameters<typeof createOpenClawCodingTools>[0], boolean]>) {
      expectToolSurface(options, enabled ? ["apply_patch"] : [], enabled ? [] : ["apply_patch"]);
    }
    expectToolSurface(
      {
        config: testConfig,
        modelProvider: "anthropic",
        modelAuthMode: "oauth",
      },
      ["exec", "read", "write", "edit", "apply_patch"],
    );
  });

  it("separates the canonical message provider from transport tool policy", () => {
    vi.mocked(createOpenClawTools).mockClear();

    const tools = createOpenClawCodingTools({
      config: { tools: { toolsBySender: { "channel:discord:speaker-1": { deny: ["exec"] } } } },
      messageProvider: "discord",
      toolPolicyMessageProvider: "discord-voice",
      senderId: "speaker-1",
    });
    expectToolNames(tools, [], ["exec", "tts"]);
    expect(lastCoreOptions().agentChannel).toBe("discord");
  });

  it("applies subagent tool policy to ACP children spawned under a subagent envelope", async () => {
    const storeTemplate = path.join(sessionDirs.make(), "sessions-{agentId}.json");
    await writeSessionStore(storeTemplate, "main", {
      "agent:main:acp:child": sessionEntry("session-acp-child", {
        spawnedBy: "agent:main:subagent:parent",
        spawnDepth: 2,
        subagentRole: "leaf",
        subagentControlScope: "none",
      }),
      "agent:main:acp:plain": sessionEntry("session-acp-plain", {
        spawnedBy: "agent:main:main",
      }),
      "agent:main:acp:parent": sessionEntry("session-acp-parent", {
        spawnedBy: "agent:main:subagent:parent",
      }),
    });
    await writeSessionStore(storeTemplate, "writer", {
      "agent:writer:acp:child": sessionEntry("session-acp-cross-agent-child", {
        spawnedBy: "agent:main:acp:parent",
      }),
    });

    const persistedEnvelopeTools = createToolsForStoredSession(
      storeTemplate,
      "agent:main:acp:child",
    );
    expectNoSubagentControlTools(persistedEnvelopeTools);

    const restrictedTools = createToolsForStoredSession(storeTemplate, "agent:main:acp:plain");
    expectToolNames(restrictedTools, ["sessions_spawn", "subagents"]);

    const ancestryTools = createToolsForStoredSession(storeTemplate, "agent:writer:acp:child");
    expectNoSubagentControlTools(ancestryTools);
  });

  it("keeps browser out of coding-profile subagents unless profile-stage alsoAllow adds it", () => {
    const baseConfig = {
      browser: { enabled: true },
      plugins: { entries: { browser: { enabled: true } } },
      tools: { profile: "coding" },
    } as OpenClawConfig;
    for (const [tools, allowed] of [
      [{ profile: "coding" }, false],
      [{ profile: "coding", subagents: { tools: { allow: ["browser"] } } }, false],
      [{ profile: "coding", alsoAllow: ["browser"] }, true],
    ] satisfies Array<[OpenClawConfig["tools"], boolean]>) {
      expectToolSurface(
        { sessionKey: "agent:main:subagent:test", config: { ...baseConfig, tools } },
        allowed ? ["browser"] : [],
        allowed ? [] : ["browser"],
      );
    }
  });

  it("enables heartbeat response when visible replies are message-tool-only", () => {
    expectToolSurface(
      {
        config: { messages: { visibleReplies: "message_tool" }, tools: { profile: "coding" } },
        trigger: "heartbeat",
      },
      ["heartbeat_respond"],
    );
  });

  it("can keep message available when a cron route needs it under a provider coding profile", () => {
    const options = {
      config: { tools: { byProvider: { openai: { profile: "coding" } } } },
      modelProvider: "openai",
      modelId: "gpt-5.4",
    } satisfies NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
    expectToolSurface(options, [], ["message"]);
    expectToolSurface({ ...options, forceMessageTool: true }, ["message"]);
  });

  it("returns image-aware read metadata for images and text-only blocks for text files", async () => {
    const defaultTools = createOpenClawCodingTools();
    const readTool = requireTool(defaultTools, "read");
    const readExecute = readTool.execute;

    const { root: tmpDir, filePath: imagePath } = await fileFixture("sample.png", tinyPngBuffer);

    const imageResult = await readExecute("tool-1", {
      path: imagePath,
    });

    const imageBlocks = imageResult.content.filter((block) => block.type === "image");
    const imageText = imageResult.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(imageText).toContain("Read image file [image/png]");
    if (imageBlocks.length > 0) {
      expect(imageBlocks.every((block) => block.mimeType === "image/png")).toBe(true);
    } else {
      expect(imageText).toContain("[Image omitted:");
    }

    const textPath = path.join(tmpDir, "sample.txt");
    const contents = "Hello from openclaw read tool.";
    await fs.writeFile(textPath, contents, "utf8");

    const textResult = await readExecute("tool-2", {
      path: textPath,
    });

    expect(textResult?.content).toEqual([{ type: "text", text: contents }]);
  });

  it.each([
    ["none", ["bash"], ["browser"], ["exec"], ["read", "browser"]],
    ["ro", ["read", "write", "edit"], [], ["read"], ["write", "edit"]],
  ] as const)(
    "enforces sandbox %s access and tool policy",
    (access, allow, deny, present, absent) => {
      const sandboxDir = path.join(os.tmpdir(), "openclaw-sandbox");
      const sandbox = createAgentToolsSandboxContext({
        workspaceDir: sandboxDir,
        agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-workspace"),
        workspaceAccess: access,
        fsBridge: createHostSandboxFsBridge(sandboxDir),
        tools: { allow: [...allow], deny: [...deny] },
      });
      expectToolSurface({ sandbox }, [...present], [...absent]);
    },
  );

  it("records restricted memory flush writes without an active memory provider", async () => {
    const taskCwd = tempDirs.make("openclaw-memory-cwd-");
    const memoryRelativePath = "memory/2026-03-24.md";
    const { root: workspaceDir, filePath: workspaceMemoryFile } = await fileFixture(
      memoryRelativePath,
      "seed",
    );
    const taskMemoryFile = path.join(taskCwd, memoryRelativePath);

    const tools = createOpenClawCodingTools({
      workspaceDir,
      cwd: taskCwd,
      config: { plugins: { slots: { memory: "none" } } },
      trigger: "memory",
      memoryFlushWritePath: memoryRelativePath,
      senderIsOwner: false,
    });
    const writeExecute = requireTool(tools, "write").execute;

    await writeExecute("tool-memory-flush-workspace", {
      path: memoryRelativePath,
      content: "new durable note",
    });

    await expect(fs.readFile(workspaceMemoryFile, "utf8")).resolves.toBe("seed\nnew durable note");
    await expect(fs.stat(taskMemoryFile)).rejects.toThrow();
    await provenance(workspaceDir, memoryRelativePath).toMatchObject({ originClass: "untrusted" });
  });

  it("records turn taint and source-session lineage for memory writes, edits, and patches", async () => {
    const workspaceDir = tempDirs.make("openclaw-memory-write-taint-");
    let tainted = false;
    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: { tools: { fs: { workspaceOnly: true } } },
      sessionId: "source-session",
      sessionKey: "agent:main:policy-session",
      runSessionKey: "agent:main:durable-session",
      senderIsOwner: true,
      isTurnTainted: () => tainted,
    });
    const write = requireTool(tools, "write").execute;
    const edit = requireTool(tools, "edit").execute;
    const applyPatch = requireTool(tools, "apply_patch").execute;

    await write("write-memory", {
      path: "memory/2026-07-29.md",
      content: "owner-requested note\n",
    });
    tainted = true;
    await edit("edit-memory", {
      path: "memory/2026-07-29.md",
      edits: [{ oldText: "note", newText: "network-derived note" }],
    });
    await applyPatch("patch-memory", addPatch("memory/project.md", "network project note"));

    for (const relativePath of ["memory/2026-07-29.md", "memory/project.md"]) {
      await provenance(workspaceDir, relativePath).toMatchObject({
        originClass: "untrusted",
        sessionId: "source-session",
        sessionKey: "agent:main:durable-session",
      });
    }
    await expect(
      applyPatch("patch-existing-memory", addPatch("memory/project.md", "replacement")),
    ).rejects.toThrow(/file already exists/i);
    await provenance(workspaceDir, "memory/project.md").toMatchObject({ originClass: "untrusted" });
    await expect(fs.readFile(path.join(workspaceDir, "memory/project.md"), "utf8")).resolves.toBe(
      "network project note\n",
    );
  });

  it("records agent provenance after an untainted same-turn delete and recreate", async () => {
    const { root: workspaceDir } = await fileFixture("memory/recreated.md", "old\n");
    const applyPatch = requireTool(
      createOpenClawCodingTools({
        workspaceDir,
        senderIsOwner: true,
        isTurnTainted: () => false,
      }),
      "apply_patch",
    ).execute;
    await applyPatch("delete-memory", {
      input: "*** Begin Patch\n*** Delete File: memory/recreated.md\n*** End Patch",
    });
    await applyPatch("recreate-memory", addPatch("memory/recreated.md", "recreated"));
    await provenance(workspaceDir, "memory/recreated.md").toMatchObject({ originClass: "agent" });
  });

  it("records sandbox-backed relative memory writes before mutation", async () => {
    const workspaceDir = tempDirs.make("openclaw-memory-sandbox-taint-");
    const sandboxRoot = path.join(workspaceDir, "private");
    await fs.mkdir(sandboxRoot);
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: sandboxRoot,
      agentWorkspaceDir: workspaceDir,
      fsBridge: createContainerWorkspaceSandboxFsBridge(sandboxRoot),
      workspaceAccess: "none",
    });
    const tools = createOpenClawCodingTools({
      workspaceDir,
      sandbox,
      senderIsOwner: true,
      isTurnTainted: () => true,
    });
    await requireTool(tools, "write").execute("sandbox-project", {
      path: "project.txt",
      content: "before\n",
    });
    await requireTool(tools, "edit").execute("sandbox-edit", {
      path: "project.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    await expect(fs.readFile(path.join(sandboxRoot, "project.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
    await requireTool(tools, "write").execute("sandbox-memory", {
      path: "memory/2026-07-29.md",
      content: "sandbox network note\n",
    });
    await requireTool(tools, "apply_patch").execute(
      "sandbox-patch",
      addPatch("memory/nested/project.md", "project note"),
    );
    for (const file of ["memory/nested/project.md", "memory/2026-07-29.md"]) {
      await provenance(sandboxRoot, file).toMatchObject({ originClass: "untrusted" });
    }
    await provenance(workspaceDir, "memory/2026-07-29.md").toBeUndefined();
  });
  it("rejects legacy alias parameters", async () => {
    const tmpDir = tempDirs.make("openclaw-legacy-alias-");
    const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
    const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

    await expect(
      writeTool?.execute("tool-legacy-write", {
        file: "legacy.txt",
        content: "hello old value",
      }),
    ).rejects.toThrow(/Missing required parameter: path/);

    await expect(
      editTool?.execute("tool-legacy-edit", {
        filePath: "legacy.txt",
        old_text: "old",
        newString: "new",
      }),
    ).rejects.toThrow(/Missing required parameters: path, edits/);

    await expect(
      readTool?.execute("tool-legacy-read", {
        file_path: "legacy.txt",
      }),
    ).rejects.toThrow(/Missing required parameter: path/);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("createOpenClawCodingTools read behavior", () => {
  it("protects materialized sandbox skill identities when no skill snapshot exists", async () => {
    const relativePath = "skills/demo/SKILL.md";
    const { root, filePath } = await fileFixture(relativePath, "# Demo\ncomplete instructions");
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: root,
      fsBridge: createContainerWorkspaceSandboxFsBridge(root),
    });
    const tools = createOpenClawCodingTools({
      sandbox,
      skillUsagePaths: [
        {
          readPath: `/workspace/${relativePath}`,
          skillFile: filePath,
          skillName: "demo",
          skillSource: "workspace",
        },
      ],
    });
    const read = requireTool(tools, "read");

    expect(extractToolText(await read.execute("sandbox-skill", { path: relativePath }))).toBe(
      "# Demo\ncomplete instructions",
    );
    for (const window of [{ offset: 2 }, { limit: 1 }, { cursor: 0 }]) {
      const windowed = await read.execute("sandbox-skill-window", {
        path: `/workspace/${relativePath}`,
        ...window,
      });
      expect(extractToolText(windowed)).toBe("# Demo\ncomplete instructions");
    }
  });

  it("deduplicates sequential and concurrent successful skill reads within one attempt", async () => {
    const locator = skillLocator;
    let releaseRead = (): void => undefined;
    const pendingRead = new Promise<AgentToolResult<ReadToolDetails>>((resolve) => {
      releaseRead = () => resolve(fullSkillResult);
    });
    const execute = vi.fn(() => pendingRead);
    const tool = skillReadTool(execute);

    const first = tool.execute("first-skill-read", { path: locator });
    const concurrent = tool.execute("concurrent-skill-read", { path: locator });
    expect(execute).toHaveBeenCalledTimes(1);
    releaseRead();

    expect(extractToolText(await first)).toBe("# Pond\ncomplete instructions");
    expect(extractToolText(await concurrent)).toContain("already served whole");
    expect(
      extractToolText(await tool.execute("sequential-skill-read", { path: locator })),
    ).toContain("already served whole");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries skill reads after failures, whole-read refusals, and optional misses", async () => {
    const locator = skillLocator;
    const truncatedResult: AgentToolResult<ReadToolDetails> = {
      content: [{ type: "text", text: "partial" }],
      details: {
        kind: "truncated",
        content: "partial",
        continuation: { kind: "line", offset: 2 },
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          totalLines: 2,
          totalBytes: 16,
          outputLines: 1,
          outputBytes: 7,
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 1,
          maxBytes: 32_768,
        },
      },
    };
    const notFoundResult: AgentToolResult<ReadToolDetails> = {
      content: [{ type: "text", text: `Optional file not found: ${locator}.` }],
      details: { kind: "not_found", status: "not_found", path: locator, optional: true },
    };
    const execute = vi
      .fn<() => Promise<AgentToolResult<ReadToolDetails>>>()
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce(truncatedResult)
      .mockResolvedValueOnce(notFoundResult)
      .mockResolvedValueOnce(fullSkillResult);
    const tool = skillReadTool(execute);

    await expect(tool.execute("failed-skill-read", { path: locator })).rejects.toThrow(
      "transient read failure",
    );
    expect(
      extractToolText(await tool.execute("oversized-skill-read", { path: locator })),
    ).toContain("cannot be partially served");
    expect(
      extractToolText(
        await tool.execute("optional-missing-skill-read", { path: locator, optional: true }),
      ),
    ).toContain("Optional file not found");
    expect(extractToolText(await tool.execute("retried-skill-read", { path: locator }))).toBe(
      "# Pond\ncomplete instructions",
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("applies sandbox path guards to canonical path", async () => {
    const tmpDir = tempDirs.make("openclaw-sbx-");
    const { filePath: outsidePath } = await fileFixture("outside.txt", "outside");
    const readTool = sandboxReadTool(tmpDir);
    await expect(readTool.execute("sandbox-1", { path: outsidePath })).rejects.toThrow(
      /sandbox root/i,
    );
  });

  it("rejects sandbox directory reads before calling the bridge read operation", async () => {
    const tmpDir = tempDirs.make("openclaw-sbx-directory-");
    const directoryName = "notes";
    await fs.mkdir(path.join(tmpDir, directoryName));
    const hostBridge = createHostSandboxFsBridge(tmpDir);
    const readFile = vi.fn(hostBridge.readFile.bind(hostBridge));
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: { ...hostBridge, readFile },
    });

    await expect(readTool.execute("sandbox-directory", { path: directoryName })).rejects.toThrow(
      `Read requires a file path, but ${directoryName} is a directory. List the directory, then read a specific file.`,
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("resolves Unicode-equivalent filenames through sandbox operations", async () => {
    const { read } = await sandboxReadFixture(
      "re\u0301sume\u0301 3.04\u202fPM d\u2019accord.txt",
      "sandbox match",
    );
    const result = await read.execute("sandbox-unicode", {
      path: "r\u00e9sum\u00e9 3.04 PM d'accord.txt",
    });
    expect(extractToolText(result)).toContain("Resolved filename");
    expect(extractToolText(result)).toContain("sandbox match");
  });

  it("maps inbound media refs to sandbox-staged media for reads", async () => {
    const { read } = await sandboxReadFixture("media/inbound/upload.txt", "sandbox media");
    const result = await read.execute("read-media-sbx", { path: "media://inbound/upload.txt" });
    expect(extractToolText(result)).toContain("sandbox media");
  });

  it("classifies sandbox AVIF reads from the already-read buffer", async () => {
    const { root: tmpDir } = await fileFixture("photo.bin", avifHeaderBuffer);
    const hostBridge = createHostSandboxFsBridge(tmpDir);
    const readFile = vi.fn(hostBridge.readFile.bind(hostBridge));
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: { ...hostBridge, readFile },
    });

    const result = await readTool.execute("sandbox-avif", { path: "photo.bin" });

    expect(extractToolText(result)).toContain("Read image file [image/avif]");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("auto-pages read output across chunks when context window budget allows", async () => {
    const lines = Array.from(
      { length: 5000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}`,
    );
    const { root: tmpDir } = await fileFixture("big.txt", lines.join("\n"));
    const readTool = createSandboxedReadTool({
      root: tmpDir,
      bridge: createHostSandboxFsBridge(tmpDir),
      modelContextWindowTokens: 200_000,
    });
    const result = await readTool.execute("read-autopage-1", { path: "big.txt" });
    const text = extractToolText(result);
    expect(text).toContain("line-0001");
    expect(text).toContain("line-5000");
    expect(text).not.toContain("Read output capped at");
    expect(text).not.toMatch(/Use offset=\d+ to continue\.\]$/);
  });

  it("caps the first read page including its notice with an explicit line limit", async () => {
    const original = "é🦞".repeat(9 * 1024);
    const { read } = await sandboxReadFixture("unicode.txt", original);

    const result = await read.execute("read-first-page-cap", { path: "unicode.txt", limit: 1 });
    const text = extractToolText(result);
    const details = result.details as {
      continuation?: { kind: string; offset: number; cursor: number };
    };

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(details.continuation).toMatchObject({ kind: "cursor", offset: 1 });
    expect(text).toContain(`cursor=${details.continuation?.cursor}`);
    expect(text.replace(/\n\n\[Read output capped[^\]]*\]$/, "")).toBe(
      original.slice(0, details.continuation?.cursor),
    );
  });

  it("ignores a trailing newline when describing offsets beyond EOF", async () => {
    const { read } = await sandboxReadFixture("notes.txt", "one\ntwo\nthree\n");
    const result = await read.execute("read-offset-adaptive", {
      path: "notes.txt",
      offset: 99,
    });

    expect(extractToolText(result)).toBe(
      "Offset 99 is beyond end of file (3 lines total). Retry with offset <= 3.",
    );
  });
});

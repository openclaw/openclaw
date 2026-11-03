import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/io.factory.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type {
  CliBackendExecuteContext,
  CliBackendPlugin,
} from "../../plugins/cli-backend.types.js";
import { readTranscriptMessages } from "../../sessions/user-turn-transcript.test-support.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestCliSessionBinding,
  createTestMcpLoopbackClientGrant,
  createWeatherSkillFixture,
} from "../cli-runner.test-helpers.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../command/claude-cli-project-dir.js";
import { executePreparedCliRun } from "./execute.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

const nativeSessionId = "f1a63c45-3c40-4395-b97a-e1e43997c587";
let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
const sent: Array<
  Pick<
    CliBackendExecuteContext,
    | "args"
    | "sessionId"
    | "useResume"
    | "systemPrompt"
    | "prompt"
    | "promptContext"
    | "toolAvailability"
  >
> = [];

function installBackend(args?: string[]) {
  const backend = buildAnthropicCliBackend();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        ...backend,
        pluginId: "anthropic",
        config: {
          ...backend.config,
          command: process.execPath,
          ...(args ? { args, resumeArgs: [...args, "--resume", "{sessionId}"] } : {}),
        },
        // Replace only final provider I/O; config, storage, preparation and
        // session-reusing execution are exercised through their production paths.
        runtimeArtifact: undefined,
        prepareExecution: async (context) => ({
          ...(await backend.prepareExecution?.(context)),
          async *execute(input: CliBackendExecuteContext) {
            sent.push({
              args: [...input.args],
              sessionId: input.sessionId,
              useResume: input.useResume,
              systemPrompt: input.systemPrompt,
              prompt: input.prompt,
              promptContext: input.promptContext,
              toolAvailability: input.toolAvailability,
            });
            yield {
              type: "result",
              subtype: "success",
              result: "resumed",
              session_id: nativeSessionId,
            };
          },
        }),
      },
    ],
  });
}

beforeEach(() => {
  sent.length = 0;
  installBackend();
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: () => ({
      port: 31783,
      ownerToken: "fixture-owner",
      nonOwnerToken: "fixture-reader",
    }),
    mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
    bindMcpLoopbackClientGrantAdmission: () => true,
    revokeMcpLoopbackClientGrant: () => true,
    resolveMcpLoopbackPolicyTools,
    resolveMcpLoopbackScopedTools,
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({
      args: ["--plugin-dir", "/synthetic/native-skills"],
      cleanup: async () => {},
    }),
    getCliLiveSessionGeneration: () => undefined,
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
});

afterEach(async () => {
  await fixture.cleanup();
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

async function assertStoredConversationSurvivesUpgrade(toolSearch: boolean | undefined) {
  const { dir, sessionTarget } = fixture.session;
  vi.stubEnv("HOME", dir);
  const nativeSettingsPath = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(nativeSettingsPath), { recursive: true });
  const nativeSettings = JSON.stringify(
    {
      autoMemoryEnabled: true,
      enabledPlugins: { "prior-plugin@local": true },
    },
    null,
    2,
  );
  fs.writeFileSync(nativeSettingsPath, nativeSettings);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "OPENCLAW_CONTEXT_SURVIVES_UPGRADE");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "NATIVE_CUSTOMIZATION_MUST_NOT_BE_INJECTED");
  const skills = createWeatherSkillFixture(dir, true);
  const nativeSkillsPlugin = vi.fn(async () => ({
    args: ["--plugin-dir", "/synthetic/native-skills"],
    cleanup: async () => {},
  }));
  setCliRunnerPrepareTestDeps({
    resolveBootstrapContextForRun: async () => ({
      bootstrapFiles: [],
      contextFiles: [
        {
          path: path.join(dir, "AGENTS.md"),
          content: "OPENCLAW_CONTEXT_SURVIVES_UPGRADE",
        },
      ],
    }),
    prepareClaudeCliSkillsPlugin: nativeSkillsPlugin,
  });

  const nativeProjectDir = resolveClaudeCliProjectDirForWorkspace({ workspaceDir: dir });
  fs.mkdirSync(nativeProjectDir, { recursive: true });
  const nativeTranscriptPath = path.join(nativeProjectDir, nativeSessionId + ".jsonl");
  const nativeTranscript =
    [
      {
        type: "user",
        uuid: "old-user",
        sessionId: nativeSessionId,
        message: { role: "user", content: "Remember UPGRADE-HISTORY-42." },
      },
      {
        type: "assistant",
        uuid: "old-assistant",
        parentUuid: "old-user",
        sessionId: nativeSessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Saved UPGRADE-HISTORY-42." }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  fs.writeFileSync(nativeTranscriptPath, nativeTranscript);
  fixture.appendTranscript({
    id: "old-user",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: { role: "user", content: "Remember UPGRADE-HISTORY-42.", timestamp: 1 },
  });
  fixture.appendTranscript({
    id: "old-assistant",
    parentId: "old-user",
    timestamp: new Date(2).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Saved UPGRADE-HISTORY-42." }],
      timestamp: 2,
    },
  });

  // This is a stored v2026.10.3-format binding, not a migration. Its digest is
  // the stable loopback config hash: port-canonicalized, including Claude's
  // managed timeout, with no MCP topology change between the two code versions.
  replaceSessionEntrySync(sessionTarget, {
    sessionId: sessionTarget.sessionId,
    updatedAt: 2,
    thinkingLevel: "high",
    verboseLevel: "on",
    cliSessionIds: { "claude-cli": nativeSessionId },
    cliSessionBindings: {
      "claude-cli": {
        sessionId: nativeSessionId,
        mcpResumeHash: "410ef86a7b41ee36c7814a650b5096ac6767d27487970f37030eb49f93cc5d11",
      },
    },
  });
  const previousBackendArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "user",
    "--settings",
    nativeSettingsPath,
    "--plugin-dir",
    "/synthetic/prior-plugin",
  ];
  installBackend(previousBackendArgs);

  const configPath = path.join(dir, "openclaw.json");
  const storedConfig = JSON.stringify({
    meta: { lastTouchedVersion: "2026.10.3" },
    agents: {
      defaults: {
        workspace: dir,
        model: { primary: "anthropic/claude-sonnet-4-6" },
      },
    },
    session: { store: sessionTarget.storePath },
    plugins: { enabled: false },
    tools: { allow: ["read"], ...(toolSearch === undefined ? {} : { toolSearch }) },
  } satisfies OpenClawConfig);
  fs.writeFileSync(configPath, storedConfig);
  const io = createConfigIO({
    configPath,
    env: { HOME: dir, OPENCLAW_STATE_DIR: dir },
    homedir: () => dir,
    observe: false,
  });
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
  const config = snapshot.config;
  expect(config.agents?.defaults?.workspace).toBe(dir);
  expect(config.agents?.defaults?.model).toEqual({ primary: "anthropic/claude-sonnet-4-6" });
  expect(config.tools?.allow).toEqual(["read"]);
  setRuntimeConfigSnapshot(config);

  const beforeHistory = await readTranscriptMessages(sessionTarget);
  expect(beforeHistory).toHaveLength(2);
  const childSessionKey = "agent:main:subagent:upgrade-child";
  replaceSessionEntrySync(
    { storePath: sessionTarget.storePath, sessionKey: childSessionKey },
    {
      sessionId: "upgrade-child",
      updatedAt: 2,
      spawnedBy: sessionTarget.sessionKey,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read"],
    },
  );

  const prepareTurn = (
    completion: boolean,
    cliSessionBinding: ReturnType<typeof getCliSessionBinding>,
    changedPrompt = false,
  ) => {
    const sessionEntry = loadSessionEntry(sessionTarget);
    expect(sessionEntry).toMatchObject({
      sessionId: sessionTarget.sessionId,
      thinkingLevel: "high",
      verboseLevel: "on",
    });
    return fixture.prepare({
      config,
      sessionEntry,
      sessionKey: sessionTarget.sessionKey,
      cliSessionBinding,
      provider: "claude-cli",
      model: "opus",
      modelHasVision: false,
      prompt: completion ? "The child completed." : "What did I ask you to remember?",
      skillsSnapshot: skills.snapshot,
      sourceReplyDeliveryMode: "automatic",
      ...(changedPrompt
        ? {
            extraSystemPrompt: "Updated instructions.",
            extraSystemPromptStatic: "Updated instructions.",
          }
        : {}),
      ...(completion
        ? {
            trustedInternalHandoff: {
              kind: "subagent-completion",
              sourceSessionKey: childSessionKey,
              sourceSessionId: "upgrade-child",
              targetSessionKey: sessionTarget.sessionKey,
              targetSessionId: sessionTarget.sessionId,
              provider: "claude-cli",
              model: "opus",
            },
            inputProvenance: {
              kind: "inter_session",
              sourceTool: "subagent_announce",
              sourceSessionKey: childSessionKey,
            },
          }
        : {}),
    });
  };

  // The stored binding predates the mediated catalog, so the first turn starts
  // one fresh native session; Claude cannot refresh a resumed tool catalog.
  const upgraded = await prepareTurn(
    false,
    getCliSessionBinding(loadSessionEntry(sessionTarget), "claude-cli"),
  );
  let upgradedBinding: ReturnType<typeof getCliSessionBinding>;
  try {
    expect(upgraded.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "prompt-tools",
    });
    await executePreparedCliRun(upgraded);
    upgradedBinding = createTestCliSessionBinding(upgraded, nativeSessionId);
  } finally {
    await upgraded.preparedBackend.cleanup?.();
  }
  // A verified completion then resumes that session with the same catalog.
  const completion = await prepareTurn(true, upgradedBinding);
  try {
    expect(completion.reusableCliSession).toEqual({ mode: "reuse", sessionId: nativeSessionId });
    expect(completion.promptToolNamesHash).toBe(upgraded.promptToolNamesHash);
    await executePreparedCliRun(completion, nativeSessionId);
  } finally {
    await completion.preparedBackend.cleanup?.();
  }

  // Discovery changes only loading hints; it must not override safe prompt drift.
  config.tools = { ...config.tools, toolSearch: true };
  const drifted = await prepareTurn(false, upgradedBinding, true);
  try {
    expect(drifted.reusableCliSession).toMatchObject({ mode: "reuse-with-drift" });
    await executePreparedCliRun(drifted, nativeSessionId);
  } finally {
    await drifted.preparedBackend.cleanup?.();
  }

  expect(sent).toHaveLength(3);
  expect(sent[0]?.useResume).toBe(false);
  expect(sent[0]?.args).not.toContain("--resume");
  expect(sent[1]?.sessionId).toBe(nativeSessionId);
  expect(sent[1]?.useResume).toBe(true);
  expect(sent[1]?.args).toEqual(expect.arrayContaining(["--resume", nativeSessionId]));
  for (const [index, turn] of sent.entries()) {
    expect(turn.args).toEqual(
      expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands"]),
    );
    expect(turn.args[turn.args.indexOf("--setting-sources") + 1]).toBe("");
    const settings = JSON.parse(
      expectDefined(turn.args[turn.args.indexOf("--settings") + 1], "restricted Claude settings"),
    );
    expect(settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false });
    expect(turn.args).not.toContain(nativeSettingsPath);
    expect(turn.args).not.toContain("--plugin-dir");
    expect(turn.args).not.toContain("--no-session-persistence");
    expect(turn.toolAvailability).toEqual({
      native: [],
      openClaw: ["read"],
      ...(toolSearch === false && index < 2 ? {} : { discovery: ["ToolSearch"] }),
    });
    expect(turn.systemPrompt).toContain("OPENCLAW_CONTEXT_SURVIVES_UPGRADE");
    expect(turn.systemPrompt).toContain("weather");
    expect(turn.systemPrompt).not.toContain("NATIVE_CUSTOMIZATION_MUST_NOT_BE_INJECTED");
    expect(turn.prompt).not.toContain("OpenClaw resumed this CLI session");
  }
  expect(nativeSkillsPlugin).not.toHaveBeenCalled();
  // A fresh session learns the chat has history without taking another account's text.
  expect(sent[0]?.promptContext?.prependContext).toContain("2 earlier messages in this chat");
  expect(sent[0]?.prompt).toBe("What did I ask you to remember?");
  expect(sent[2]?.promptContext?.prependContext).toContain(
    "OpenClaw resumed this CLI session after prompt content changed.",
  );
  expect(sent[2]?.prompt).toBe("What did I ask you to remember?");
  expect(sent[1]?.prompt).toContain(`[Inter-session message] sourceSession=${childSessionKey}`);
  expect(sent[1]?.prompt.endsWith("The child completed.")).toBe(true);
  expect(sent[1]?.systemPrompt).toBe(sent[0]?.systemPrompt);
  expect(await readTranscriptMessages(sessionTarget)).toEqual(beforeHistory);
  expect(fs.readFileSync(nativeTranscriptPath, "utf8")).toBe(nativeTranscript);
  expect(fs.readFileSync(configPath, "utf8")).toBe(storedConfig);
  expect(fs.readFileSync(nativeSettingsPath, "utf8")).toBe(nativeSettings);
}

it.each([undefined, false])(
  "keeps a stored Claude conversation across the upgrade while excluding native customization (toolSearch=%s)",
  assertStoredConversationSurvivesUpgrade,
);

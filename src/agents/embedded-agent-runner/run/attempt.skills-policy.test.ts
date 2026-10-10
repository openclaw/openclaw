import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInternalSessionEffectsIdentity } from "../../../config/sessions/internal-session-key.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createFixtureSkillEntry } from "../../../skills/test-support/test-helpers.js";
import { runSkillExperienceReview } from "../../../skills/workshop/experience-review.js";
import { createExperienceReviewCandidate } from "../../../skills/workshop/experience-review.test-support.js";
import {
  bindActiveOperatorTurnAuthority,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../cron-creator-authority-context.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { formatToolExecutionGatedMessage } from "../../tool-policy-shared.js";
import type {
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
} from "../../tool-search-types.js";
import { createToolSearchTools } from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createInstalledSkillTools } from "../../tools/installed-skill-tools.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
} from "../prompt-cache-observability.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const reviewRunEmbeddedAgent = vi.hoisted(() => vi.fn());
vi.mock("../../embedded-agent.js", () => ({ runEmbeddedAgent: reviewRunEmbeddedAgent }));
vi.mock("../../../skills/workshop/library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skills/workshop/library.js")>()),
  listWorkshopChanges: async () => [],
}));
const hoisted = getHoisted();
const tempPaths: string[] = [];
const skillsPrompt = [
  "<available_skills>",
  "  <skill>",
  "    <name>demo</name>",
  "    <description>demo description</description>",
  "    <location>/skills/demo/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");
beforeAll(preloadRunEmbeddedAttemptForTests);
beforeEach(() => {
  resetEmbeddedAttemptHarness();
  reviewRunEmbeddedAgent.mockReset();
});
afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  vi.restoreAllMocks();
});

function enableSkills() {
  const entry = createFixtureSkillEntry("demo");
  hoisted.resolveEmbeddedRunSkillEntriesMock.mockReturnValue({
    shouldLoadSkillEntries: true,
    skillEntries: [entry],
    loadSkillEntries: () => [entry],
  });
  hoisted.resolveSkillsPromptForRunMock.mockReturnValue(skillsPrompt);
}

function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    execute,
    parameters: Type.Object(name === "read" ? { path: Type.Optional(Type.String()) } : {}),
  };
}

function sessionTools() {
  return (hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0].customTools ??
    []) as AnyAgentTool[];
}

function sessionTool(name: string) {
  const result = sessionTools().find((entry) => entry.name === name);
  if (!result) {
    throw new Error(`expected the ${name} tool`);
  }
  return result;
}

function toolDigest(
  tools: AnyAgentTool[],
  systemPrompt: string,
  session = { sessionId: "embedded-session", sessionKey: "agent:main:main" },
) {
  return beginPromptCacheObservation({
    messages: [],
    ...session,
    provider: "openai",
    modelId: "gpt-test",
    streamStrategy: "test",
    systemPrompt,
    tools: collectPromptCacheTools(tools),
  }).snapshot.toolDigest;
}

function run(
  overrides: Omit<
    Parameters<typeof createContextEngineAttemptRunner>[0],
    "contextEngine" | "tempPaths"
  >,
) {
  return createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    tempPaths,
    ...overrides,
  });
}

describe("runEmbeddedAttempt skill policy projections", () => {
  it("rebuilds skill prompt inputs from the sandbox workspace for non-rw sandbox runs", async () => {
    const sandboxWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    tempPaths.push(sandboxWorkspace);
    hoisted.resolveSandboxContextMock.mockResolvedValue({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    await run({
      sessionKey: "agent:main:guildchat:channel:test-ctx-engine",
      attemptOverrides: {
        skillsSnapshot: {
          prompt:
            "<available_skills><skill><location>~/.openclaw/skills/smaug/SKILL.md</location></skill></available_skills>",
          skills: [{ name: "smaug" }],
          resolvedSkills: [
            {
              name: "smaug",
              description: "Host copy",
              disableModelInvocation: false,
              filePath: "/Users/alice/.openclaw/skills/smaug/SKILL.md",
              baseDir: "/Users/alice/.openclaw/skills/smaug",
              source: "openclaw-workspace",
              sourceInfo: {
                path: "/Users/alice/.openclaw/skills/smaug/SKILL.md",
                source: "openclaw-workspace",
                scope: "project",
                origin: "top-level",
                baseDir: "/Users/alice/.openclaw/skills/smaug",
              },
            },
          ],
        },
      },
    });

    expect(hoisted.resolveEmbeddedRunSkillEntriesMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ workspaceDir: sandboxWorkspace, skillsSnapshot: undefined }),
    );
    expect(hoisted.resolveSkillsPromptForRunMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        workspaceDir: sandboxWorkspace,
        skillsSnapshot: expect.objectContaining({
          prompt: "",
          skills: [],
          resolvedSkills: [],
          discoverySkills: [],
        }),
      }),
    );
  });

  it("preserves local operator tool schemas in the detached experience review", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-parity-"));
    tempPaths.push(workspaceDir);
    const foregroundPromptContext = {
      agentId: "main",
      agentDir: workspaceDir,
      workspaceDir,
      cwd: workspaceDir,
      sandboxSessionKey: "agent:main:main",
      promptCacheKey: "foreground-cache-prefix",
      reasoningLevel: "on" as const,
      trigger: "manual" as const,
      cronCreatorCallerOrigin: { kind: "local" as const },
    };
    const capture = (runId: string | undefined) => {
      const toolNames = ["skill_workshop"];
      if (bindActiveOperatorTurnAuthority(runId)?.source === "local") {
        toolNames.push("transcripts");
      }
      const tools = toolNames.map((name) =>
        tool(name, async () => ({ content: [{ type: "text", text: "ok" }], details: undefined })),
      );
      return { toolNames, toolDigest: toolDigest(tools, `system:${toolNames.join(",")}`) };
    };
    const runId = "foreground-parity-run";
    const capability = createCronCreatorAuthorityCapability(runId, { kind: "local" });
    assert(capability);
    const foreground = runWithCronCreatorAuthorityCapability(capability, () => capture(runId));
    let review: ReturnType<typeof capture> | undefined;
    reviewRunEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      review = capture(params.runId);
      return { meta: { durationMs: 1 } };
    });
    const candidate = await createExperienceReviewCandidate(
      runId,
      [{ role: "user", content: "Inspect the available tools.", timestamp: 1 }],
      { workspaceDir, modelId: "gpt-test" },
    );
    candidate.ctx.foregroundPromptContext = foregroundPromptContext;
    candidate.config = { skills: { workshop: { autonomous: { mode: "auto" } } } };
    await runSkillExperienceReview(candidate);
    expect(foreground.toolNames).toContain("transcripts");
    expect(review).toEqual(foreground);
  });

  it("preserves tool schemas and source bytes while hiding unreadable draft-review skills", async () => {
    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-parity-"));
    tempPaths.push(sessionRoot);
    const transcriptFile = path.join(sessionRoot, "transcript.jsonl");
    const storeFile = path.join(sessionRoot, "sessions.json");
    const transcript = '{"type":"message","message":{"role":"user","content":"seed"}}\n';
    const store = '{"agent:main:main":{"sessionId":"embedded-session"}}\n';
    await fs.writeFile(transcriptFile, transcript);
    await fs.writeFile(storeFile, store);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: undefined,
    }));
    const codingTools = ["skill_workshop", "message", "read"].map((name) => tool(name, execute));
    const foreground = { sessionId: "embedded-session", sessionKey: "agent:main:main" };
    const reviewSession = resolveInternalSessionEffectsIdentity({
      agentId: "main",
      runId: "skill-workshop-review:prompt-parity",
    });
    const digests: string[] = [];
    let reviewReadOutcomes: PromiseSettledResult<unknown>[] = [];
    for (const review of [false, true]) {
      resetEmbeddedAttemptHarness();
      enableSkills();
      hoisted.createOpenClawCodingToolsMock.mockReturnValue(codingTools);
      const session = review ? reviewSession : foreground;
      await run({
        sessionKey: session.sessionKey,
        sessionPrompt: async () => {
          if (review) {
            reviewReadOutcomes = await Promise.allSettled([
              sessionTool("read").execute("call", {}),
            ]);
          }
        },
        attemptOverrides: {
          disableTools: false,
          disableToolSearch: true,
          disableMessageTool: false,
          reasoningLevel: "on",
          sessionId: session.sessionId,
          sandboxSessionKey: foreground.sessionKey,
          promptCacheKey: "foreground-cache-prefix",
          sessionFile: transcriptFile,
          sessionTarget: { agentId: "main", ...session, storePath: storeFile },
          ...(review
            ? {
                sessionPersistence: "detached" as const,
                toolExecutionAllow: ["skill_workshop"],
                skillWorkshopReviewOf: "agent:main:main",
                disableTrajectory: true,
                verboseLevel: "off" as const,
                trigger: "user" as const,
              }
            : {}),
        },
      });
      expect(sessionTools().some((entry) => entry.name === "message")).toBe(true);
      expect(hoisted.embeddedSystemPromptInputs.at(-1)).toMatchObject({
        skillsPrompt: review ? "" : skillsPrompt,
      });
      digests.push(toolDigest(sessionTools(), hoisted.systemPromptTexts.at(-1) ?? "", session));
    }
    expect(reviewReadOutcomes).toMatchObject([
      {
        status: "fulfilled",
        value: {
          content: [{ text: formatToolExecutionGatedMessage("read", ["skill_workshop"]) }],
        },
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(digests[1]).toBe(digests[0]);
    expect(await fs.readFile(transcriptFile, "utf8")).toBe(transcript);
    expect(await fs.readFile(storeFile, "utf8")).toBe(store);
  });

  it("exposes Code Mode skills only when read is available and executable", async () => {
    const cases: Array<{
      label: string;
      toolsAllow?: string[];
      toolExecutionAllow?: string[];
      skillsPrompt?: string;
      available: boolean;
    }> = [
      { label: "unrestricted", skillsPrompt, available: true },
      { label: "wildcard", toolsAllow: ["*"], skillsPrompt, available: true },
      { label: "mixed wildcard", toolsAllow: ["message", "*"], skillsPrompt, available: true },
      { label: "finite", toolsAllow: ["message"], available: false },
      {
        label: "read executable",
        toolExecutionAllow: ["skill_workshop", "read", "skills_read", "skills_search"],
        skillsPrompt,
        available: true,
      },
      {
        label: "skill read denied",
        toolExecutionAllow: ["read"],
        skillsPrompt,
        available: false,
      },
      {
        label: "read denied",
        toolExecutionAllow: ["skill_workshop"],
        skillsPrompt: "",
        available: false,
      },
      { label: "execution denied", toolExecutionAllow: [], skillsPrompt: "", available: false },
    ];
    for (const testCase of cases) {
      resetEmbeddedAttemptHarness();
      enableSkills();
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options) =>
        createInstalledSkillTools(options?.installedSkills ?? []),
      );
      await run({
        sessionKey: `agent:main:${testCase.label.replace(" ", "-")}`,
        attemptOverrides: {
          disableTools: false,
          toolsAllow: testCase.toolsAllow,
          toolExecutionAllow: testCase.toolExecutionAllow,
          config: { tools: { codeMode: true } },
        },
      });
      expect(hoisted.embeddedSystemPromptInputs.at(-1)).toMatchObject({
        skillsPrompt: testCase.skillsPrompt,
      });
      expect(sessionTool("exec").description.includes("await skills.list()")).toBe(
        testCase.available,
      );
    }
  });

  it("gates catalog-hidden tools during review while skill_workshop stays callable", async () => {
    const sessionManager = SessionManager.inMemory();
    const executed: string[] = [];
    hoisted.createOpenClawCodingToolsMock.mockImplementation((...args: unknown[]) => {
      const options = args[0] as {
        config?: Parameters<typeof createToolSearchTools>[0]["config"];
        toolSearchCatalogRef?: ToolSearchCatalogRef;
        toolSearchCatalogExecutor?: ToolSearchCatalogToolExecutor;
      };
      return [
        ...createToolSearchTools({
          config: options.config,
          runtimeConfig: options.config,
          catalogRef: options.toolSearchCatalogRef,
          executeTool: options.toolSearchCatalogExecutor,
        }),
        ...["skill_workshop", "read"].map((name) =>
          tool(name, async () => {
            executed.push(name);
            return { content: [{ type: "text", text: "ok" }], details: undefined };
          }),
        ),
      ];
    });
    let outcomes: PromiseSettledResult<unknown>[] = [];
    await run({
      sessionKey: "agent:main:main",
      sessionPrompt: async () => {
        const toolCall = sessionTool("tool_call");
        outcomes = await Promise.allSettled([
          toolCall.execute("call-read", { id: "read" }),
          toolCall.execute("call-workshop", { id: "skill_workshop" }),
        ]);
      },
      attemptOverrides: {
        config: { tools: { toolSearch: { enabled: true, mode: "tools" } } },
        disableTools: false,
        sessionManager,
        sessionPersistence: "detached",
        toolExecutionAllow: ["skill_workshop"],
      },
    });
    expect(executed).toEqual(["skill_workshop"]);
    const denial = formatToolExecutionGatedMessage("read", ["skill_workshop"]);
    expect(outcomes).toMatchObject([
      { status: "fulfilled", value: { content: [{ text: expect.stringContaining(denial) }] } },
      { status: "fulfilled" },
    ]);
    const activities = sessionManager.getEntries().flatMap((entry) => {
      const activity = entry.type === "message" && readNestedToolActivity(entry.message);
      return activity ? [activity.details] : [];
    });
    expect(activities).toHaveLength(2);
    expect(activities.find((activity) => activity.toolName === "read")).toMatchObject({
      parentToolCallId: "call-read",
      isError: false,
      result: { content: [{ type: "text", text: denial }] },
    });
    expect(activities.find((activity) => activity.toolName === "skill_workshop")).toMatchObject({
      parentToolCallId: "call-workshop",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  });
});

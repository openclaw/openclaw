import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInternalSessionEffectsIdentity } from "../../../config/sessions/internal-session-key.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createFixtureSkillEntry } from "../../../skills/test-support/test-helpers.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { formatToolExecutionGatedMessage } from "../../tool-policy-shared.js";
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

const hoisted = getHoisted();
const tempPaths: string[] = [];
const foregroundSession = { sessionId: "embedded-session", sessionKey: "agent:main:main" };
const skillsPrompt =
  "<available_skills><skill><name>demo</name>" +
  "<description>demo description</description><location>/skills/demo/SKILL.md</location>" +
  "</skill></available_skills>";
beforeAll(preloadRunEmbeddedAttemptForTests);
beforeEach(() => {
  resetEmbeddedAttemptHarness();
});
afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  vi.restoreAllMocks();
});

function enableSkills() {
  const entry = createFixtureSkillEntry("demo");
  hoisted.prepareWorkspaceSkillsMock.mockResolvedValue([entry]);
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
const ok = () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined });
const fulfilledText = (text: unknown) => ({ status: "fulfilled", value: { content: [{ text }] } });
const promptInput = () => hoisted.embeddedSystemPromptInputs.at(-1);
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-policy-"));
  tempPaths.push(dir);
  return dir;
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

function toolDigest(tools: AnyAgentTool[], systemPrompt: string, session = foregroundSession) {
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

type AttemptOptions = Parameters<typeof createContextEngineAttemptRunner>[0];
function run({
  sessionKey = "agent:main:main",
  sessionPrompt,
  ...attemptOverrides
}: NonNullable<AttemptOptions["attemptOverrides"]> & Pick<AttemptOptions, "sessionPrompt">) {
  return createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    tempPaths,
    sessionKey,
    sessionPrompt,
    attemptOverrides,
  });
}

describe("runEmbeddedAttempt skill policy projections", () => {
  it("rebuilds skill prompt inputs from the sandbox workspace for non-rw sandbox runs", async () => {
    const sandboxWorkspace = await tempDir();
    hoisted.resolveSandboxContextMock.mockResolvedValue({
      enabled: true,
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    await run({
      sessionKey: "agent:main:guildchat:channel:test-ctx-engine",
      skillsSnapshot: {
        prompt:
          "<available_skills><skill><location>~/.openclaw/skills/smaug/SKILL.md</location></skill></available_skills>",
        skills: [{ name: "smaug" }],
        resolvedSkills: [createFixtureSkillEntry("smaug").skill],
      },
    });

    expect(hoisted.prepareWorkspaceSkillsMock).toHaveBeenCalledWith(
      sandboxWorkspace,
      expect.objectContaining({ workspaceOnly: true }),
      expect.any(Function),
    );
    expect(hoisted.resolveSkillsPromptForRunMock.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: sandboxWorkspace,
      skillsSnapshot: {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        discoverySkills: [],
      },
    });
  });

  it("preserves tool schemas and source bytes while hiding unreadable draft-review skills", async () => {
    const sessionRoot = await tempDir();
    const transcriptFile = path.join(sessionRoot, "transcript.jsonl");
    const storeFile = path.join(sessionRoot, "sessions.json");
    const transcript = '{"type":"message","message":{"role":"user","content":"seed"}}\n';
    const store = '{"agent:main:main":{"sessionId":"embedded-session"}}\n';
    await fs.writeFile(transcriptFile, transcript);
    await fs.writeFile(storeFile, store);
    const execute = vi.fn(async () => ok());
    const codingTools = ["skill_workshop", "message", "read"].map((name) => tool(name, execute));
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
      const session = review ? reviewSession : foregroundSession;
      await run({
        sessionKey: session.sessionKey,
        sessionPrompt: async () => {
          if (review) {
            reviewReadOutcomes = await Promise.allSettled([
              sessionTool("read").execute("call", {}),
            ]);
          }
        },
        disableTools: false,
        disableToolSearch: true,
        disableMessageTool: false,
        reasoningLevel: "on",
        sessionId: session.sessionId,
        sandboxSessionKey: foregroundSession.sessionKey,
        promptCacheKey: "foreground-cache-prefix",
        sessionFile: transcriptFile,
        sessionTarget: { agentId: "main", ...session, storePath: storeFile },
        ...(review
          ? {
              sessionPersistence: "detached" as const,
              toolExecutionAllow: ["skill_workshop"],
              inputProvenance: {
                kind: "internal_system" as const,
                sourceTool: "session_fork",
                sourceSessionKey: "agent:main:main",
              },
              disableTrajectory: true,
              verboseLevel: "off" as const,
              trigger: "user" as const,
            }
          : {}),
      });
      expect(sessionTools().some((entry) => entry.name === "message")).toBe(true);
      expect(promptInput()).toMatchObject({ skillsPrompt: review ? "" : skillsPrompt });
      digests.push(toolDigest(sessionTools(), hoisted.systemPromptTexts.at(-1) ?? "", session));
    }
    expect(reviewReadOutcomes).toMatchObject([
      fulfilledText(formatToolExecutionGatedMessage("read", ["skill_workshop"])),
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(digests[1]).toBe(digests[0]);
    expect(await fs.readFile(transcriptFile, "utf8")).toBe(transcript);
    expect(await fs.readFile(storeFile, "utf8")).toBe(store);
  });

  it("keeps admitted Code Mode skill descriptions while enforcing execution restrictions", async () => {
    type Policy = { toolsAllow?: string[]; toolExecutionAllow?: string[] };
    const cases: Array<[string, Policy, string | undefined, boolean]> = [
      ["unrestricted", {}, skillsPrompt, true],
      ["wildcard", { toolsAllow: ["*"] }, skillsPrompt, true],
      ["mixed wildcard", { toolsAllow: ["message", "*"] }, skillsPrompt, true],
      ["finite", { toolsAllow: ["message"] }, skillsPrompt, false],
      [
        "read executable",
        { toolExecutionAllow: ["skill_workshop", "read", "skills_read", "skills_search"] },
        skillsPrompt,
        true,
      ],
      ["skill read denied", { toolExecutionAllow: ["read"] }, skillsPrompt, true],
      ["read denied", { toolExecutionAllow: ["skill_workshop"] }, "", false],
      ["execution denied", { toolExecutionAllow: [] }, "", false],
    ];
    let foregroundDescription: string | undefined;
    let restrictedListResult: unknown;
    for (const [label, policy, expectedPrompt, available] of cases) {
      resetEmbeddedAttemptHarness();
      enableSkills();
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options) =>
        createInstalledSkillTools(options?.installedSkills ?? []),
      );
      await run({
        sessionKey: `agent:main:${label.replace(" ", "-")}`,
        sessionPrompt: async () => {
          if (label === "skill read denied") {
            restrictedListResult = await sessionTool("exec").execute("denied-skills", {
              title: "Check installed skill access",
              code: "return await skills.list();",
            });
          }
        },
        disableTools: false,
        ...policy,
        config: { tools: { codeMode: true } },
      });
      expect(promptInput()).toMatchObject({ skillsPrompt: expectedPrompt });
      const description = sessionTool("exec").description;
      const guidance = {
        toolSchemaDirectoryPrompt: expect.stringContaining("await skills.list()"),
      };
      if (available) {
        expect(promptInput()).toMatchObject(guidance);
      } else {
        expect(promptInput()).not.toMatchObject(guidance);
      }
      if (label === "unrestricted") {
        foregroundDescription = description;
      } else if (label === "skill read denied") {
        expect(description).toBe(foregroundDescription);
      }
    }
    expect(restrictedListResult).toMatchObject({
      details: {
        status: "failed",
        error: expect.stringContaining(formatToolExecutionGatedMessage("skills_search", ["read"])),
      },
    });
  });

  it("gates catalog-hidden tools during review while skill_workshop stays callable", async () => {
    const sessionManager = SessionManager.inMemory();
    const executed: string[] = [];
    hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
      return [
        ...createToolSearchTools({
          config: options?.config,
          runtimeConfig: options?.config,
          catalogRef: options?.toolSearchCatalogRef,
          executeTool: options?.toolSearchCatalogExecutor,
        }),
        ...["skill_workshop", "read"].map((name) =>
          tool(name, async () => {
            executed.push(name);
            return ok();
          }),
        ),
      ];
    });
    let outcomes: PromiseSettledResult<unknown>[] = [];
    await run({
      sessionPrompt: async () => {
        const toolCall = sessionTool("dispatch_action");
        outcomes = await Promise.allSettled([
          toolCall.execute("call-read", { id: "read" }),
          toolCall.execute("call-workshop", { id: "skill_workshop" }),
        ]);
      },
      config: { tools: { toolSearch: { enabled: true, mode: "tools" } } },
      disableTools: false,
      sessionManager,
      sessionPersistence: "detached",
      toolExecutionAllow: ["skill_workshop"],
    });
    expect(executed).toEqual(["skill_workshop"]);
    const denial = formatToolExecutionGatedMessage("read", ["skill_workshop"]);
    expect(outcomes).toMatchObject([
      fulfilledText(expect.stringContaining(denial)),
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

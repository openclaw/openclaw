import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { getInternalToolExecutionPreparer } from "../../../../packages/agent-core/src/internal-hooks.js";
import { resolveInternalSessionEffectsIdentity } from "../../../config/sessions/internal-session-key.js";
import type { ExecAutoReviewTranscript } from "../../../infra/exec-auto-review.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createFixtureSkillEntry } from "../../../skills/test-support/test-helpers.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import type { createOpenClawCodingTools } from "../../agent-tools.js";
import { Agent } from "../../runtime/index.js";
import { type AgentEvent } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { formatToolExecutionGatedMessage } from "../../tool-policy-shared.js";
import { isToolResultError } from "../../tool-result-error.js";
import { createToolSearchTools } from "../../tool-search.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { type AnyAgentTool } from "../../tools/common.js";
import { createInstalledSkillTools } from "../../tools/installed-skill-tools.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { createAgentBackedAttemptSession } from "./attempt-agent.test-support.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
import { createDefaultEmbeddedSession } from "./attempt-spawn-workspace.test-support.js";
const user = (content: string, timestamp = 1) => makeAgentUserMessage({ content, timestamp });

const { hoisted, runAttempt, tempPaths } = useContextEngineAttemptHarness(
  "agent:main:exec-review-transcript",
);

it("reads live messages and releases the review transcript after prompt failure", async () => {
  let reviewTranscript: (() => ExecAutoReviewTranscript | undefined) | undefined;
  const atDispose = vi.fn();
  const seen: ExecAutoReviewTranscript[] = [];
  await runAttempt({
    sessionMessages: [],
    attemptOverrides: {
      disableTools: false,
      config: { logging: { redactPatterns: ["tenant-private-marker"] } },
    },
    createSession: () => {
      const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
        | Parameters<typeof createOpenClawCodingTools>[0]
        | undefined;
      reviewTranscript = options?.exec?.reviewTranscript;
      expect(reviewTranscript).toBeTypeOf("function");
      expect(reviewTranscript?.()).toBeUndefined();
      const session = createDefaultEmbeddedSession({
        prompt: async (activeSession) => {
          const originalUser = {
            ...user("Build the project."),
            __openclaw: { senderIsOwner: true },
          };
          const runtimeUser = user("Hook-rewritten build instructions.");
          const onUserMessagePersisted =
            hoisted.guardSessionManagerMock.mock.calls.at(-1)?.[1]?.onUserMessagePersisted;
          expect(onUserMessagePersisted).toBeTypeOf("function");
          await onUserMessagePersisted?.(originalUser, runtimeUser);
          activeSession.messages = [
            runtimeUser,
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "tenant-private-marker" }],
            }),
          ];
          seen.push(expectDefined(reviewTranscript?.(), "first live transcript"));
          activeSession.messages.push({
            ...user("Keep the existing output directory.", 2),
            provenance: { kind: "inter_session" },
          });
          seen.push(expectDefined(reviewTranscript?.(), "updated live transcript"));
          throw new Error("synthetic prompt failure");
        },
      });
      const dispose = session.dispose;
      session.dispose = () => {
        atDispose(reviewTranscript?.());
        dispose();
      };
      return session;
    },
  });

  expect(seen[0]?.entries).toEqual([
    { kind: "user", origin: "operator", text: "Build the project." },
    { kind: "assistant", text: "tenant-private-marker" },
  ]);
  expect(seen[1]?.entries).toEqual([
    ...seen[0]!.entries,
    { kind: "user", origin: "inter_session", text: "Keep the existing output directory." },
  ]);
  expect(atDispose).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(reviewTranscript?.()).toBeUndefined();
});

const skillsPrompt =
  "<available_skills><skill><name>demo</name><description>demo</description><location>/skills/demo/SKILL.md</location></skill></available_skills>";
function enableSkills() {
  hoisted.prepareWorkspaceSkillsMock.mockResolvedValue([createFixtureSkillEntry("demo")]);
  hoisted.resolveSkillsPromptForRunMock.mockReturnValue(skillsPrompt);
}
function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return { name, label: name, description: name, execute, parameters: Type.Object({}) };
}
const ok = () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined });
const fulfilledText = (text: unknown) => ({ status: "fulfilled", value: { content: [{ text }] } });
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-policy-"));
  tempPaths.push(dir);
  return dir;
}
function sessionTool(name: string) {
  return expectDefined(
    (
      (hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0].customTools ?? []) as AnyAgentTool[]
    ).find((tool) => tool.name === name),
    "expected tool",
  );
}
function run({
  sessionKey = "agent:main:main",
  sessionPrompt,
  ...attemptOverrides
}: NonNullable<Parameters<typeof runAttempt>[0]["attemptOverrides"]> &
  Pick<Parameters<typeof runAttempt>[0], "sessionPrompt"> & { sessionKey?: string }) {
  return runAttempt({ sessionKey, sessionPrompt, attemptOverrides });
}
it("keeps draft-review skill reads gated without changing source bytes", async () => {
  const sessionRoot = await tempDir();
  const transcriptFile = path.join(sessionRoot, "transcript.jsonl"),
    storeFile = path.join(sessionRoot, "sessions.json");
  const transcript = '{"type":"message","message":{"role":"user","content":"seed"}}\n',
    store = '{"agent:main:main":{"sessionId":"embedded-session"}}\n';
  await fs.writeFile(transcriptFile, transcript);
  await fs.writeFile(storeFile, store);
  const execute = vi.fn(async () => ok());
  enableSkills();
  hoisted.createOpenClawCodingToolsMock.mockReturnValue(
    ["skill_workshop", "message", "read"].map((name) => tool(name, execute)),
  );
  const session = resolveInternalSessionEffectsIdentity({
    agentId: "main",
    runId: "skill-workshop-review:read-only",
  });
  let result: unknown;
  await run({
    sessionKey: session.sessionKey,
    sessionPrompt: async () => {
      result = await sessionTool("read").execute("denied-read", {});
    },
    disableTools: false,
    disableToolSearch: true,
    disableMessageTool: false,
    reasoningLevel: "on",
    sessionId: session.sessionId,
    sandboxSessionKey: "agent:main:main",
    promptCacheKey: "foreground-cache-prefix",
    sessionFile: transcriptFile,
    sessionTarget: { agentId: "main", ...session, storePath: storeFile },
    sessionPersistence: "detached",
    toolExecutionAllow: ["skill_workshop"],
    inputProvenance: {
      kind: "internal_system",
      sourceTool: "session_fork",
      sourceSessionKey: "agent:main:main",
    },
    disableTrajectory: true,
    verboseLevel: "off",
    trigger: "user",
  });
  expect(result).toMatchObject({
    content: [{ text: formatToolExecutionGatedMessage("read", ["skill_workshop"]) }],
  });
  expect(execute).not.toHaveBeenCalled();
  expect(await fs.readFile(transcriptFile, "utf8")).toBe(transcript);
  expect(await fs.readFile(storeFile, "utf8")).toBe(store);
});
it("denies Code Mode skill listing outside the execution allowlist", async () => {
  enableSkills();
  hoisted.createOpenClawCodingToolsMock.mockImplementation((options) =>
    createInstalledSkillTools(options?.installedSkills ?? []),
  );
  let result: unknown;
  await run({
    sessionKey: "agent:main:skill-read-denied",
    sessionPrompt: async () => {
      result = await sessionTool("exec").execute("denied-skills", {
        title: "Check installed skill access",
        code: "return await skills.list();",
      });
    },
    disableTools: false,
    toolExecutionAllow: ["read"],
    config: { tools: { codeMode: true } },
  });
  expect(result).toMatchObject({
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
});

function runDeniedAttempt({
  sessionKey = "agent:main:main",
  createSession,
  ...attemptOverrides
}: NonNullable<Parameters<typeof runAttempt>[0]["attemptOverrides"]> &
  Pick<Parameters<typeof runAttempt>[0], "createSession"> & { sessionKey?: string }) {
  return runAttempt({
    sessionKey,
    createSession,
    attemptOverrides: { disableTools: false, ...attemptOverrides },
  });
}
it.each([
  ["direct spawn", "sessions_spawn", undefined, undefined],
  ["raw catalog wait", "agents_wait", 'return await agents_wait({ ids: ["child"] });', "bridge"],
] as const)(
  "does not enter the original preparer or action through denied %s",
  async (_mode, toolName, code, failurePhase) => {
    const sessionManager = SessionManager.inMemory();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const prepare = vi.fn(async (args: unknown) => args);
    const native =
      toolName === "sessions_spawn"
        ? createSessionsSpawnTool({ agentSessionKey: "agent:main:main", config: {} })
        : createAgentsWaitTool({ agentSessionKey: "agent:main:main" });
    native.execute = execute;
    native.prepareBeforeToolCallParams = prepare;
    const source = wrapToolWithBeforeToolCallHook(native);
    expect(getInternalToolExecutionPreparer(source)).toBeDefined();
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([source]);
    const outcomes: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
    const call = {
      type: "toolCall" as const,
      id: "denied",
      name: code ? "exec" : toolName,
      arguments: code
        ? { title: "Inspect denied action", code }
        : toolName === "sessions_spawn"
          ? { task: "inspect" }
          : { ids: ["child"] },
    };
    await runDeniedAttempt({
      // Match the fixture model's window for its full runtime/native tool prompt.
      contextTokenBudget: 8_192,
      toolExecutionAllow: ["read"],
      sessionManager,
      config: { tools: { codeMode: Boolean(code), toolSearch: false } },
      createSession: () =>
        createAgentBackedAttemptSession((model, allTools) => {
          expect(allTools.map((tool) => tool.name)).toContain(code ? "exec" : toolName);
          let turn = 0;
          const agent = new Agent({
            initialState: { model, tools: allTools },
            // AgentSession's result middleware normally classifies structured tool failures.
            afterToolCall: async ({ result, isError }) => ({
              isError: isError || isToolResultError(result),
            }),
            streamFn: () => {
              const first = turn++ === 0;
              const message = makeAgentAssistantMessage({
                content: first ? [call] : [{ type: "text", text: "Denied as expected." }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                stopReason: first ? "toolUse" : "stop",
              });
              return createQueuedAssistantStream((push) => {
                push({ type: "done", reason: first ? "toolUse" : "stop", message });
              });
            },
          });
          agent.subscribe((event) => {
            if (event.type === "tool_execution_end") {
              outcomes.push(event);
            }
          });
          return agent;
        }),
    });
    const outcome = outcomes.find((event) => event.toolName === (code ? "exec" : toolName));
    const denial = formatToolExecutionGatedMessage(toolName, ["read"]);
    const activities = sessionManager.getEntries().flatMap((entry) => {
      const activity = entry.type === "message" && readNestedToolActivity(entry.message);
      return activity ? [activity.details] : [];
    });
    if (failurePhase === "guest") {
      // Swarm globals are absent from the guest, so the script itself fails.
      expect(outcome).toMatchObject({
        isError: true,
        result: { details: { status: "failed", failurePhase, bridgeDispatchStarted: false } },
      });
      expect(activities).toEqual([]);
    } else if (code) {
      // Code Mode dispatched the call, which reached only the gated stand-in.
      expect(activities).toEqual([expect.objectContaining({ toolName })]);
    } else {
      expect(outcome).toMatchObject({
        isError: false,
        result: { content: [expect.objectContaining({ text: denial })] },
      });
      expect(activities).toEqual([]);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  },
);

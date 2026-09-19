// Live OpenAI AgentSession coverage for repeated automatic compaction and long-context opt-in.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { runEmbeddedAgent } from "../embedded-agent-runner.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_OPENAI_COMPACTION);
if (LIVE && !API_KEY) {
  throw new Error("OPENCLAW_LIVE_OPENAI_COMPACTION=1 requires OPENAI_API_KEY");
}
const FULL_CONTEXT = isTruthyEnvValue(process.env.OPENCLAW_LIVE_OPENAI_COMPACTION_FULL);
const describeLive = LIVE ? describe : describe.skip;
const MODEL_ID = process.env.OPENCLAW_LIVE_OPENAI_COMPACTION_MODEL?.trim() || "gpt-5.6-luna";
const STRESS_PROFILE = FULL_CONTEXT
  ? {
      contextTokens: 922_000,
      compactionReserveTokens: 222_000,
      keepRecentTokens: 50_000,
      chunkChars: 900_000,
      maxTurns: 12,
      maxOutputTokens: 128_000,
      providerTimeoutMs: 10 * 60 * 1000,
      testTimeoutMs: 60 * 60 * 1000,
    }
  : {
      contextTokens: 48_000,
      compactionReserveTokens: 8_000,
      keepRecentTokens: 4_000,
      chunkChars: 120_000,
      maxTurns: 8,
      maxOutputTokens: 8_192,
      providerTimeoutMs: 2 * 60 * 1000,
      testTimeoutMs: 10 * 60 * 1000,
    };

const ownedTempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessions: AgentSession[] = [];
const tempRoots: string[] = [];

function createResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function buildContextChunk(targetChars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < targetChars; index += 1) {
    const line =
      `Context stress record ${index}: the copper lighthouse tracks violet weather ` +
      `while patient engineers preserve durable state across each compacted conversation.\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, targetChars);
}

function countCompactions(sessionManager: SessionManager): number {
  return sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
}

async function createLiveSession() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-openai-compaction-live-"));
  tempRoots.push(root);
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const modelsPath = join(root, "models.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    modelsPath,
    `${JSON.stringify(
      {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [
              {
                id: MODEL_ID,
                name: MODEL_ID,
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: STRESS_PROFILE.contextTokens,
                contextTokens: STRESS_PROFILE.contextTokens,
                maxTokens: STRESS_PROFILE.maxOutputTokens,
                compat: {
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
                  supportsTemperature: false,
                },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("openai", API_KEY);
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const model = modelRegistry.find("openai", MODEL_ID) as Model<"openai-responses"> | undefined;
  if (!model) {
    throw new Error(`failed to load live OpenAI model ${MODEL_ID}`);
  }

  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: "medium",
    compaction: {
      enabled: true,
      reserveTokens: STRESS_PROFILE.compactionReserveTokens,
      keepRecentTokens: STRESS_PROFILE.keepRecentTokens,
    },
    retry: {
      enabled: false,
      provider: { timeoutMs: STRESS_PROFILE.providerTimeoutMs, maxRetryDelayMs: 0 },
    },
  });
  const contextChunk = buildContextChunk(STRESS_PROFILE.chunkChars);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "medium",
    noTools: "all",
    resourceLoader: createResourceLoader(),
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
  });
  sessions.push(session);
  return { contextChunk, session, sessionManager };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describeLive("OpenAI AgentSession repeated compaction live", () => {
  it(
    "automatically compacts tool history and resumes from its SQLite checkpoint",
    async () => {
      const root = ownedTempDirs.make("openclaw-budget-compaction-live-");
      const workspaceDir = join(root, "workspace");
      const agentDir = join(root, "agents", "main", "agent");
      const sessionId = randomUUID();
      const sessionKey = `agent:main:compaction-live:${sessionId}`;
      const sessionTarget = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: join(agentDir, "openclaw-agent.sqlite"),
      };
      const marker = `TOOL-MEMORY-${randomUUID()}`;
      const tailMarker = `SYNTHETIC-END-${randomUUID()}`;
      const sourceFile = join(workspaceDir, "synthetic-context.txt");
      const sourceText = `The durable verification marker is ${marker}. Remember it.\n${buildContextChunk(24_000)}\n${tailMarker}\n`;
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(sourceFile, sourceText);
      const modelDefinition = {
        id: MODEL_ID,
        name: MODEL_ID,
        reasoning: true,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        contextTokens: 100_000,
        maxTokens: 1_024,
      };
      const config: OpenClawConfig = {
        // This proof owns compaction and SQLite replay only. Avoid spending its bounded model
        // publication window on unrelated workspace-plugin discovery under release-runner load.
        plugins: { enabled: false, slots: { memory: "none" } },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              auth: "api-key",
              apiKey: API_KEY,
              baseUrl: "https://api.openai.com/v1",
              models: [modelDefinition],
            },
          },
        },
        agents: {
          entries: { main: { agentDir, workspace: workspaceDir } },
          defaults: {
            skipBootstrap: true,
            compaction: {
              enabled: true,
              keepRecentTokens: 1_024,
              memoryFlush: { enabled: false },
            },
            models: {
              [`openai/${MODEL_ID}`]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse" },
              },
            },
          },
        },
        tools: { allow: ["read"], fs: { workspaceOnly: true } },
      };
      const run = async (stage: "seed" | "compact" | "replay", prompt: string) => {
        const allowRead = stage === "seed";
        const startedAt = Date.now();
        process.stderr.write(`[openai-checkpoint-live] stage=${stage} phase=started\n`);
        const runId = randomUUID();
        const runConfig = structuredClone(config);
        const admission = prepareSystemAgentRunAdmission(
          runConfig,
          runId,
          "main",
          "compaction-live",
        );
        try {
          const result = await runEmbeddedAgent({
            preparedRunAdmission: admission,
            sessionId,
            sessionKey,
            sessionTarget,
            workspaceDir,
            agentDir,
            config: runConfig,
            prompt,
            provider: "openai",
            model: MODEL_ID,
            thinkLevel: "low",
            timeoutMs: 2 * 60 * 1000,
            runId,
            disableTools: !allowRead,
            ...(allowRead ? { toolsAllow: ["read"] } : {}),
            onExecutionPhase: ({ phase }) => {
              process.stderr.write(
                `[openai-checkpoint-live] stage=${stage} phase=${phase} elapsedMs=${Date.now() - startedAt}\n`,
              );
            },
            cleanupBundleMcpOnRunEnd: true,
          });
          const text = result.payloads
            ?.map((payload) => payload.text ?? "")
            .join("")
            .trim();
          expect(text).toBe(allowRead ? "STORED" : marker);
          process.stderr.write(
            `[openai-checkpoint-live] stage=${stage} phase=completed elapsedMs=${Date.now() - startedAt} compactions=${result.meta.agentMeta?.compactionCount ?? 0}\n`,
          );
          return result;
        } finally {
          admission.close();
        }
      };
      const reopen = () => {
        disposeOpenClawAgentDatabaseByPath(sessionTarget.storePath);
        return SessionManager.open(sessionTarget, workspaceDir);
      };
      try {
        await run(
          "seed",
          `Read all of ${sourceFile}, remember its durable verification marker, then reply exactly STORED.`,
        );
        const seeded = reopen();
        const history = seeded.buildSessionContext().messages;
        const suppliedText = history
          .filter((message) => message.role === "toolResult")
          .flatMap((message) => message.content)
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        expect(suppliedText).toContain(marker);
        expect(suppliedText).toContain(tailMarker);
        expect(suppliedText.length).toBeGreaterThanOrEqual(sourceText.length);
        expect(
          history
            .filter((message) => message.role === "user")
            .some((message) => JSON.stringify(message.content).includes(marker)),
        ).toBe(false);
        expect(
          history
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content)
            .some((block) => block.type === "text" && block.text.includes(marker)),
        ).toBe(false);
        const last = history.findLast((message) => message.role === "assistant");
        const usage = last?.role === "assistant" ? last.usage.contextUsage : undefined;
        if (usage?.state !== "available") {
          throw new Error("seed turn did not report provider context usage");
        }
        // A smaller configured window creates real host pressure without a large provider request.
        modelDefinition.contextTokens = Math.max(8_000, usage.totalTokens + 1_024);
        expect(modelDefinition.contextTokens).toBeLessThan(48_000);
        await rm(sourceFile);
        await run("compact", "Reply exactly with the durable verification marker from the file.");
        const checkpointSession = reopen();
        const checkpoint = checkpointSession
          .getBranch()
          .findLast((entry) => entry.type === "compaction");
        if (checkpoint?.type !== "compaction") {
          throw new Error("automatic runner compaction did not persist a SQLite checkpoint");
        }
        expect(checkpoint.summary).toContain(marker);
        expect(
          checkpointSession
            .buildSessionContext()
            .messages.filter((message) => message.role === "toolResult"),
        ).toHaveLength(0);
        const checkpointCount = countCompactions(checkpointSession);
        expect(checkpointCount).toBeGreaterThan(0);
        const continued = await run(
          "replay",
          "Repeat the durable verification marker, with no other text.",
        );
        expect(continued.meta.agentMeta?.compactionCount ?? 0).toBe(0);
        const replayedSession = reopen();
        expect(countCompactions(replayedSession)).toBe(checkpointCount);
        const saved = replayedSession.buildSessionContext().messages.at(-1);
        const replayUsage = saved?.role === "assistant" ? saved.usage.contextUsage : undefined;
        if (replayUsage?.state !== "available") {
          throw new Error("replayed runner turn did not report provider context usage");
        }
        expect(replayUsage.totalTokens).toBeGreaterThan(0);
        expect(replayUsage.totalTokens).toBeLessThan(modelDefinition.contextTokens);
        process.stderr.write(
          `[openai-checkpoint-live] budget=${modelDefinition.contextTokens} compactions=${checkpointCount} replayTokens=${replayUsage.totalTokens} sqliteReplay=passed toolMarker=preserved\n`,
        );
      } finally {
        disposeOpenClawAgentDatabaseByPath(sessionTarget.storePath);
      }
    },
    10 * 60 * 1000,
  );

  it(
    "compacts multiple times and preserves durable conversation state",
    async () => {
      const { contextChunk, session, sessionManager } = await createLiveSession();
      const durableMarker = `OPENAI-COMPACTION-${Date.now().toString(36).toUpperCase()}`;
      await session.prompt(
        `Remember durable marker ${durableMarker}. Reply with exactly ${durableMarker}.`,
      );

      let maximumObservedPromptTokens = 0;
      for (
        let turn = 1;
        turn <= STRESS_PROFILE.maxTurns && countCompactions(sessionManager) < 2;
        turn += 1
      ) {
        const acknowledgement = `OPENAI-CONTEXT-${turn}-OK`;
        await session.prompt(
          `${contextChunk}\n\nReply with exactly ${acknowledgement} and nothing else.`,
        );
        const finalAssistant = session.messages.findLast(
          (message) => message.role === "assistant" && message.stopReason === "stop",
        );
        expect(finalAssistant).toBeDefined();
        if (finalAssistant?.role !== "assistant") {
          throw new Error(`missing final assistant message for turn ${turn}`);
        }
        expect(session.getLastAssistantText()).toContain(acknowledgement);
        const promptTokens =
          finalAssistant.usage.contextUsage?.state === "available"
            ? finalAssistant.usage.contextUsage.promptTokens
            : finalAssistant.usage.input +
              finalAssistant.usage.cacheRead +
              finalAssistant.usage.cacheWrite;
        maximumObservedPromptTokens = Math.max(maximumObservedPromptTokens, promptTokens);
        process.stderr.write(
          `[openai-compaction-live] turn=${turn} compactions=${countCompactions(sessionManager)} prompt=${promptTokens}\n`,
        );
      }

      expect(countCompactions(sessionManager)).toBeGreaterThanOrEqual(2);
      if (FULL_CONTEXT) {
        expect(maximumObservedPromptTokens).toBeGreaterThan(272_000);
      }

      await session.prompt(`Reply with exactly the durable marker I asked you to remember.`);
      expect(session.getLastAssistantText()?.trim()).toBe(durableMarker);
    },
    STRESS_PROFILE.testTimeoutMs,
  );
});

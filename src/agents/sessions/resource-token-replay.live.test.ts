// Real provider turns through AgentSession's dispatcher and durable SQLite replay.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { extractToolResultText, sanitizeToolResult } from "../embedded-agent-tool-results.js";
import { isLiveTestEnabled } from "../live-test-config.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { redactTranscriptMessage } from "../transcript-redact.js";
import type { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import type { ToolDefinition } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const live = isLiveTestEnabled() && Boolean(apiKey);
const tempDirs = createTempDirTracker();
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  resetSecretRedactionRegistryForTest();
  for (const dir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir: dir });
  }
  tempDirs.cleanup();
});

it.runIf(live)(
  "a real model reuses a saved resource through the resumed AgentSession tool dispatcher",
  async () => {
    if (!apiKey) {
      throw new Error("Live resource replay requires ANTHROPIC_API_KEY");
    }
    const dir = tempDirs.make("openclaw-live-resource-replay-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      const cwd = path.join(dir, "workspace");
      const agentDir = path.join(dir, "agent");
      await mkdir(cwd, { recursive: true });
      const modelId = process.env.OPENCLAW_LIVE_AGENT_SESSION_MODEL || "claude-haiku-4-5";
      const modelsPath = path.join(dir, "models.json");
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: {
            anthropic: {
              baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 512,
                },
              ],
            },
          },
        }),
      );
      const authStorage = AuthStorage.inMemory();
      authStorage.setRuntimeApiKey("anthropic", apiKey);
      const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
      const model = modelRegistry.find("anthropic", modelId);
      if (!model) {
        throw new Error("Live resource replay model is unavailable");
      }
      const target = {
        agentId: "main",
        sessionId: "live-resource-replay",
        sessionKey: "agent:main:live-resource-replay",
        storePath: path.join(agentDir, "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      // Neither prompt nor tool schema contains this random identifier or file contents.
      // Avoid the existing 40-character AWS secret-value signature for the usable reference.
      const reference = `Reference${randomUUID().replaceAll("-", "")}`;
      const contents = `RESOURCE_READ_OK_${randomUUID()}`;
      await writeFile(path.join(cwd, `${reference}.txt`), contents);
      const credential = "SyntheticOpaqueCredential1234567890";
      const registered = "SyntheticRegisteredSecret1234567890";
      const recognized = `sk-${"SYNTHETIC".repeat(8)}`;
      const awsShaped = `Resource${randomUUID().replaceAll("-", "")}`;
      registerSecretValueForRedaction(registered);
      const executions: string[] = [];
      const lookupSchema = Type.Object({});
      const lookup: ToolDefinition<typeof lookupSchema> = {
        name: "lookup_resource",
        label: "Lookup resource",
        description: "Look up the resource identifier. Does not read the resource contents.",
        parameters: lookupSchema,
        execute: async () => {
          executions.push("lookup_resource");
          const details = {
            doc_token: reference,
            access_token: { doc_token: credential },
            registered: { doc_token: registered },
            recognized: { doc_token: recognized },
            awsShaped: { doc_token: awsShaped },
          };
          const text = extractToolResultText(sanitizeToolResult({ type: "json", ...details }));
          if (!text) {
            throw new Error("Resource lookup produced no model-visible text");
          }
          expect(text, "lookup output preserves resource reference").toContain(reference);
          return { content: [{ type: "text", text }], details };
        },
      };
      const readSchema = Type.Object({ doc_token: Type.String() });
      const read: ToolDefinition<typeof readSchema> = {
        name: "read_resource",
        label: "Read resource",
        description: "Read the resource using the exact doc_token from an earlier lookup.",
        parameters: readSchema,
        execute: async (_id, params) => {
          executions.push("read_resource");
          // Prevent arbitrary paths and prove the dispatcher received the saved identifier.
          if (params.doc_token !== reference) {
            throw new Error("Resource identifier did not survive session replay");
          }
          return {
            content: [
              { type: "text", text: await readFile(path.join(cwd, `${reference}.txt`), "utf8") },
            ],
            details: {},
          };
        },
      };
      const providerPayloads: string[] = [];
      async function openSession(customTools: ToolDefinition[]) {
        const manager = SessionManager.open(target, cwd);
        installSessionToolResultGuard(manager, {
          transformMessageForPersistence: (message) => redactTranscriptMessage(message),
        });
        const settingsManager = SettingsManager.inMemory({
          defaultThinkingLevel: "off",
          compaction: { enabled: false },
          retry: { enabled: false, provider: { timeoutMs: 45_000, maxRetryDelayMs: 0 } },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt:
            "Follow the user request and use the provided tools. Never echo identifiers or credentials.",
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          model,
          modelRegistry,
          authStorage,
          sessionManager: manager,
          settingsManager,
          resourceLoader,
          noTools: "builtin",
          customTools,
          thinkingLevel: "off",
        });
        sessions.push(session);
        const onPayload = session.agent.onPayload;
        session.agent.onPayload = async (payload, activeModel) => {
          const replacement = await onPayload?.(payload, activeModel);
          // Observe the transport payload, not SDK-only metadata such as tool details.
          providerPayloads.push(JSON.stringify(replacement === undefined ? payload : replacement));
          return replacement;
        };
        return session;
      }
      const first = await openSession([lookup]);
      await first.prompt(
        "Call lookup_resource exactly once. Do not repeat its identifier. After the lookup, reply only READY.",
      );
      expect(executions).toEqual(["lookup_resource"]);
      expect(first.getLastAssistantText()?.trim()).toBe("READY");
      first.sessionManager.flushPendingPersistence();
      expect(JSON.stringify(first.messages), "live history preserves resource reference").toContain(
        reference,
      );
      expect(
        JSON.stringify(loadTranscriptEventsSync(target)),
        "durable history preserves resource reference",
      ).toContain(reference);
      first.dispose();
      closeOpenClawAgentDatabases(dir);
      const firstResumePayload = providerPayloads.length;
      const resumed = await openSession([read]);
      expect(JSON.stringify(resumed.messages)).toContain(reference);
      // The lookup tool is absent now; the model must obtain the identifier from SQLite history.
      await resumed.prompt(
        "Read the resource you looked up earlier using read_resource exactly once, and reply with its exact contents.",
      );
      expect(executions).toEqual(["lookup_resource", "read_resource"]);
      expect(resumed.getLastAssistantText()).toContain(contents);
      expect(providerPayloads[firstResumePayload]).toContain(reference);
      resumed.sessionManager.flushPendingPersistence();
      const stored = JSON.stringify(loadTranscriptEventsSync(target));
      expect(stored).toContain(contents);
      for (const secret of [credential, registered, recognized, awsShaped]) {
        expect(providerPayloads.every((payload) => !payload.includes(secret))).toBe(true);
        expect(stored.includes(secret)).toBe(false);
      }
      // Sanitized proof contains no endpoint, credential, or generated identifier.
      console.log(
        "LIVE_REPLAY_PASS lookup=1 database_connection_reopened=true resumed_dispatch=1 resource_read=true credential_controls=true",
      );
    });
  },
  120_000,
);

/**
 * The session owner caps every stored summary at MAX_COMPACTION_SUMMARY_CHARS before it
 * appends the boundary, and the safeguard audits its summary before that cap runs. So the
 * audited artifact has to be the stored one: on a large context window the safeguard must
 * still finalize inside the owner's cap, or the cap cuts the tail sections the audit passed.
 * The boundary is written through the SQLite transcript, reopened from disk, and the next
 * request is built from it.
 */
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import type { ExtensionAPI } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
registerAgentSessionLoopTestLifecycle();

const LATEST_ASK = "report the deployment status";
const IDENTIFIER = "/tmp/compaction-owner-budget.log";
/** A structured summary whose Decisions alone is well over the owner's 16,000-char cap. */
const OVERSIZED_SUMMARY = [
  "## Decisions",
  "x".repeat(60_000),
  "## Open TODOs",
  "None.",
  "## Constraints/Rules",
  "Follow rules.",
  "## Pending user asks",
  `${LATEST_ASK} ${IDENTIFIER}`,
  "## Exact identifiers",
  IDENTIFIER,
].join("\n");

type SessionBeforeCompactResult = { compaction?: { summary?: string } } | undefined;

describe("AgentSession safeguard summary budget", () => {
  it("stores the audited safeguard summary unchanged on a large context window", async () => {
    // A synthetic API plus the registered stream keep the real summarizer offline.
    const model: Model = {
      ...testModel,
      api: "compaction-test-api",
      contextWindow: 300_000,
      maxTokens: 8_192,
    };
    const dir = tempDirs.make("openclaw-safeguard-owner-budget-");
    const target = {
      agentId: "main",
      sessionId: "safeguard-owner-budget",
      sessionKey: "agent:main:safeguard-owner-budget",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const sessionManager = SessionManager.open(target, dir);
    // ~100k chars of summarizable history: enough that a budget scaled from the window
    // would exceed the owner's cap and let the whole 60k-char Decisions section through.
    for (let turn = 0; turn < 10; turn += 1) {
      sessionManager.appendMessage({
        role: "user",
        content: `turn ${turn} ${"h".repeat(10_000)}`,
        timestamp: 2 * turn + 1,
      });
      sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: `answer ${turn}` }]),
        timestamp: 2 * turn + 2,
      });
    }
    sessionManager.appendMessage({
      role: "user",
      content: `${LATEST_ASK} ${IDENTIFIER}`,
      timestamp: 30,
    });
    sessionManager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: "working on it" }]),
      timestamp: 31,
    });
    sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 32 });
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
    });
    // Record what the safeguard audited and returned, before the owner's cap sees it.
    const audited: string[] = [];
    const recordingSafeguard = (api: ExtensionAPI) =>
      compactionSafeguardExtension(
        new Proxy(api, {
          get(inner, key, receiver) {
            if (key !== "on") {
              return Reflect.get(inner, key, receiver);
            }
            const on = inner.on.bind(inner) as (
              event: string,
              handler: (event: unknown, ctx: unknown) => unknown,
            ) => void;
            return (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
              on(event, async (hookEvent, ctx) => {
                const result = (await handler(hookEvent, ctx)) as SessionBeforeCompactResult;
                const summary = result?.compaction?.summary;
                if (event === "session_before_compact" && summary !== undefined) {
                  audited.push(summary);
                }
                return result;
              });
          },
        }),
      );
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request in compaction test"));
    const eventBus = createEventBus();
    try {
      const resourceLoader = createResourceLoader();
      const extensions = resourceLoader.getExtensions();
      extensions.extensions.push(
        await loadExtensionFromFactory(
          recordingSafeguard,
          sessionManager.getCwd(),
          eventBus,
          extensions.runtime,
        ),
      );
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: OVERSIZED_SUMMARY }]),
        ),
      );
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 1 },
        retry: { enabled: false },
      });
      const { session } = await createTestSession({
        model,
        sessionManager,
        resourceLoader,
        settingsManager,
      });

      await session.compact();
      session.dispose();
      sessionManager.flushPendingPersistence();

      // Reopen from disk: what the next turn gets is what the owner stored.
      const databasePath = resolveSqliteTargetFromSessionStorePath(target.storePath).path;
      expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
      const reopened = SessionManager.open(target, dir);
      const stored = reopened.getBranch().findLast((entry) => entry.type === "compaction");
      if (stored?.type !== "compaction") {
        throw new Error("expected a stored compaction boundary");
      }
      // The tail sections the audit requires must survive into the stored boundary.
      expect(stored.summary).toContain("## Pending user asks");
      expect(stored.summary).toContain("## Exact identifiers");
      expect(stored.summary).toContain(IDENTIFIER);
      expect(audited).toHaveLength(1);
      expect(stored.summary).toBe(audited[0]);
      expect(stored.summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
      // The next request is built from the reopened boundary and carries the same facts.
      const requests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        requests.push(context);
        return createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "status reported" }]),
        );
      });
      const next = await createTestSession({ model, sessionManager: reopened, settingsManager });
      await next.session.prompt("next question");
      next.session.dispose();
      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]?.messages);
      expect(request).toContain("## Exact identifiers");
      expect(request).toContain(IDENTIFIER);
      expect(request).toContain("next question");
      expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "status reported" }],
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      setCompactionSafeguardRuntime(sessionManager, null);
      eventBus.clear();
      network.mockRestore();
    }
  });
});

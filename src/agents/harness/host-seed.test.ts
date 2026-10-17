import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { compactEmbeddedAgentSessionDirect } from "../embedded-agent-runner/compact.js";
import { readCompactionAccountingRecorder } from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import {
  estimateCompactionHistoryTokens,
  resolveCompactionRetentionBudget,
} from "../sessions/compaction/request-budget.js";
import { withSessionCompactionPersistenceAsync } from "../sessions/session-compaction-persistence.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { prepareHarnessContextMedia } from "./context-media-runtime.js";
import type { AgentHarnessContextMediaRequest } from "./host-capability-types.js";
import { bindBoundedSeed } from "./host-seed.js";

// mock-isolation: Keep real transcript and atomic persistence, replacing only summary model execution.
vi.mock("../embedded-agent-runner/compact.js", () => ({
  compactEmbeddedAgentSessionDirect: vi.fn(),
}));

function seedTarget(storePath: string, sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}

const allowance = {
  oldBytes: 1000,
  maxBytes: 8192,
  contextTokens: 128,
  requestTokens: 128,
  expectedBytes: 512,
};
type SeedCase = Partial<typeof allowance> & {
  name: string;
  summary?: string;
  expected?: number;
  revoke?: boolean;
  replaceWriter?: boolean;
  decline?: boolean;
  oversizedSummary?: boolean;
  oversizedTail?: boolean;
};

const generatedSummary = "covered old discussion; recent request";
it.each<SeedCase>([
  { name: "small history", oldBytes: 20, summary: undefined, expected: 0 },
  { name: "unsummarized history", oversizedTail: true },
  { name: "declined summary", summary: "existing", decline: true, oversizedTail: true },
  { ...allowance, name: "narrow delivery allowance", contextTokens: 1024 },
  { ...allowance, name: "larger allowance cannot widen host", requestTokens: 1024 },
  { ...allowance, name: "invalid allowance is ignored", requestTokens: Infinity },
  { ...allowance, name: "oversized summary is bounded again", oversizedSummary: true },
  {
    name: "omitted existing summary",
    summary: "summary ".repeat(1024),
    expected: 0,
  },
  {
    name: "unsummarized retained tail",
    summary: "older prefix covered",
  },
  { name: "revoked source", revoke: true },
  { name: "replaced writer", replaceWriter: true },
])(
  "prepares a bounded seed for $name",
  async ({
    name,
    oldBytes = 4096,
    summary,
    expected = 1,
    revoke,
    replaceWriter,
    decline,
    maxBytes = 1024,
    contextTokens,
    requestTokens,
    expectedBytes = maxBytes,
    oversizedSummary,
    oversizedTail,
  }) => {
    await withOpenClawTestState({ label: "native-seed" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const target = seedTarget(state.statePath("sessions.sqlite"), "seed");
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        activeWriterRunId: "seed-writer",
        transcriptByteCompactionLatch: { activeBytes: 4096, maxBytes: 1024, sessionId: "seed" },
      });
      let manager = await SessionManager.openAsync(target, state.workspaceDir);
      const old = expectDefined(
        await manager.appendMessageAsync(makeUserMessage("old".repeat(oldBytes), 1)),
        "old seed turn",
      );
      const recent = expectDefined(
        await manager.appendMessageAsync(makeUserMessage("recent request", 2)),
        "recent seed turn",
      );
      if (oversizedTail) {
        await manager.appendMessageAsync(
          makeAssistantMessageFixture({
            content: [{ type: "text", text: `TAIL_EVIDENCE ${"tail".repeat(50_000)}` }],
          }),
        );
      }
      if (summary) {
        await manager.appendCompactionAsync(
          summary,
          name === "unsummarized retained tail" ? old : recent,
          2048,
        );
      }
      const recorder = createUserTurnTranscriptRecorder({
        message: { ...makeUserMessage("pending", 3), idempotencyKey: "seed:pending" },
        target: { ...target, sessionEntry: loadSessionEntry(target), cwd: state.workspaceDir },
      });
      await recorder.persistApproved();
      manager = await SessionManager.openAsync(target, state.workspaceDir);
      const originalEvents = loadTranscriptEventsSync(target);
      const assertCurrent = vi.fn();
      const compact = vi.mocked(compactEmbeddedAgentSessionDirect);
      compact.mockReset();
      compact.mockImplementationOnce(async (params, persist) => {
        if (decline) {
          return { ok: false, compacted: false, reason: "fixture declines compaction" };
        }
        if (revoke) {
          assertCurrent.mockImplementation(() => {
            throw new Error("native binding revoked");
          });
        }
        if (replaceWriter) {
          await upsertSessionEntryCore(target, { activeWriterRunId: "replacement-writer" });
        }
        const constraints = readCompactionAccountingRecorder(params.contextEngineRuntimeContext);
        const budget = constraints?.requestBudget;
        const result = prepareCompaction(
          manager.getBranch(),
          DEFAULT_COMPACTION_SETTINGS,
          "unresolved",
          {
            preserveFromEntryId: constraints?.pendingUserEntryId,
            ...(budget
              ? {
                  budget: {
                    ...resolveCompactionRetentionBudget(budget, []),
                    estimateTokens: (message: AgentMessage) =>
                      estimateCompactionHistoryTokens([message], budget),
                  },
                }
              : {}),
          },
        );
        const prepared = expectDefined(result.ok ? result.value : undefined, "prepared compaction");
        expect(
          JSON.stringify([
            ...prepared.messagesToSummarize,
            ...prepared.turnPrefixMessages,
          ]).includes(oversizedTail ? "TAIL_EVIDENCE" : "recent request"),
        ).toBe(true);
        await withSessionCompactionPersistenceAsync(manager, persist, () =>
          manager.appendCompactionAsync(
            oversizedSummary ? "generated".repeat(1000) : generatedSummary,
            prepared.firstKeptEntryId,
            2048,
          ),
        );
        return { ok: true, compacted: true };
      });
      const maybePrepare = bindBoundedSeed(
        {
          sessionTarget: { ...target, expectedWriterRunId: "seed-writer" },
          workspaceDir: state.workspaceDir,
          contextTokenBudget: contextTokens,
          config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: maxBytes } } } },
          userTurnTranscriptRecorder: recorder,
        },
        () => {},
        async (run) => run(),
      )?.prepareBoundedSeed;
      const prepare = expectDefined(maybePrepare, "missing seed capability");
      const result = prepare({ assertCurrent, tokenBudget: requestTokens });
      if (revoke || replaceWriter) {
        await expect(result).rejects.toThrow(
          revoke ? "native binding revoked" : /writer|claim|changed/i,
        );
        expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
      } else {
        const seed = await result;
        expect(Buffer.byteLength(JSON.stringify(seed))).toBeLessThanOrEqual(expectedBytes);
        if (!expected && !oversizedTail) {
          expect(seed).toContainEqual(makeUserMessage("recent request", 2));
        }
        if (expected && !decline) {
          if (oversizedSummary) {
            expect(seed.some((message) => message.role === "compactionSummary")).toBe(false);
          } else {
            expect(seed).toContainEqual(
              expect.objectContaining({
                role: "compactionSummary",
                summary: generatedSummary,
              }),
            );
          }
          expect(loadSessionEntry(target)?.compactionCount).toBe(1);
          expect(loadSessionEntry(target)?.transcriptByteCompactionLatch).toBeUndefined();
        }
        if (decline) {
          expect(loadTranscriptEventsSync(target)).toEqual(originalEvents);
          expect(JSON.stringify(seed)).toContain("Older history outside that window is omitted");
          expect(seed).toContainEqual(
            expect.objectContaining({ role: "compactionSummary", summary }),
          );
        }
        expect(loadTranscriptEventsSync(target)).toEqual(expect.arrayContaining(originalEvents));
      }
      expect(compact).toHaveBeenCalledTimes(expected);
    });
  },
);

it.each([false, true])(
  "preserves the admitted task only for a refresh seed (%s)",
  async (refresh) => {
    await withOpenClawTestState({ label: "native-refresh-seed" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const target = seedTarget(state.statePath("sessions.sqlite"), "refresh");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      await manager.appendMessageAsync(makeUserMessage("Earlier history".repeat(600), 1));
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          ...makeUserMessage("ORIGINAL_ADMITTED_TASK", 2),
          idempotencyKey: "refresh:user",
        },
        target: { ...target, sessionEntry: loadSessionEntry(target), cwd: state.workspaceDir },
      });
      const persisted = expectDefined(await recorder.persistApproved(), "persisted original task");
      const stale = makeAssistantMessageFixture({
        content: [{ type: "text", text: "stale persisted tail" }],
      });
      const current = makeAssistantMessageFixture({
        content: [{ type: "text", text: "authoritative refresh handoff".repeat(600) }],
      });
      const afterAdmission = await SessionManager.openAsync(target, state.workspaceDir);
      await afterAdmission.appendMessageAsync(stale);
      const maybePrepare = bindBoundedSeed(
        {
          sessionTarget: target,
          workspaceDir: state.workspaceDir,
          config: {
            agents: {
              defaults: { compaction: { enabled: false, maxActiveTranscriptBytes: 8192 } },
            },
          },
          userTurnTranscriptRecorder: recorder,
          ...(refresh ? { pluginRuntimeRefreshMessages: [persisted.message, current] } : {}),
        },
        () => {},
        async (run) => run(),
      )?.prepareBoundedSeed;
      const prepare = expectDefined(maybePrepare, "fixture has no seed capability");
      const seed = await prepare({ assertCurrent: () => {} });
      expect(JSON.stringify(seed)).toContain("Older history outside that window is omitted");
      expect(
        seed.filter(
          (message) => message.role === "user" && message.content === "ORIGINAL_ADMITTED_TASK",
        ),
      ).toHaveLength(refresh ? 1 : 0);
      if (refresh) {
        expect(seed).toContainEqual(current);
        expect(seed).not.toContainEqual(stale);
        await expect(prepare({ assertCurrent: () => {}, tokenBudget: 1024 })).rejects.toThrow(
          "Active native continuation exceeds the history delivery allowance",
        );
      }
    });
  },
);

it.each([1, 2])(
  "bounds restored images and reuses their prepared snapshot (%s)",
  async (imageCount) => {
    await withOpenClawTestState({ label: "native-media-seed" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const target = seedTarget(state.statePath("sessions.sqlite"), "media");
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const paths = Array.from({ length: imageCount }, (_, index) =>
        path.join(state.workspaceDir, `image-${index}.png`),
      );
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        "base64",
      );
      await Promise.all(paths.map((file) => writeFile(file, png)));
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const imageTurn: PersistedUserTurnMessage = {
        ...makeUserMessage("Stored image question", 1),
        __openclaw: {
          media: paths.map((file) => ({ path: file, contentType: "image/png", kind: "image" })),
        },
      };
      await manager.appendMessageAsync(imageTurn);
      const recent = expectDefined(
        await manager.appendMessageAsync(makeUserMessage("Recent text", 2)),
        "recent media turn",
      );
      const compact = vi.mocked(compactEmbeddedAgentSessionDirect).mockReset();
      compact.mockImplementationOnce(async (_params, persist) => {
        await withSessionCompactionPersistenceAsync(manager, persist, () =>
          manager.appendCompactionAsync("Image question summarized", recent, 4000),
        );
        return { ok: true, compacted: true };
      });
      const restore = vi.fn((request: AgentHarnessContextMediaRequest) =>
        prepareHarnessContextMedia({
          ...request,
          workspaceDir: state.workspaceDir,
          modelInput: ["text", "image"],
          assertCurrent: () => {},
        }),
      );
      const media = { capabilities: { prepareContextMedia: restore } };
      const source = new AbortController();
      const bound = bindBoundedSeed(
        {
          sessionTarget: target,
          workspaceDir: state.workspaceDir,
          contextTokenBudget: 8192,
          config: { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "20mb" } } } },
        },
        () => {},
        async (run) => run(),
        source.signal,
        media,
      );
      const prepare = expectDefined(bound?.prepareBoundedSeed, "media seed capability");
      const seed = await prepare({
        assertCurrent: () => {},
        tokenBudget: imageCount === 1 ? 4096 : 2048,
      });
      const imageMessage = seed.find(
        (message) => message.role === "user" && message.content === "Stored image question",
      );
      if (imageCount === 2) {
        expect(imageMessage).toBeUndefined();
        expect(compact).toHaveBeenCalledOnce();
      } else {
        const fittingImage = expectDefined(imageMessage, "Fitting image turn was omitted");
        const calls = restore.mock.calls.length;
        await Promise.all(paths.map((file) => unlink(file)));
        const restoreFromSeed =
          bound?.prepareContextMedia ?? media.capabilities.prepareContextMedia;
        const prepared = await restoreFromSeed({ message: fittingImage, maxChars: 8192 });
        expect(prepared.images).toHaveLength(1);
        expect(restore).toHaveBeenCalledTimes(calls);
        expect(compact).not.toHaveBeenCalled();
        source.abort(new Error("seed source closed"));
        await expect(restoreFromSeed({ message: fittingImage, maxChars: 8192 })).rejects.toThrow(
          "seed source closed",
        );
        await expect(prepare({ assertCurrent: () => {} })).rejects.toThrow("seed source closed");
        expect(restore).toHaveBeenCalledTimes(calls);
      }
    });
  },
);

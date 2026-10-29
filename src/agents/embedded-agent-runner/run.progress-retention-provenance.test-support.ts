import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessages,
  forkSessionFromParentTranscript,
  loadTranscriptEvents,
  withTranscriptWriteSequence,
  rewriteTranscriptMessageAtAnchor,
} from "../../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../../config/sessions/session-actor-storage-binding.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../infra/agent-run-registry.js";
import type { AgentMessage } from "../runtime/index.js";
import * as resultGuard from "../session-tool-result-guard.js";
import { SessionManager } from "../sessions/session-manager.js";
import * as embeddedExtensions from "./extensions.js";
import { captureProgressWorkReader } from "./run/progress-work.js";

/** Actual extension dispatch and external writer-hook I/O, without replacing native persistence. */
export function installNativeProvenanceHooks(mode: string) {
  const storedResults: Extract<AgentMessage, { role: "toolResult" }>[] = [];
  let extensionCalls = 0;
  const factories = embeddedExtensions.buildEmbeddedExtensionFactories;
  const extensionHook = vi
    .spyOn(embeddedExtensions, "buildEmbeddedExtensionFactories")
    .mockImplementation((params) => [
      ...factories(params),
      (api) => {
        api.on("message_end", (event) => {
          if (event.message.role !== "toolResult") {
            return undefined;
          }
          extensionCalls++;
          const message = structuredClone(event.message);
          Reflect.deleteProperty(message, "__openclaw");
          if (message.toolCallId === "routine-read") {
            if (mode === "provenance-extension-rename") {
              message.toolName = "renamed";
            }
            if (mode === "provenance-extension-id") {
              message.toolCallId = "substituted-call";
            }
            if (mode === "provenance-extension-error") {
              message.isError = true;
            }
            if (mode === "provenance-extension-role") {
              return {
                message: {
                  role: "user",
                  content: "Extension replaced native result",
                  timestamp: message.timestamp,
                },
              };
            }
          }
          return { message };
        });
      },
    ]);
  let hookCalls = 0;
  const installGuard = resultGuard.installSessionToolResultGuard;
  // Replace only the untrusted hook's I/O; actual guard preparation and append remain native.
  const writerHook = vi
    .spyOn(resultGuard, "installSessionToolResultGuard")
    .mockImplementation((manager, options) =>
      installGuard(manager, {
        ...options,
        captureMessageContext: () => {
          const context = options?.captureMessageContext?.();
          if (!context) {
            throw new Error("Missing native writer context");
          }
          return {
            ...context,
            onMessagePersisted(message) {
              if (message.role === "toolResult") {
                storedResults.push(message);
              }
              return context.onMessagePersisted?.(message);
            },
            beforeMessageWriteHook: (event) => {
              const previous = context.beforeMessageWriteHook?.(event);
              if (previous?.block) {
                return previous;
              }
              const message = previous?.message ?? event.message;
              if (message.role === "toolResult") {
                hookCalls++;
              }
              return {
                message: {
                  ...message,
                  ...(message.role === "toolResult" &&
                  message.toolCallId === "routine-read" &&
                  mode === "provenance-rename"
                    ? { toolName: "renamed" }
                    : {}),
                  ...(message.role === "toolResult" && mode === "provenance-native-failure"
                    ? { isError: false }
                    : {}),
                  __openclaw: {
                    nativeInvocation: { v: 1, qualification: "read", runId: "forged" },
                  },
                },
              };
            },
          };
        },
      }),
    );

  return {
    counts: () => ({ extensionCalls, hookCalls }),
    nativeResult: () => storedResults[0],
    restore() {
      extensionHook?.mockRestore();
      writerHook?.mockRestore();
    },
  };
}

/** Public callers cannot copy a genuine native fact into a new canonical entry. */
export async function expectNativeProvenanceIngress(
  target: Parameters<typeof SessionManager.openAsync>[0],
  workspace: string,
  metadata: unknown,
  nativeResult: Extract<AgentMessage, { role: "toolResult" }> | undefined,
  memoryMode: boolean,
) {
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(target, authority);
  if (memoryMode && (!memory?.owner || !target.sessionKey)) {
    throw new Error("Missing required native memory import owner");
  }
  const manager = await SessionManager.openAsync(target, workspace);
  const copied = {
    ...makeTextToolResult("copied-native", "read", "copied", false, 2),
    __openclaw: metadata,
  };
  if (!nativeResult) {
    throw new Error("No native persisted result callback");
  }
  const returnedCopy = await manager.appendMessageWithTranscriptAnchorAsync(nativeResult);
  const raw = await manager.appendMessageWithTranscriptAnchorAsync(copied);
  const ordinary = await manager.appendMessageAsync({
    ...copied,
    toolCallId: "ordinary-native",
  });
  const publicAppend = await appendTranscriptMessage(target, {
    message: { ...copied, toolCallId: "public-native" },
  });
  const sequenced = await withTranscriptWriteSequence(target, (writer) =>
    writer.appendMessageWithMessageSequence({
      message: { ...copied, toolCallId: "sequenced-native" },
    }),
  );
  const batch = await appendTranscriptMessages(target, {
    messages: [
      { eventId: "batch-native-a", message: { ...copied, toolCallId: "batch-native-a" } },
      { eventId: "batch-native-b", message: { ...copied, toolCallId: "batch-native-b" } },
    ],
  });
  expect(batch.map((entry) => entry.appended)).toEqual([true, true]);
  const replay = await appendTranscriptMessages(target, {
    messages: [{ eventId: "batch-native-a", message: { ...copied, toolCallId: "batch-native-a" } }],
  });
  expect(replay).toMatchObject([{ appended: false, messageId: "batch-native-a" }]);
  const freshIds = [
    ...batch.map((entry) => entry.messageId),
    returnedCopy.entryId,
    raw.entryId,
    ordinary,
    publicAppend.messageId,
    sequenced.result?.messageId,
  ];
  expect(new Set(freshIds).size).toBe(7);
  const after = await loadTranscriptEvents(target);
  for (const entry of after) {
    const event = asOptionalObjectRecord(entry);
    if (!freshIds.includes(String(event?.id))) {
      continue;
    }
    expect(
      asOptionalObjectRecord(asOptionalObjectRecord(event?.message)?.["__openclaw"])
        ?.nativeInvocation,
    ).toBeUndefined();
  }
  expect(
    after.filter((entry) => freshIds.includes(String(asOptionalObjectRecord(entry)?.id))),
  ).toHaveLength(7);

  if (!raw.anchor) {
    throw new Error("Raw append omitted its canonical anchor");
  }
  const rewrite = await rewriteTranscriptMessageAtAnchor(raw.anchor, (message) => ({
    ...asOptionalObjectRecord(message),
    __openclaw: metadata,
  }));
  expect(rewrite).toMatchObject({ messageId: raw.entryId, generation: expect.any(String) });
  const rewritten = await loadTranscriptEvents(target);
  expect(
    asOptionalObjectRecord(
      asOptionalObjectRecord(
        asOptionalObjectRecord(
          rewritten.find((event) => asOptionalObjectRecord(event)?.id === raw.entryId),
        )?.message,
      )?.["__openclaw"],
    )?.nativeInvocation,
  ).toBeUndefined();

  const native = rewritten.find(
    (event) =>
      asOptionalObjectRecord(
        asOptionalObjectRecord(asOptionalObjectRecord(event)?.message)?.["__openclaw"],
      )?.nativeInvocation,
  );
  const nativeEvent = asOptionalObjectRecord(native);
  if (!nativeEvent || typeof nativeEvent.id !== "string") {
    throw new Error("Missing original native entry");
  }
  const hydration = prepareSessionTranscriptHydration(target, {
    maxEvents: 256,
    maxBytes: 262_144,
  });
  const snapshot = await hydration.read();
  if (snapshot.kind !== "bounded") {
    throw new Error("Missing current native history");
  }
  const { anchor } = await hydration.readCurrentTurnEntry({
    entryId: nativeEvent.id,
    version: snapshot.snapshot.version,
    includeEntry: false,
  });
  if (!anchor) {
    throw new Error("Missing original native anchor");
  }
  const recovery = await rewriteTranscriptMessageAtAnchor(anchor, (message) =>
    structuredClone(message),
  );
  expect(recovery).toMatchObject({ messageId: nativeEvent.id, generation: expect.any(String) });
  const recovered = (await loadTranscriptEvents(target)).find(
    (event) => asOptionalObjectRecord(event)?.id === nativeEvent.id,
  );
  expect(asOptionalObjectRecord(recovered)?.message).toEqual(nativeEvent.message);
  if (!memoryMode) {
    const fork = await forkSessionFromParentTranscript({
      parentEntry: { sessionId: target.sessionId, updatedAt: Date.now() },
      agentId: target.agentId,
      parentSessionKey: target.sessionKey,
      sessionKey: "agent:main:provenance-fork",
      storePath: target.storePath,
    });
    expect(fork.status).toBe("created");
    if (fork.status !== "created") {
      throw new Error("Missing canonical branch copy");
    }
    const branch = await loadTranscriptEvents({
      ...target,
      sessionId: fork.transcript.sessionId,
      sessionKey: "agent:main:provenance-fork",
    });
    expect(branch.some((event) => asOptionalObjectRecord(event)?.type === "message")).toBe(true);
    for (const event of branch) {
      expect(
        asOptionalObjectRecord(
          asOptionalObjectRecord(asOptionalObjectRecord(event)?.message)?.["__openclaw"],
        )?.nativeInvocation,
      ).toBeUndefined();
    }
  }
  if (memoryMode) {
    if (!memory?.owner || !target.sessionKey) {
      throw new Error("Missing required native memory import owner");
    }
    const actor = await memory.owner.acquireExisting(target.sessionKey, {
      assertCurrent() {},
      assertReadable() {},
    });
    if (!actor?.storage) {
      throw new Error("Missing native memory actor");
    }
    try {
      const imported = await actor.storage.mutate(
        {
          type: "session.parentFork.transcript",
          input: {
            sessionId: target.sessionId,
            events: [
              {
                type: "message",
                id: "forged-memory-import",
                parentId: sequenced.result!.messageId,
                timestamp: new Date().toISOString(),
                message: copied,
              },
            ],
          },
        },
        memory.authority,
      );
      expect(imported.kind).toBe("committed");
      const stored = (await loadTranscriptEvents(target)).find(
        (event) => asOptionalObjectRecord(event)?.id === "forged-memory-import",
      );
      expect(stored).toBeDefined();
      expect(
        asOptionalObjectRecord(
          asOptionalObjectRecord(asOptionalObjectRecord(stored)?.message)?.["__openclaw"],
        )?.nativeInvocation,
      ).toBeUndefined();
    } finally {
      await actor.release();
    }
  }
}

export async function expectNativeProvenanceRun({
  mode,
  runId,
  target,
  workspace,
  hooks,
  pluginOwned,
}: {
  mode: string;
  runId: string;
  target: Parameters<typeof SessionManager.openAsync>[0];
  workspace: string;
  hooks: ReturnType<typeof installNativeProvenanceHooks>;
  pluginOwned: boolean;
}) {
  const hydration = prepareSessionTranscriptHydration(target, {
    maxBytes: 262_144,
    maxEvents: 256,
  });
  const history = await hydration.read();
  hydration.assertCurrent();
  expect(history.kind).toBe("bounded");
  if (history.kind !== "bounded") {
    throw new Error("Missing native history");
  }
  const messages = history.snapshot.events.flatMap((entry) => {
    const event = asOptionalObjectRecord(entry);
    const message = asOptionalObjectRecord(event?.message);
    return event?.type === "message" && message ? [message] : [];
  });
  const results = messages.filter((message) => message.role === "toolResult");
  expect(
    messages
      .filter((message) => message.role !== "toolResult")
      .every((message) => !asOptionalObjectRecord(message["__openclaw"])?.nativeInvocation),
  ).toBe(true);
  const repairedId = mode === "provenance-extension-id";
  expect(results).toHaveLength(repairedId ? 4 : 3);
  expect(hooks?.counts().hookCalls).toBe(repairedId ? 4 : 3);
  expect(hooks?.counts().extensionCalls).toBe(3);
  if (mode === "provenance-extension-role") {
    // The extension owner rejects role changes and keeps the original native result.
    expect(messages).not.toContainEqual(
      expect.objectContaining({ role: "user", content: "Extension replaced native result" }),
    );
    expect(results.find((message) => message.toolCallId === "routine-read")).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "Verification remains pending." }],
    });
  }
  expect(
    results.map((message) => asOptionalObjectRecord(message["__openclaw"])?.nativeInvocation),
  ).toEqual([
    expect.objectContaining({
      v: 1,
      runId,
      toolCallId: "save-plan",
      qualification: "managed-progress",
      sourceEntryId: expect.any(String),
    }),
    mode === "provenance-rename" ||
    mode === "provenance-extension-id" ||
    mode === "provenance-extension-error" ||
    mode === "provenance-extension-rename" ||
    mode === "provenance-native-failure"
      ? undefined
      : expect.objectContaining({
          v: 1,
          runId,
          toolCallId: "routine-read",
          qualification: pluginOwned ? "unqualified" : "read",
          sourceEntryId: expect.any(String),
        }),
    expect.objectContaining({
      v: 1,
      runId,
      toolCallId: "save-note",
      qualification: "managed-progress",
      sourceEntryId: expect.any(String),
    }),
    ...(repairedId ? [undefined] : []),
  ]);
  if (mode === "provenance-generation") {
    rotateAgentRunRegistryLifecycleGeneration();
  }
  const work = await captureProgressWorkReader({
    target: captureSessionTranscriptTargetBinding(target),
    assertCurrent() {},
  }).read();
  expect(work).toMatchObject({
    kind: "retained",
    state: {
      record: {
        disposition: { kind: "actionable" },
        steps: [{ status: "completed" }, { status: "pending" }],
      },
    },
    coverage: {
      kind: ["provenance-sql", "provenance-memory", "provenance-extension-role"].includes(mode)
        ? "covered"
        : "unavailable",
    },
  });
  if (mode === "provenance-generation") {
    expect(work).toMatchObject({
      coverage: { kind: "unavailable", reason: "Native process/lifecycle changed" },
    });
  }
  if (mode === "provenance-sql") {
    await expect(
      expectNativeProvenanceIngress(
        target,
        workspace,
        results[0]!["__openclaw"],
        hooks?.nativeResult(),
        true,
      ),
    ).rejects.toThrow("Missing required native memory import owner");
  }
  if (mode === "provenance-sql" || mode === "provenance-memory") {
    await expectNativeProvenanceIngress(
      target,
      workspace,
      results[0]!["__openclaw"],
      hooks?.nativeResult(),
      mode === "provenance-memory",
    );
  }
  console.log("RETENTION_NATIVE_PROVENANCE", JSON.stringify({ mode, results, ...hooks?.counts() }));
}

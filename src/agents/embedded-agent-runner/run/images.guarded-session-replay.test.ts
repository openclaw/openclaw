// Verifies a guarded session keeps runtime image ownership from preparation through replay.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { readRuntimePromptImageProvenance } from "../../../media/runtime-prompt-image-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { detectAndLoadPromptImages, hydratePromptMediaMessages } from "./images.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureId = 0;

async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-image-replay-");
  const sessionId = `session-${fixtureId++}`;
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  const sessionEntry = { sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({ ...target, entry: sessionEntry });
  return { root, sessionManager: SessionManager.open(target, root), target, sessionEntry };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("guardSessionManager runtime image replay", () => {
  it.each([
    { name: "history first", order: ["history", "current"], missing: false },
    { name: "current first", order: ["current", "history"], missing: false },
    { name: "history before missing current", order: ["history", "current"], missing: true },
    { name: "missing current before history", order: ["current", "history"], missing: true },
    {
      name: "dropped unbound before missing current",
      order: ["invalid", "current", "history"],
      missing: true,
    },
  ] as const)("preserves runtime image replay ($name)", async ({ name, order, missing }) => {
    const { root, sessionManager, target, sessionEntry } = await openPersistedSessionManager();
    const historyBytes = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const currentBytes = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    const invalidBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    expect(hash(historyBytes)).not.toBe(hash(currentBytes));
    const currentPath = path.join(root, "current.png");
    if (!missing) {
      await fs.writeFile(currentPath, currentBytes);
    }
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "Compare the retained image with the current image.",
        media: [{ path: currentPath, contentType: "image/png" }],
        mediaImageLayout: {
          slots: order.map((source) =>
            source === "current"
              ? { kind: "offloaded" as const, factIndex: 0 }
              : { kind: "inline" as const },
          ),
        },
        timestamp: 1,
        idempotencyKey: `${name}:user`,
      },
      target: { ...target, sessionEntry },
    });
    const preparedMessage = await recorder.resolveMessage();
    if (!preparedMessage) {
      throw new Error("Expected canonical prepared user input");
    }
    const prepared = await detectAndLoadPromptImages({
      prompt: "Compare the retained image with the current image.",
      userTurnTranscriptRecorder: recorder,
      existingImages: order.flatMap((source) =>
        source === "current"
          ? []
          : [
              {
                type: "image" as const,
                data: (source === "invalid" ? invalidBytes : historyBytes).toString("base64"),
                mimeType: "image/png",
              },
            ],
      ),
      model: { input: ["text", "image"] },
      workspaceDir: root,
      localRoots: [root],
    });
    const preparedSources = order.filter(
      (source) => source !== "invalid" && (!missing || source !== "current"),
    );
    const expectedFactIndexes = preparedSources.map((source) => (source === "current" ? 0 : null));
    expect({
      hashes: prepared.images.map((image) => hash(Buffer.from(image.data, "base64"))),
      indexes: prepared.imageFactIndexes,
      loaded: prepared.loadedCount,
      failed: prepared.failedMediaCount,
      skipped: prepared.skippedCount,
    }).toEqual({
      hashes: preparedSources.map((source) =>
        hash(source === "current" ? currentBytes : historyBytes),
      ),
      indexes: expectedFactIndexes,
      loaded: missing ? 0 : 1,
      failed: missing ? 1 : 0,
      skipped: missing ? 1 : 0,
    });
    // Mirror AgentSession's native producer; its own SDK test covers this copy boundary.
    const provenance = readRuntimePromptImageProvenance(prepared.images);
    if (!provenance) {
      throw new Error("Expected prepared runtime image provenance");
    }
    const runtimeMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Rendered runtime prompt" }, ...prepared.images],
      timestamp: 2,
      __openclaw: {
        mediaImageBlockFactIndexes: provenance.imageFactIndexes,
        mediaImageLayout: provenance.mediaImageLayout,
      },
    };
    expect(runtimeMessage["__openclaw"].mediaImageBlockFactIndexes).toEqual(expectedFactIndexes);
    const guarded = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      preparedUserTurnMessage: preparedMessage,
      preparedUserTurnTranscriptRecorder: recorder,
    });
    const entryId = guarded.appendMessage(runtimeMessage);
    expect(recorder.hasPersisted()).toBe(true);
    const storedEntry = SessionManager.open(target, root).getEntry(entryId);
    if (storedEntry?.type !== "message" || storedEntry.message.role !== "user") {
      throw new Error("Expected runtime user row from the real SQLite transcript");
    }
    const storedMessage = storedEntry.message;
    expect(storedMessage.content).toEqual(runtimeMessage.content);
    expect(Reflect.get(storedMessage, "idempotencyKey")).toBe(`${name}:user`);
    // Recover the unavailable current source only after the runtime row was committed.
    if (missing) {
      await fs.writeFile(currentPath, currentBytes);
    }
    await expect(fs.readFile(currentPath)).resolves.toEqual(currentBytes);
    const failures: number[] = [];
    const [replayed] = await hydratePromptMediaMessages([storedMessage], {
      workspaceDir: root,
      model: { input: ["text", "image"] },
      localRoots: [root],
      onCurrentTurnImageFailure: (count) => {
        failures.push(count);
      },
    });
    if (replayed?.role !== "user" || !Array.isArray(replayed.content)) {
      throw new Error("Expected stored runtime row to materialize for replay");
    }
    expect({
      hashes: replayed.content
        .filter((block) => block.type === "image")
        .map((image) => hash(Buffer.from(image.data, "base64"))),
      text: replayed.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      failures,
    }).toEqual({
      hashes: order.flatMap((source) =>
        source === "invalid" ? [] : [hash(source === "current" ? currentBytes : historyBytes)],
      ),
      text: ["Rendered runtime prompt"],
      failures: [],
    });
  });
});

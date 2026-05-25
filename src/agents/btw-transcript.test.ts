import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolveBtwSessionTranscriptPath } from "./btw-transcript.js";

function createCompactionCheckpointEntry(params: {
  sessionId?: string;
  sessionFile: string;
  postSessionFile: string;
}): SessionEntry {
  const sessionId = params.sessionId ?? "session-1";
  return {
    sessionId,
    sessionFile: params.sessionFile,
    updatedAt: 1,
    compactionCheckpoints: [
      {
        checkpointId: "98904e8a-a402-4d92-8795-4a2d7bba2276",
        sessionKey: "agent:main:telegram:direct:user",
        sessionId,
        createdAt: 1,
        reason: "manual",
        preCompaction: {
          sessionId,
          sessionFile: params.sessionFile,
          leafId: "pre-leaf",
        },
        postCompaction: {
          sessionId,
          sessionFile: params.postSessionFile,
          leafId: "post-leaf",
        },
      },
    ],
  };
}

describe("resolveBtwSessionTranscriptPath", () => {
  it("uses the active post-compaction transcript when the stored session file points at a checkpoint", () => {
    const storePath = "/tmp/openclaw-btw-session/sessions.json";
    const checkpointFile = path.join(
      path.dirname(storePath),
      "session-1.checkpoint.98904e8a-a402-4d92-8795-4a2d7bba2276.jsonl",
    );
    const postCompactionFile = path.join(path.dirname(storePath), "session-1.jsonl");
    const sessionEntry = createCompactionCheckpointEntry({
      sessionFile: checkpointFile,
      postSessionFile: postCompactionFile,
    });

    expect(
      resolveBtwSessionTranscriptPath({
        sessionId: "session-1",
        sessionEntry,
        sessionKey: "agent:main:telegram:direct:user",
        storePath,
      }),
    ).toBe(postCompactionFile);
  });

  it("leaves active transcript paths unchanged when no checkpoint remap is needed", () => {
    const storePath = "/tmp/openclaw-btw-session/sessions.json";
    const checkpointFile = path.join(
      path.dirname(storePath),
      "session-1.checkpoint.98904e8a-a402-4d92-8795-4a2d7bba2276.jsonl",
    );
    const postCompactionFile = path.join(path.dirname(storePath), "session-1.jsonl");
    const sessionEntry = createCompactionCheckpointEntry({
      sessionFile: postCompactionFile,
      postSessionFile: postCompactionFile,
    });
    const [checkpoint] = sessionEntry.compactionCheckpoints ?? [];
    if (!checkpoint) {
      throw new Error("Expected compaction checkpoint");
    }
    checkpoint.preCompaction.sessionFile = checkpointFile;

    expect(
      resolveBtwSessionTranscriptPath({
        sessionId: "session-1",
        sessionEntry,
        sessionKey: "agent:main:telegram:direct:user",
        storePath,
      }),
    ).toBe(postCompactionFile);
  });
});

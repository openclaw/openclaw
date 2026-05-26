import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolveBtwSessionTranscriptPath } from "./btw-transcript.js";

const SESSIONS_DIR = "/tmp/openclaw-btw-session";
const STORE_PATH = path.join(SESSIONS_DIR, "sessions.json");
const SESSION_KEY = "agent:main:telegram:direct:user";

describe("resolveBtwSessionTranscriptPath", () => {
  it("uses the active post-compaction transcript when the stored session file points at a checkpoint", () => {
    const sessionId = "session-1";
    const checkpointFile = path.join(
      SESSIONS_DIR,
      "session-1.checkpoint.98904e8a-a402-4d92-8795-4a2d7bba2276.jsonl",
    );
    const postCompactionFile = path.join(SESSIONS_DIR, "session-1.jsonl");
    const entry: SessionEntry = {
      sessionId,
      sessionFile: checkpointFile,
      updatedAt: 1_779_695_000_000,
      compactionCheckpoints: [
        {
          checkpointId: "98904e8a-a402-4d92-8795-4a2d7bba2276",
          sessionKey: SESSION_KEY,
          sessionId,
          createdAt: 1_779_695_000_000,
          reason: "auto-threshold",
          preCompaction: {
            sessionId,
            sessionFile: checkpointFile,
            leafId: "pre-leaf",
          },
          postCompaction: {
            sessionId,
            sessionFile: postCompactionFile,
            leafId: "post-leaf",
          },
        },
      ],
    };

    expect(
      resolveBtwSessionTranscriptPath({
        sessionId,
        sessionEntry: entry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
      }),
    ).toBe(postCompactionFile);
  });

  it("leaves the resolved transcript unchanged when no checkpoint matches the stored file", () => {
    const sessionId = "session-2";
    const activeFile = path.join(SESSIONS_DIR, "session-2.jsonl");
    const entry: SessionEntry = {
      sessionId,
      sessionFile: activeFile,
      updatedAt: 1_779_695_000_000,
      compactionCheckpoints: [
        {
          checkpointId: "11111111-1111-1111-1111-111111111111",
          sessionKey: SESSION_KEY,
          sessionId,
          createdAt: 1_779_695_000_000,
          reason: "auto-threshold",
          preCompaction: {
            sessionId,
            sessionFile: path.join(
              SESSIONS_DIR,
              "session-2.checkpoint.11111111-1111-1111-1111-111111111111.jsonl",
            ),
            leafId: "pre-leaf",
          },
          postCompaction: {
            sessionId,
            sessionFile: activeFile,
            leafId: "post-leaf",
          },
        },
      ],
    };

    expect(
      resolveBtwSessionTranscriptPath({
        sessionId,
        sessionEntry: entry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
      }),
    ).toBe(activeFile);
  });

  it("returns the stored transcript when no compaction checkpoints exist", () => {
    const sessionId = "session-3";
    const activeFile = path.join(SESSIONS_DIR, "session-3.jsonl");
    const entry: SessionEntry = {
      sessionId,
      sessionFile: activeFile,
      updatedAt: 1_779_695_000_000,
    };

    expect(
      resolveBtwSessionTranscriptPath({
        sessionId,
        sessionEntry: entry,
        sessionKey: SESSION_KEY,
        storePath: STORE_PATH,
      }),
    ).toBe(activeFile);
  });
});

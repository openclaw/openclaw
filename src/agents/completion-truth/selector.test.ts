import { describe, expect, it } from "vitest";
import { selectCompletionTruth } from "./selector.js";

const toolResult = { source: "tool", status: "done", worker_id: "tool" };
const transcriptResult = {
  source: "transcript",
  status: "done",
  worker_id: "transcript",
};
const artifactPacket = {
  source: "artifact",
  status: "done",
  worker_id: "artifact",
};
const realtimeHint = { source: "hint", status: "yielded", worker_id: "hint" };

describe("selectCompletionTruth", () => {
  it("prefers toolResult over lower-priority sources", () => {
    expect(
      selectCompletionTruth({
        toolResult,
        transcriptResult,
        verificationArtifact: { packet: artifactPacket },
        realtimeHint,
      }),
    ).toMatchObject({
      source: "toolResult",
      confidence: "high",
      result: toolResult,
    });
  });

  it("falls through truth hierarchy in order", () => {
    expect(selectCompletionTruth({ transcriptResult, realtimeHint })).toMatchObject({
      source: "transcriptResult",
      result: transcriptResult,
    });
    expect(
      selectCompletionTruth({
        verificationArtifact: { packet: artifactPacket },
        realtimeHint,
      }),
    ).toMatchObject({
      source: "verificationArtifact",
      result: artifactPacket,
    });
    expect(selectCompletionTruth({ realtimeHint })).toMatchObject({
      source: "realtimeHint",
      confidence: "low",
      result: realtimeHint,
    });
  });

  it("returns none when no candidate exists", () => {
    expect(selectCompletionTruth({})).toMatchObject({
      kind: "none",
      source: "none",
      confidence: "none",
    });
  });
});

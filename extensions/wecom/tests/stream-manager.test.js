/**
 * Tests for StreamManager (stream-manager.js)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Import the StreamManager class indirectly — it is only exported as a
// singleton, so we test via the exported `streamManager` instance after
// isolating each test with unique stream IDs.
import { streamManager } from "../stream-manager.js";

// Helper: generate a unique stream ID per test.
let _counter = 0;
function uid() {
  return `test-stream-${Date.now()}-${_counter++}`;
}

describe("StreamManager — createStream / getStream / hasStream", () => {
  it("creates a stream and hasStream returns true", () => {
    const id = uid();
    streamManager.createStream(id);
    assert.equal(streamManager.hasStream(id), true);
  });

  it("getStream returns the initial state", () => {
    const id = uid();
    streamManager.createStream(id);
    const s = streamManager.getStream(id);
    assert.equal(s.content, "");
    assert.equal(s.finished, false);
    assert.ok(Array.isArray(s.msgItem));
    assert.equal(s.msgItem.length, 0);
  });

  it("createStream with feedbackId stores it on the stream", () => {
    const id = uid();
    streamManager.createStream(id, { feedbackId: "fb-123" });
    const s = streamManager.getStream(id);
    assert.equal(s.feedbackId, "fb-123");
  });

  it("hasStream returns false for unknown id", () => {
    assert.equal(streamManager.hasStream("definitely-not-there"), false);
  });
});

describe("StreamManager — appendStream", () => {
  it("appends chunks to stream content", () => {
    const id = uid();
    streamManager.createStream(id);
    streamManager.appendStream(id, "Hello");
    streamManager.appendStream(id, ", World");
    const s = streamManager.getStream(id);
    assert.equal(s.content, "Hello, World");
  });

  it("returns false for nonexistent stream", () => {
    assert.equal(streamManager.appendStream("no-such-id", "data"), false);
  });

  it("updates updatedAt on each append", async () => {
    const id = uid();
    streamManager.createStream(id);
    const before = streamManager.getStream(id).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    streamManager.appendStream(id, "chunk");
    const after = streamManager.getStream(id).updatedAt;
    assert.ok(after >= before);
  });
});

describe("StreamManager — updateStream", () => {
  it("replaces content on updateStream", () => {
    const id = uid();
    streamManager.createStream(id);
    streamManager.appendStream(id, "old");
    streamManager.updateStream(id, "new content");
    assert.equal(streamManager.getStream(id).content, "new content");
  });

  it("marks stream as finished when finished=true", () => {
    const id = uid();
    streamManager.createStream(id);
    streamManager.updateStream(id, "final", true);
    assert.equal(streamManager.getStream(id).finished, true);
  });

  it("stores msgItem when finished=true and msgItem provided", () => {
    const id = uid();
    streamManager.createStream(id);
    const items = [{ msgtype: "image", image: { base64: "abc", md5: "def" } }];
    streamManager.updateStream(id, "done", true, { msgItem: items });
    assert.equal(streamManager.getStream(id).msgItem.length, 1);
  });

  it("does NOT store msgItem when finished=false", () => {
    const id = uid();
    streamManager.createStream(id);
    const items = [{ msgtype: "image", image: { base64: "abc", md5: "def" } }];
    streamManager.updateStream(id, "in-progress", false, { msgItem: items });
    assert.equal(streamManager.getStream(id).msgItem.length, 0);
  });

  it("returns false for nonexistent stream", () => {
    assert.equal(streamManager.updateStream("ghost", "content"), false);
  });
});

describe("StreamManager — finishStream", () => {
  it("marks stream finished", async () => {
    const id = uid();
    streamManager.createStream(id);
    await streamManager.finishStream(id);
    assert.equal(streamManager.getStream(id).finished, true);
  });

  it("returns false for nonexistent stream", async () => {
    const result = await streamManager.finishStream("no-stream");
    assert.equal(result, false);
  });

  it("calling finishStream twice is idempotent", async () => {
    const id = uid();
    streamManager.createStream(id);
    await streamManager.finishStream(id);
    await streamManager.finishStream(id); // should not throw
    assert.equal(streamManager.getStream(id).finished, true);
  });
});

describe("StreamManager — deleteStream", () => {
  it("deletes an existing stream", () => {
    const id = uid();
    streamManager.createStream(id);
    assert.equal(streamManager.deleteStream(id), true);
    assert.equal(streamManager.hasStream(id), false);
  });

  it("returns false when stream does not exist", () => {
    assert.equal(streamManager.deleteStream("nonexistent-xyz"), false);
  });
});

describe("StreamManager — enforceByteLimit (UTF-8 safety)", () => {
  it("content under 20480 bytes is stored as-is", () => {
    const id = uid();
    streamManager.createStream(id);
    const content = "A".repeat(1000);
    streamManager.updateStream(id, content);
    assert.equal(streamManager.getStream(id).content, content);
  });

  it("content exceeding 20480 bytes is truncated", () => {
    const id = uid();
    streamManager.createStream(id);
    // Each ASCII char is 1 byte; 25000 'A's = 25000 bytes > 20480.
    const longContent = "A".repeat(25000);
    streamManager.updateStream(id, longContent);
    const stored = streamManager.getStream(id).content;
    assert.ok(Buffer.byteLength(stored, "utf8") <= 20480);
  });

  it("truncation does not break multi-byte UTF-8 characters", () => {
    const id = uid();
    streamManager.createStream(id);
    // Each Chinese char is 3 bytes. 7000 chars = 21000 bytes > 20480.
    const chinese = "中".repeat(7000);
    streamManager.updateStream(id, chinese);
    const stored = streamManager.getStream(id).content;
    const bytes = Buffer.byteLength(stored, "utf8");
    assert.ok(bytes <= 20480);
    // Must be valid UTF-8 (no replacement characters from bad slicing).
    assert.ok(!stored.includes("\uFFFD"));
    // The stored string should only contain '中' characters (no partial bytes).
    assert.match(stored, /^中*$/);
  });

  it("appending also enforces byte limit", () => {
    const id = uid();
    streamManager.createStream(id);
    streamManager.appendStream(id, "x".repeat(15000));
    streamManager.appendStream(id, "y".repeat(10000)); // combined would be 25000
    const stored = streamManager.getStream(id).content;
    assert.ok(Buffer.byteLength(stored, "utf8") <= 20480);
  });
});

describe("StreamManager — getStats", () => {
  it("reports correct active and finished counts", async () => {
    const id1 = uid();
    const id2 = uid();
    const id3 = uid();
    streamManager.createStream(id1);
    streamManager.createStream(id2);
    streamManager.createStream(id3);
    await streamManager.finishStream(id3);

    const stats = streamManager.getStats();
    // At least our 3 streams should be reflected (other tests may have created more).
    assert.ok(stats.total >= 3);
    assert.ok(stats.finished >= 1);
    assert.ok(stats.active >= 2);
  });
});

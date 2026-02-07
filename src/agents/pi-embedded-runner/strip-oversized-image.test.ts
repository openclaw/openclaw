import fsSync from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripOversizedImageFromSession } from "./strip-oversized-image.js";

describe("stripOversizedImageFromSession", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "strip-image-test-"));
  });

  afterEach(async () => {
    await fsAsync.rm(tmpDir, { recursive: true, force: true });
  });

  function writeSessionSync(entries: unknown[]): string {
    const file = path.join(tmpDir, "session.jsonl");
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fsSync.writeFileSync(file, content);
    return file;
  }

  it("strips an image block from a user message by index", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Look at this image" },
            { type: "image", data: "base64oversized", mimeType: "image/jpeg" },
          ],
        },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I see the image" }],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const userMsg = lines[1];
    expect(userMsg.message.content).toHaveLength(2);
    expect(userMsg.message.content[0].type).toBe("text");
    expect(userMsg.message.content[0].text).toBe("Look at this image");
    expect(userMsg.message.content[1].type).toBe("text");
    expect(userMsg.message.content[1].text).toContain("omitted");
    expect(userMsg.message.content[1].text).toContain("exceeds size limit");
  });

  it("handles message index referring to the Nth message in the context", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
        },
      },
      {
        type: "message",
        id: "c",
        parentId: "b",
        message: {
          role: "user",
          content: [
            { type: "text", text: "See this" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // In the context messages array: msg[0]=user, msg[1]=assistant, msg[2]=user
    const stripped = await stripOversizedImageFromSession(file, 2, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Fourth entry (index 3 in file, the second user message) should have image stripped
    const secondUser = lines[3];
    expect(secondUser.message.content[1].type).toBe("text");
    expect(secondUser.message.content[1].text).toContain("omitted");
  });

  it("returns false when session file does not exist", async () => {
    const stripped = await stripOversizedImageFromSession("/nonexistent/file.jsonl", 0, 1);
    expect(stripped).toBe(false);
  });

  it("returns false when message index is out of range", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: "hello" },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 99, 0);
    expect(stripped).toBe(false);
  });

  it("returns false when content index is out of range", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "no image" }],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, 5);
    expect(stripped).toBe(false);
  });

  it("returns false when target content block is not an image", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, 1);
    expect(stripped).toBe(false);
  });

  it("follows context path in branched sessions (skips dead branches)", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      },
      // Dead branch (c is NOT on the active path — leaf is e, path is a→b→d→e)
      {
        type: "message",
        id: "c",
        parentId: "b",
        message: { role: "user", content: [{ type: "text", text: "Dead branch" }] },
      },
      // Active branch
      {
        type: "message",
        id: "d",
        parentId: "b",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Active branch" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message",
        id: "e",
        parentId: "d",
        message: { role: "assistant", content: [{ type: "text", text: "Got it" }] },
      },
    ];
    const file = writeSessionSync(entries);

    // Context path: a→b→d→e. API messages: [a, b, d, e].
    // Index 2 = msg_d (active branch user message with image), NOT msg_c.
    const stripped = await stripOversizedImageFromSession(file, 2, 1);
    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // msg_d is at file index 4 (session=0, a=1, b=2, c=3, d=4, e=5)
    const msgD = lines[4];
    expect(msgD.id).toBe("d");
    expect(msgD.message.content[1].type).toBe("text");
    expect(msgD.message.content[1].text).toContain("omitted");

    // msg_c (dead branch) should be untouched
    const msgC = lines[3];
    expect(msgC.id).toBe("c");
    expect(msgC.message.content[0].text).toBe("Dead branch");
  });

  it("accounts for compaction synthetic message when mapping API index", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      // Summarized away (before firstKeptEntryId)
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Old msg" }] },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: { role: "assistant", content: [{ type: "text", text: "Old reply" }] },
      },
      // Kept message
      {
        type: "message",
        id: "c",
        parentId: "b",
        message: { role: "user", content: [{ type: "text", text: "Kept msg" }] },
      },
      // Compaction (keeps from msg_c onwards)
      {
        type: "compaction",
        id: "comp",
        parentId: "c",
        summary: "Earlier conversation about greetings",
        firstKeptEntryId: "c",
      },
      // Post-compaction messages
      {
        type: "message",
        id: "d",
        parentId: "comp",
        message: {
          role: "user",
          content: [
            { type: "text", text: "New message" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
      {
        type: "message",
        id: "e",
        parentId: "d",
        message: { role: "assistant", content: [{ type: "text", text: "I see" }] },
      },
    ];
    const file = writeSessionSync(entries);

    // API messages: [synthetic_summary(0), c(1), d(2), e(3)]
    // Index 2 = msg_d (has image). Without compaction offset, flat-order
    // would map index 2 to msg_c (wrong).
    const stripped = await stripOversizedImageFromSession(file, 2, 1);
    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // msg_d is at file index 5 (session=0, a=1, b=2, c=3, comp=4, d=5, e=6)
    const msgD = lines[5];
    expect(msgD.id).toBe("d");
    expect(msgD.message.content[1].type).toBe("text");
    expect(msgD.message.content[1].text).toContain("omitted");
  });

  it("returns false when API index targets compaction synthetic summary", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
      {
        type: "compaction",
        id: "comp",
        parentId: "a",
        summary: "Greeting",
        firstKeptEntryId: "a",
      },
      {
        type: "message",
        id: "b",
        parentId: "comp",
        message: { role: "user", content: [{ type: "text", text: "After compaction" }] },
      },
    ];
    const file = writeSessionSync(entries);

    // API messages: [synthetic_summary(0), a(1), b(2)]
    // Index 0 = synthetic → can't strip from it
    const stripped = await stripOversizedImageFromSession(file, 0, 0);
    expect(stripped).toBe(false);
  });

  it("strips all images from a message when contentIndex is undefined", async () => {
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Two images" },
            { type: "image", data: "img1", mimeType: "image/jpeg" },
            { type: "image", data: "img2", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    const stripped = await stripOversizedImageFromSession(file, 0, undefined);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const userMsg = lines[1];

    expect(userMsg.message.content).toHaveLength(3);
    expect(userMsg.message.content[0].type).toBe("text");
    expect(userMsg.message.content[0].text).toBe("Two images");
    expect(userMsg.message.content[1].type).toBe("text");
    expect(userMsg.message.content[1].text).toContain("omitted");
    expect(userMsg.message.content[2].type).toBe("text");
    expect(userMsg.message.content[2].text).toContain("omitted");
  });

  it("applies history windowing when historyTurnsLimit is set", async () => {
    // Scenario: User sends a message with an oversized image, API rejects before generating response.
    // Session at error time has the new user message but NO assistant response yet.
    //
    // Timeline:
    // 1. Session before error: [a,b,c,d,e,f] (3 user turns: a,c,e)
    // 2. User sends g with oversized image → g is persisted
    // 3. API call: limitHistoryTurns([a,b,c,d,e,f], 2) + g
    //    - limitHistoryTurns keeps last 2 user turns from previous history: c,e
    //    - Result: [c,d,e,f] + g = [c,d,e,f,g] (5 messages, indices 0-4)
    // 4. API rejects with error at messageIndex=4 (g has the oversized image)
    // 5. Session at strip time: [a,b,c,d,e,f,g] (4 user turns: a,c,e,g)
    //
    // Strip logic with N+1: effectiveLimit = 2+1 = 3
    // - Keep last 3 user turns: c,e,g
    // - Windowed: [c,d,e,f,g] — matches what API saw
    // - messageIndex=4 → g ✓
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "First user" }] },
      },
      {
        type: "message",
        id: "b",
        parentId: "a",
        message: { role: "assistant", content: [{ type: "text", text: "First reply" }] },
      },
      {
        type: "message",
        id: "c",
        parentId: "b",
        message: { role: "user", content: [{ type: "text", text: "Second user" }] },
      },
      {
        type: "message",
        id: "d",
        parentId: "c",
        message: { role: "assistant", content: [{ type: "text", text: "Second reply" }] },
      },
      {
        type: "message",
        id: "e",
        parentId: "d",
        message: { role: "user", content: [{ type: "text", text: "Third user" }] },
      },
      {
        type: "message",
        id: "f",
        parentId: "e",
        message: { role: "assistant", content: [{ type: "text", text: "Third reply" }] },
      },
      {
        type: "message",
        id: "g",
        parentId: "f",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Fourth user with image" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
      // Note: No assistant response "h" — error occurred before response was generated
    ];
    const file = writeSessionSync(entries);

    // API saw [c,d,e,f,g] (indices 0-4). Error at messageIndex=4 (g).
    const stripped = await stripOversizedImageFromSession(file, 4, 1, { historyTurnsLimit: 2 });

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message g is at file index 7 (session=0, a=1, b=2, c=3, d=4, e=5, f=6, g=7)
    const msgG = lines[7];
    expect(msgG.id).toBe("g");
    expect(msgG.message.content[1].type).toBe("text");
    expect(msgG.message.content[1].text).toContain("omitted");

    // Earlier messages should be untouched
    const msgA = lines[1];
    expect(msgA.id).toBe("a");
    expect(msgA.message.content[0].text).toBe("First user");
  });

  it("handles compacted session with history limit correctly", async () => {
    // Scenario: Compacted session, user sends message with oversized image.
    // Error occurs before assistant response exists.
    //
    // Session structure at strip time:
    // - a (user) - kept by firstKeptEntryId
    // - comp (compaction)
    // - b (user) - first post-compaction turn
    // - c (assistant)
    // - d (user with image) - new message that caused error
    //
    // Effective messages: [summary(0), a(1), b(2), c(3), d(4)]
    // User turns: a, b, d (3 total)
    //
    // With historyTurnsLimit=2, effectiveLimit=3:
    // - Keep last 3 user turns: a, b, d (all of them)
    // - Windowed: [summary, a, b, c, d] (no change)
    // - API messageIndex=4 → d ✓
    //
    // The compaction summary (role: compactionSummary) does NOT count as a user turn.
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      // Kept by firstKeptEntryId (before compaction in context but after in file)
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Old msg" }] },
      },
      // Compaction
      {
        type: "compaction",
        id: "comp",
        parentId: "a",
        summary: "Earlier conversation",
        firstKeptEntryId: "a",
      },
      // Post-compaction messages
      {
        type: "message",
        id: "b",
        parentId: "comp",
        message: { role: "user", content: [{ type: "text", text: "First post-compact" }] },
      },
      {
        type: "message",
        id: "c",
        parentId: "b",
        message: { role: "assistant", content: [{ type: "text", text: "Reply 1" }] },
      },
      {
        type: "message",
        id: "d",
        parentId: "c",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Second post-compact with image" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
      // Note: No assistant response — error occurred before response was generated
    ];
    const file = writeSessionSync(entries);

    // API saw [summary, a, b, c, d] (indices 0-4). Error at messageIndex=4 (d).
    const stripped = await stripOversizedImageFromSession(file, 4, 1, { historyTurnsLimit: 2 });

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message d is at file index 5 (session=0, a=1, comp=2, b=3, c=4, d=5)
    const msgD = lines[5];
    expect(msgD.id).toBe("d");
    expect(msgD.message.content[1].type).toBe("text");
    expect(msgD.message.content[1].text).toContain("omitted");
  });

  it("preserves unparseable lines when rewriting the session file", async () => {
    // Write a session file with a mix of valid JSON and unparseable lines
    const file = path.join(tmpDir, "session.jsonl");
    const validSession = JSON.stringify({ type: "session", version: 1, cwd: "/tmp" });
    const validMsg = JSON.stringify({
      type: "message",
      id: "a",
      parentId: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "image", data: "bigimage", mimeType: "image/png" },
        ],
      },
    });
    const unparseableLine = "this is not valid JSON {{{";
    const validReply = JSON.stringify({
      type: "message",
      id: "b",
      parentId: "a",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });

    // Write file with unparseable line in the middle
    fsSync.writeFileSync(file, `${validSession}\n${validMsg}\n${unparseableLine}\n${validReply}\n`);

    const stripped = await stripOversizedImageFromSession(file, 0, 1);
    expect(stripped).toBe(true);

    // Read back and verify unparseable line is preserved exactly
    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw.split("\n");

    // Should have 4 lines + trailing empty from split
    expect(lines[2]).toBe(unparseableLine); // Unparseable line preserved exactly
    expect(lines[0]).toBe(validSession); // Session line unchanged

    // The modified message should have the image stripped
    const modifiedMsg = JSON.parse(lines[1]);
    expect(modifiedMsg.message.content[1].type).toBe("text");
    expect(modifiedMsg.message.content[1].text).toContain("omitted");

    // Reply should be unchanged (compare as parsed to ignore whitespace differences)
    const replyMsg = JSON.parse(lines[3]);
    expect(replyMsg.id).toBe("b");
  });

  it("adjusts index for Google turn ordering synthetic bootstrap message", async () => {
    // Scenario: Session with Google turn ordering marker IN THE CONTEXT PATH.
    // When this marker is present, the API request had a synthetic "(session bootstrap)"
    // user message prepended. API indices are offset by 1 from session entries.
    //
    // Session entries: [session, a(asst), marker, b(user with image)]
    // Context path: a → marker → b
    // API saw: [bootstrap(synthetic), a(asst), b(user with image)]
    // API messageIndex=2 → session entry b (index 1 after adjusting for synthetic)
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      },
      // Google turn ordering marker in context path
      {
        type: "custom",
        id: "marker",
        parentId: "a",
        customType: "google-turn-ordering-bootstrap",
        timestamp: Date.now(),
      },
      {
        type: "message",
        id: "b",
        parentId: "marker",
        message: {
          role: "user",
          content: [
            { type: "text", text: "See this" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // API saw [bootstrap(0), a(1), b(2)]. Error at messageIndex=2 targets b.
    // Without the Google turn ordering adjustment, we'd try to find index 2
    // in session entries [a, b] which would fail or hit wrong entry.
    const stripped = await stripOversizedImageFromSession(file, 2, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message b is at file index 3 (session=0, a=1, marker=2, b=3)
    const msgB = lines[3];
    expect(msgB.id).toBe("b");
    expect(msgB.message.content[1].type).toBe("text");
    expect(msgB.message.content[1].text).toContain("omitted");
  });

  it("does not apply Google turn ordering offset when marker is on dead branch", async () => {
    // Scenario: Session has a Google turn ordering marker, but the marker is on a DEAD BRANCH
    // (not in the active context path). The marker should NOT affect index mapping.
    //
    // Session file:
    // - session
    // - u1 (user) → parentId: null
    // - a1 (assistant) → parentId: u1
    // - marker (custom) → parentId: a1  [DEAD BRANCH - not in active path]
    // - old (user) → parentId: marker   [DEAD BRANCH - not in active path]
    // - new (user with image) → parentId: a1  [ACTIVE - this is the leaf]
    //
    // Context path (via parentId chain from leaf): u1 → a1 → new
    // Marker is NOT in context path (it's in u1 → a1 → marker → old branch)
    //
    // API did NOT prepend bootstrap for this request because marker wasn't used.
    // API messages: [u1(0), a1(1), new(2)]
    // Error at messageIndex=2 → new (no offset needed)
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
      // Google turn ordering marker on DEAD BRANCH
      {
        type: "custom",
        id: "marker",
        parentId: "a1",
        customType: "google-turn-ordering-bootstrap",
      },
      // Message on dead branch
      {
        type: "message",
        id: "old",
        parentId: "marker",
        message: { role: "user", content: [{ type: "text", text: "old branch" }] },
      },
      // ACTIVE branch - this is the leaf
      {
        type: "message",
        id: "new",
        parentId: "a1",
        message: {
          role: "user",
          content: [
            { type: "text", text: "img" },
            { type: "image", data: "big", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // API messages: [u1(0), a1(1), new(2)]. Error at messageIndex=2 targets new.
    // The marker is on a dead branch, so no offset should be applied.
    const stripped = await stripOversizedImageFromSession(file, 2, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message "new" is at file index 5 (session=0, u1=1, a1=2, marker=3, old=4, new=5)
    const msgNew = lines[5];
    expect(msgNew.id).toBe("new");
    expect(msgNew.message.content[1].type).toBe("text");
    expect(msgNew.message.content[1].text).toContain("omitted");

    // Messages on dead branch should be untouched
    const msgOld = lines[4];
    expect(msgOld.id).toBe("old");
    expect(msgOld.message.content[0].text).toBe("old branch");
  });

  it("does not apply Google turn ordering offset when compaction is present", async () => {
    // Scenario: Session has BOTH compaction AND Google turn ordering marker in context path.
    // When compaction is present, the compaction summary becomes the first "user" message
    // (role is converted before API call), so sanitizeGoogleTurnOrdering won't prepend a bootstrap.
    // The marker from a previous request no longer applies.
    //
    // Session structure:
    // - a (user)
    // - marker (google-turn-ordering-bootstrap) - was used in a PREVIOUS request
    // - b (assistant)
    // - comp (compaction, keeps from b onwards)
    // - c (user with image)
    //
    // Context path: a → marker → b → comp → c
    // Effective messages: [summary(0), b(1), c(2)]
    //
    // At API call time: summary is converted to "user" role, which satisfies Gemini's
    // requirement for first message to be "user". No bootstrap is prepended.
    // API saw: [summary(0), b(1), c(2)] — NO synthetic bootstrap
    //
    // Error at messageIndex=2 → c (no offset should be applied)
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "old msg" }] },
      },
      // Google turn ordering marker from a previous request
      {
        type: "custom",
        id: "marker",
        parentId: "a",
        customType: "google-turn-ordering-bootstrap",
      },
      {
        type: "message",
        id: "b",
        parentId: "marker",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      },
      // Compaction - summary becomes first "user" message, marker no longer applies
      {
        type: "compaction",
        id: "comp",
        parentId: "b",
        summary: "Earlier conversation",
        firstKeptEntryId: "b",
      },
      {
        type: "message",
        id: "c",
        parentId: "comp",
        message: {
          role: "user",
          content: [
            { type: "text", text: "new msg with image" },
            { type: "image", data: "bigimage", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // API saw [summary(0), b(1), c(2)] — no synthetic bootstrap.
    // Error at messageIndex=2 targets c.
    // If we incorrectly applied the offset, we'd look for index 1, which is b (wrong).
    const stripped = await stripOversizedImageFromSession(file, 2, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message c is at file index 5 (session=0, a=1, marker=2, b=3, comp=4, c=5)
    const msgC = lines[5];
    expect(msgC.id).toBe("c");
    expect(msgC.message.content[1].type).toBe("text");
    expect(msgC.message.content[1].text).toContain("omitted");

    // b should be untouched
    const msgB = lines[3];
    expect(msgB.id).toBe("b");
    expect(msgB.message.content[0].text).toBe("old reply");
  });

  it("applies Google turn ordering offset when bootstrap survives windowing", async () => {
    // Scenario: Session has Google turn ordering marker in context path. The bootstrap
    // is prepended during sanitization and is NOT sliced away by history limiting.
    // This happens when there are few user turns.
    //
    // Session structure:
    // - a (assistant) - root
    // - marker (google-turn-ordering-bootstrap) - from CURRENT request
    // - b (user with image) - new message that caused error
    //
    // Context path: a → marker → b
    // Effective messages: [a(0), b(1)]
    //
    // API request was built with NO history limit (or very high limit):
    // - Prior history: [a]
    // - sanitizeGoogleTurnOrdering: first is a (assistant) → prepend bootstrap
    // - API saw: [boot(0), a(1), b(2)]
    // - Error at messageIndex=2 → b
    //
    // Strip function (no historyTurnsLimit):
    // - simulateBootstrap = true (marker in path, first is assistant)
    // - messagesToWindow = [boot, a, b]
    // - No windowing applied (no limit)
    // - windowedWithMaybeBoot = [boot, a, b]
    // - bootSurvived = true (first is synthetic boot)
    // - windowedMessages = [a, b]
    // - offset = 1
    // - adjustedIndex = 2 - 1 = 1 → b ✓
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "assistant root" }] },
      },
      // Google turn ordering marker from current request
      {
        type: "custom",
        id: "marker",
        parentId: "a",
        customType: "google-turn-ordering-bootstrap",
      },
      {
        type: "message",
        id: "b",
        parentId: "marker",
        message: {
          role: "user",
          content: [
            { type: "text", text: "new with image" },
            { type: "image", data: "big", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // API saw [boot, a, b] (indices 0-2). Error at messageIndex=2 targets b.
    // Bootstrap survived (no windowing), so offset = 1.
    const stripped = await stripOversizedImageFromSession(file, 2, 1);

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message b is at file index 3 (session=0, a=1, marker=2, b=3)
    const msgB = lines[3];
    expect(msgB.id).toBe("b");
    expect(msgB.message.content[1].type).toBe("text");
    expect(msgB.message.content[1].text).toContain("omitted");

    // a should be untouched
    const msgA = lines[1];
    expect(msgA.id).toBe("a");
    expect(msgA.message.content[0].text).toBe("assistant root");
  });

  it("does not apply Google turn ordering offset when history windowing slices to start with user", async () => {
    // Scenario: Session has Google turn ordering marker in context path, but history
    // windowing with a small limit causes the window to start with a user message.
    // In this case, no bootstrap was prepended because the first API message was user.
    //
    // Session structure (5 user turns to force windowing):
    // - a (assistant) - root
    // - u1 (user), a1 (assistant)
    // - u2 (user), a2 (assistant)
    // - u3 (user), a3 (assistant)
    // - marker (from previous request that started with assistant)
    // - u4 (user with image) - new message causing error
    //
    // Context path: a → u1 → a1 → u2 → a2 → u3 → a3 → marker → u4
    // Effective messages: [a, u1, a1, u2, a2, u3, a3, u4] (8 messages, 4 user turns)
    //
    // API request was built with historyTurnsLimit=2:
    // - Prior history: [a, u1, a1, u2, a2, u3, a3] (3 user turns)
    // - limitHistoryTurns(prior, 2) → userCount becomes 3, > 2 at u1
    //   - Slice from lastUserIndex (u2) → [u2, a2, u3, a3]
    // - Add new prompt u4 → [u2, a2, u3, a3, u4]
    // - sanitizeGoogleTurnOrdering: first is u2 (user) → NO bootstrap
    // - API saw: [u2(0), a2(1), u3(2), a3(3), u4(4)]
    // - Error at messageIndex=4 → u4
    //
    // Strip function with historyTurnsLimit=2:
    // - effectiveLimit = 2 + 1 = 3
    // - windowed: with 4 user turns and limit 3, slice at 4th user (u1)
    //   - Returns [u2, a2, u3, a3, u4] (starts from u2)
    // - First windowed role is "user" → no bootstrap → offset = 0
    // - adjustedIndex = 4 - 0 = 4 → u4 ✓
    const entries = [
      { type: "session", version: 1, cwd: "/tmp" },
      {
        type: "message",
        id: "a",
        parentId: null,
        message: { role: "assistant", content: [{ type: "text", text: "root" }] },
      },
      {
        type: "message",
        id: "u1",
        parentId: "a",
        message: { role: "user", content: [{ type: "text", text: "user 1" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      },
      {
        type: "message",
        id: "u2",
        parentId: "a1",
        message: { role: "user", content: [{ type: "text", text: "user 2" }] },
      },
      {
        type: "message",
        id: "a2",
        parentId: "u2",
        message: { role: "assistant", content: [{ type: "text", text: "reply 2" }] },
      },
      {
        type: "message",
        id: "u3",
        parentId: "a2",
        message: { role: "user", content: [{ type: "text", text: "user 3" }] },
      },
      {
        type: "message",
        id: "a3",
        parentId: "u3",
        message: { role: "assistant", content: [{ type: "text", text: "reply 3" }] },
      },
      // Google turn ordering marker from a previous request
      {
        type: "custom",
        id: "marker",
        parentId: "a3",
        customType: "google-turn-ordering-bootstrap",
      },
      {
        type: "message",
        id: "u4",
        parentId: "marker",
        message: {
          role: "user",
          content: [
            { type: "text", text: "user 4 with image" },
            { type: "image", data: "big", mimeType: "image/png" },
          ],
        },
      },
    ];
    const file = writeSessionSync(entries);

    // API saw [u2, a2, u3, a3, u4] (indices 0-4). Error at messageIndex=4 targets u4.
    // First windowed message is "user", so no bootstrap was prepended → offset = 0.
    const stripped = await stripOversizedImageFromSession(file, 4, 1, { historyTurnsLimit: 2 });

    expect(stripped).toBe(true);

    const raw = await fsAsync.readFile(file, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Message u4 is at file index 9 (session=0, a=1, u1=2, a1=3, u2=4, a2=5, u3=6, a3=7, marker=8, u4=9)
    const msgU4 = lines[9];
    expect(msgU4.id).toBe("u4");
    expect(msgU4.message.content[1].type).toBe("text");
    expect(msgU4.message.content[1].text).toContain("omitted");

    // a3 should be untouched
    const msgA3 = lines[7];
    expect(msgA3.id).toBe("a3");
    expect(msgA3.message.content[0].text).toBe("reply 3");
  });
});

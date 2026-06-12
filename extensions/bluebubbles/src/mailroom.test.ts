import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLUEBUBBLES_MAILROOM_REGISTRY,
  BLUEBUBBLES_MAILROOM_VERBS,
  createBlueBubblesMailroomClient,
  isBlueBubblesMailroomVerb,
  runBlueBubblesMailroomCommand,
} from "./mailroom.js";

const testRoots: string[] = [];

async function makeQueueRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bluebubbles-mailroom-"));
  testRoots.push(root);
  await fs.mkdir(path.join(root, "threads"), { recursive: true });
  await fs.writeFile(
    path.join(root, "latest.json"),
    `${JSON.stringify({
      generated_at: "2026-06-12T12:00:00.000Z",
      items: [
        {
          rank: 1,
          thread_id: "thread-one",
          account_id: "default",
          reply_target: "+15551234567",
          sender_id: "+15551234567",
          sender_label: "Chris",
          preview: "Secret <body> & details",
          received_at: 1_780_000_000_000,
          attachments: 1,
          status: "pending",
        },
        {
          rank: 2,
          thread_id: "thread-two",
          account_id: "default",
          reply_target: "+15557654321",
          sender_id: "+15557654321",
          sender_label: "Unknown Sender",
          preview: "Unknown raw body should stay out of digest",
          received_at: 1_780_000_001_000,
          status: "pending",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, "threads", "thread-one.json"),
    `${JSON.stringify({
      thread_id: "thread-one",
      sender_id: "+15551234567",
      last_inbound_text: "Secret <body> & details",
      history: [{ direction: "inbound", text: "Secret <body> & details" }],
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, "threads", "thread-two.json"),
    `${JSON.stringify({
      thread_id: "thread-two",
      sender_id: "+15557654321",
      last_inbound_text: "Unknown raw body should stay out of digest",
    })}\n`,
    { mode: 0o600 },
  );
  return root;
}

async function statMode(filePath: string) {
  return (await fs.stat(filePath)).mode & 0o777;
}

describe("BlueBubbles mailroom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:30:00.000Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(testRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("no_outbound_verb_is_registered", () => {
    expect(BLUEBUBBLES_MAILROOM_VERBS).toEqual([
      "show",
      "draft",
      "hold",
      "close",
      "classify",
      "digest",
      "health",
    ]);
    expect(Object.keys(BLUEBUBBLES_MAILROOM_REGISTRY).sort()).toEqual([
      "classify",
      "close",
      "digest",
      "draft",
      "health",
      "hold",
      "show",
    ]);
    expect(isBlueBubblesMailroomVerb("show")).toBe(true);
    expect(isBlueBubblesMailroomVerb("reply")).toBe(false);
    expect(isBlueBubblesMailroomVerb("broadcast")).toBe(false);
  });

  it("mailroom_module_imports_no_send_code", async () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mailroom.ts");
    const source = await fs.readFile(sourcePath, "utf8");

    expect(source).not.toMatch(/from\s+["']\.\/(?:send|media-send|attachments|reactions|channel|chat)\.js["']/);
    expect(source).not.toContain("sendBlueBubblesTyping");
    expect(source).not.toContain("notifyApproval");
    expect(source).not.toContain("sendMessageBlueBubbles");
    expect(source).not.toContain("sendBlueBubblesMedia");
    expect(source).not.toContain("sendBlueBubblesAttachment");
    expect(source).not.toContain("sendBlueBubblesReaction");
  });

  it("show_returns_escaped_previews_and_never_raw_thread_body_fields", async () => {
    const rootDir = await makeQueueRoot();

    const result = await runBlueBubblesMailroomCommand({ rootDir }, { verb: "show", rank: 1 });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      verb: "show",
      item: {
        threadId: "thread-one",
        previewHtml: "Secret &lt;body&gt; &amp; details",
        attachments: 1,
      },
    });
    expect(serialized).not.toContain("Secret <body> & details");
    expect(serialized).not.toContain("last_inbound_text");
    expect(serialized).not.toContain("history");
  });

  it("unknown_sender_digest_contains_no_body_bytes", async () => {
    const rootDir = await makeQueueRoot();

    const result = await runBlueBubblesMailroomCommand(
      { rootDir },
      { verb: "digest", unknownOnly: true },
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      verb: "digest",
      items: [
        {
          rank: 2,
          threadId: "thread-two",
          senderLabel: "Unknown Sender",
        },
      ],
    });
    expect(serialized).not.toContain("previewHtml");
    expect(serialized).not.toContain("Unknown raw body should stay out of digest");
  });

  it("llm_steps_expose_no_tools", async () => {
    const rootDir = await makeQueueRoot();
    const draft = vi.fn(async () => ({ draft: "Acknowledged." }));
    const classify = vi.fn(async () => ({ label: "needs_reply", confidence: 0.9 }));
    const client = createBlueBubblesMailroomClient({
      rootDir,
      classifyAllowlist: ["+15551234567"],
      llm: { draft, classify },
    });

    await client.run({ verb: "draft", rank: 1 });
    await client.run({ verb: "classify", rank: 1 });

    expect(draft).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });

  it("classify_does_not_call_llm_for_non_allowlisted_sender", async () => {
    const rootDir = await makeQueueRoot();
    const classify = vi.fn(async () => ({ label: "needs_reply" }));

    const result = await runBlueBubblesMailroomCommand(
      { rootDir, classifyAllowlist: ["+15550000000"], llm: { classify } },
      { verb: "classify", rank: 1 },
    );

    expect(classify).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      verb: "classify",
      threadId: "thread-one",
      classification: {
        label: "not_allowlisted",
        confidence: null,
        source: "rule",
      },
    });
  });

  it("audit_and_annotation_stores_are_private_and_do_not_rewrite_queue_files", async () => {
    const rootDir = await makeQueueRoot();
    const latestPath = path.join(rootDir, "latest.json");
    const threadPath = path.join(rootDir, "threads", "thread-one.json");
    const latestBefore = await fs.readFile(latestPath, "utf8");
    const threadBefore = await fs.readFile(threadPath, "utf8");

    await runBlueBubblesMailroomCommand(
      { rootDir, now: () => new Date("2026-06-12T12:31:00.000Z") },
      { verb: "hold", rank: 1, reason: "waiting" },
    );

    expect(await fs.readFile(latestPath, "utf8")).toBe(latestBefore);
    expect(await fs.readFile(threadPath, "utf8")).toBe(threadBefore);
    expect(await statMode(path.join(rootDir, "annotations"))).toBe(0o700);
    expect(await statMode(path.join(rootDir, "audit"))).toBe(0o700);
    expect(await statMode(path.join(rootDir, "annotations", "thread-one.json"))).toBe(0o600);
    expect(await statMode(path.join(rootDir, "audit", "agent-events.ndjson"))).toBe(0o600);

    const audit = await fs.readFile(path.join(rootDir, "audit", "agent-events.ndjson"), "utf8");
    expect(audit).toContain("mailroom.hold");
    expect(audit).not.toContain("Secret <body> & details");
    expect(audit).not.toContain("+15551234567");
  });

  it("health_reports_permissions_and_freshness_without_autofix", async () => {
    const rootDir = await makeQueueRoot();

    const result = await runBlueBubblesMailroomCommand({ rootDir }, { verb: "health" });

    expect(result).toMatchObject({
      verb: "health",
      ok: true,
      latestCount: 2,
      threadCount: 2,
      freshnessMs: expect.any(Number),
      paths: {
        latest: { exists: true, mode: 0o600, typeOk: true, modeOk: true },
        threads: { exists: true, typeOk: true },
      },
    });
  });
});

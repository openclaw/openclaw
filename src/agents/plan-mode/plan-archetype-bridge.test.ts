/**
 * PR-14: tests for plan-archetype-bridge.ts orchestrator.
 *
 * The bridge is best-effort fire-and-forget. Tests focus on:
 *   - Markdown is persisted regardless of channel.
 *   - Telegram session → sendDocumentTelegram called with right args.
 *   - Web/CLI session → no Telegram send (markdown still persisted).
 *   - Send failure → caller does not throw, log.warn fires.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanAttachmentCaption,
  dispatchPlanArchetypeAttachment,
} from "./plan-archetype-bridge.js";

const FIXED_DATE = new Date("2026-04-18T12:00:00Z");

// Mock the SDK telegram seam so the bridge never actually opens a
// network socket. The bridge dynamic-imports `../../plugin-sdk/telegram.js`
// (which itself loads the bundled plugin's runtime-api lazily) — we
// intercept at the SDK-facade layer.
type SendDocArgs = [string, string, Record<string, unknown> | undefined];
const sendDocumentTelegramMock = vi.hoisted(() =>
  vi.fn(async (..._args: SendDocArgs) => ({
    messageId: "100",
    chatId: "tg-chat-1",
  })),
);
vi.mock("../../plugin-sdk/telegram.js", () => ({
  sendDocumentTelegram: sendDocumentTelegramMock,
}));

// Mock the session-store-read so we can control what
// deliveryContextFromSession sees without touching disk.
const readSessionStoreReadOnlyMock = vi.hoisted(() => vi.fn());
vi.mock("../../config/sessions/store-read.js", () => ({
  readSessionStoreReadOnly: readSessionStoreReadOnlyMock,
}));

// Stub the rest of the lookup chain (config/loadConfig, paths, routing).
vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ session: { store: undefined } }),
}));
vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: () => "/tmp/test-store.json",
}));
vi.mock("../../routing/session-key.js", () => ({
  parseAgentSessionKey: (k: string) => {
    const m = /^agent:([^:]+):/.exec(k);
    return m ? { agentId: m[1] } : undefined;
  },
}));

describe("buildPlanAttachmentCaption (PR-14)", () => {
  it("includes title + universal /plan resolution commands", () => {
    const caption = buildPlanAttachmentCaption("Refactor X", "Short summary");
    expect(caption).toContain("Refactor X");
    expect(caption).toContain("Short summary");
    expect(caption).toContain("/plan accept");
    expect(caption).toContain("/plan accept edits");
    expect(caption).toContain("/plan revise");
  });

  it("falls back to 'Plan' when title is undefined or empty", () => {
    expect(buildPlanAttachmentCaption(undefined, undefined)).toContain("<b>Plan</b>");
    expect(buildPlanAttachmentCaption("", undefined)).toContain("<b>Plan</b>");
  });

  it("HTML-escapes title + summary so injection in HTML parse_mode is neutralized", () => {
    const caption = buildPlanAttachmentCaption("<script>", "<img onerror=...>");
    expect(caption).toContain("&lt;script&gt;");
    expect(caption).toContain("&lt;img onerror=");
    expect(caption).not.toContain("<script>");
  });
});

describe("dispatchPlanArchetypeAttachment (PR-14)", () => {
  let tmpBase: string;

  beforeEach(async () => {
    sendDocumentTelegramMock.mockClear();
    readSessionStoreReadOnlyMock.mockReset();
    // Test base dir is passed as `persistBaseDir` instead of trying to
    // spy on os.homedir (ESM module namespaces are not configurable).
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bridge-"));
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  function makeDetails() {
    return {
      title: "Refactor websocket reconnect",
      summary: "Address the close-race condition",
      analysis: "Current state: races on close",
      plan: [
        { step: "Audit close handlers", status: "pending" },
        { step: "Add idempotency guard", status: "pending" },
      ],
      assumptions: ["Tests pass first run"],
      risks: [{ risk: "Reconnect storm", mitigation: "Backoff" }],
      verification: ["pnpm test src/ws"],
      references: ["src/ws/reconnect.ts:42"],
    };
  }

  it("Telegram session: persists markdown AND sends document via sendDocumentTelegram (C2 re-wire)", async () => {
    // PR-14 C2 re-wire (2026-04-20): the bridge now calls through
    // the public plugin-sdk facade. Mock verifies (1) exact file
    // path handed in, (2) caption is HTML-escaped, (3) parseMode
    // is "HTML", and (4) log reflects success.
    readSessionStoreReadOnlyMock.mockReturnValue({
      "agent:main:telegram:acct1:dm:peer1": {
        origin: { provider: "telegram", accountId: "acct1", threadId: 7 },
        deliveryContext: {
          channel: "telegram",
          to: "tg-chat-1",
          accountId: "acct1",
          threadId: 7,
        },
      },
    });

    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });

    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^plan-2026-04-18-refactor-websocket-reconnect\.md$/);
    const absPath = path.join(planDir, files[0] ?? "");

    expect(sendDocumentTelegramMock).toHaveBeenCalledTimes(1);
    const callArgs = sendDocumentTelegramMock.mock.calls[0];
    expect(callArgs?.[0]).toBe("tg-chat-1"); // to
    expect(callArgs?.[1]).toBe(absPath); // filePath
    expect(callArgs?.[2]?.parseMode).toBe("HTML");
    expect(callArgs?.[2]?.caption).toContain("Refactor websocket reconnect");
    expect(callArgs?.[2]?.caption).toContain("/plan accept");

    // Success log reflects delivery + returned chatId/messageId from
    // the mock. Distinguishes from the old "skipped" path.
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("plan-bridge: telegram attachment sent"),
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("chatId=tg-chat-1"));
  });

  it("Telegram topic-scoped target (chatId:topic:threadId): passes through to sendDocumentTelegram (SDK parses threadId)", async () => {
    // PR-14 C2 re-wire: `parseTelegramTarget` inside the SDK auto-
    // extracts `message_thread_id` from the `to` string. The bridge
    // passes `to` through unchanged; the SDK does the parsing.
    readSessionStoreReadOnlyMock.mockReturnValue({
      "agent:main:telegram:acct1:group:-100123:42": {
        deliveryContext: {
          channel: "telegram",
          to: "-100123:topic:42",
          accountId: "acct1",
        },
      },
    });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:group:-100123:42",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });
    expect(sendDocumentTelegramMock).toHaveBeenCalledTimes(1);
    // The `to` string is passed through unchanged — SDK parses the
    // :topic:threadId suffix on the other side.
    expect(sendDocumentTelegramMock.mock.calls[0]?.[0]).toBe("-100123:topic:42");
  });

  it("Web session: persists markdown but does NOT send to Telegram", async () => {
    readSessionStoreReadOnlyMock.mockReturnValue({
      "agent:main:main": {
        origin: { provider: "web" },
        deliveryContext: { channel: "web" },
      },
    });

    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:main",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });

    // Markdown still persisted (audit artifact for web sessions too).
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
    // No Telegram send.
    expect(sendDocumentTelegramMock).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("no telegram delivery"));
  });

  it("Telegram session missing 'to': persists but skips Telegram send", async () => {
    readSessionStoreReadOnlyMock.mockReturnValue({
      "agent:main:telegram:acct1:dm:peer1": {
        origin: { provider: "telegram", accountId: "acct1" },
        deliveryContext: { channel: "telegram", accountId: "acct1" }, // no `to`
      },
    });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });
    expect(sendDocumentTelegramMock).not.toHaveBeenCalled();
  });

  it("Telegram send throws: caller does not throw, warn logged, markdown still persisted (C2 re-wire)", async () => {
    // PR-14 C2 re-wire (2026-04-20): un-skipped. Verifies the
    // fire-and-forget contract — network failure on the document
    // send never surfaces to the agent runtime; it's logged-and-
    // swallowed so the approval flow still completes.
    readSessionStoreReadOnlyMock.mockReturnValue({
      "agent:main:telegram:acct1:dm:peer1": {
        deliveryContext: { channel: "telegram", to: "tg-chat-1", accountId: "acct1" },
      },
    });
    sendDocumentTelegramMock.mockRejectedValueOnce(new Error("network down"));

    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    // Must not throw.
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
    // Markdown still persisted before the failed send.
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
  });

  it("Multi-cycle: second exit_plan_mode same day produces -2.md suffix and fires both sends", async () => {
    // PR-14 C2 re-wire (2026-04-20): re-instated the two-send
    // assertion since Telegram delivery is live again. Collision-
    // suffix file persistence + per-cycle send are both contracted.
    readSessionStoreReadOnlyMock.mockReturnValue({
      "agent:main:telegram:acct1:dm:peer1": {
        deliveryContext: { channel: "telegram", to: "tg-chat-1", accountId: "acct1" },
      },
    });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:main:telegram:acct1:dm:peer1",
      agentId: "main",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(2);
    // Both files exist (sort order varies — `-2.md` sorts before `.md`
    // because `-` (0x2D) precedes `.` (0x2E) in ASCII).
    expect(files).toContain("plan-2026-04-18-refactor-websocket-reconnect.md");
    expect(files).toContain("plan-2026-04-18-refactor-websocket-reconnect-2.md");
    // Two cycles → two sends.
    expect(sendDocumentTelegramMock).toHaveBeenCalledTimes(2);
  });

  it("Missing SessionEntry (read returns undefined): no send, no throw", async () => {
    readSessionStoreReadOnlyMock.mockReturnValue({});
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await dispatchPlanArchetypeAttachment({
      sessionKey: "agent:ghost:main",
      agentId: "ghost",
      details: makeDetails(),
      log,
      nowMs: FIXED_DATE.getTime(),
      persistBaseDir: tmpBase,
    });
    expect(sendDocumentTelegramMock).not.toHaveBeenCalled();
    // Markdown still persisted (audit value).
    const planDir = path.join(tmpBase, "ghost", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
  });
});

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

  it("Telegram session: persists markdown + sends document with caption + threadId", async () => {
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

    // Markdown was persisted.
    const planDir = path.join(tmpBase, "main", "plans");
    const files = await fs.readdir(planDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^plan-2026-04-18-refactor-websocket-reconnect\.md$/);

    // Telegram document was sent with the right shape.
    expect(sendDocumentTelegramMock).toHaveBeenCalledOnce();
    const [chatArg, fileArg, optsArg] = sendDocumentTelegramMock.mock.calls[0];
    expect(chatArg).toBe("tg-chat-1");
    expect(fileArg).toContain(files[0]);
    expect(optsArg).toMatchObject({
      caption: expect.stringContaining("Refactor websocket reconnect"),
      parseMode: "HTML",
      messageThreadId: 7,
      accountId: "acct1",
    });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("telegram attachment sent"));
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

  it("Telegram send throws: caller does not throw, warn logged, markdown still persisted", async () => {
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

  it("Multi-cycle: second exit_plan_mode same day produces -2.md suffix", async () => {
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
    // Both Telegram sends fired.
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

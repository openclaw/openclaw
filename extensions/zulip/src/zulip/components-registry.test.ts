import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  claimZulipComponentEntry,
  consumeZulipComponentMessageEntries,
  loadZulipComponentRegistry,
  registerZulipComponentEntries,
} from "./components-registry.js";

function buildEntry(overrides: Partial<Parameters<typeof registerZulipComponentEntries>[0]["entries"][number]> = {}) {
  return {
    id: overrides.id ?? "btn_1",
    label: overrides.label ?? "Approve",
    style: overrides.style ?? "primary",
    sessionKey: overrides.sessionKey ?? "sess-1",
    agentId: overrides.agentId ?? "archie",
    accountId: overrides.accountId ?? "zulip-test",
    callbackData: overrides.callbackData,
    replyTo: overrides.replyTo ?? "stream:ops:topic:deploy",
    chatType: overrides.chatType ?? "channel",
    allowedUsers: overrides.allowedUsers,
    reusable: overrides.reusable,
  };
}

describe("components-registry", () => {
  let stateDir: string;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zulip-components-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    __testing.resetRegistries();
  });

  afterEach(() => {
    __testing.resetRegistries();
    if (originalStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists entries and reloads them after registry reset", async () => {
    await registerZulipComponentEntries({
      entries: [buildEntry()],
      messageId: 42,
    });

    __testing.resetRegistries();
    await loadZulipComponentRegistry("zulip-test");

    const claim = await claimZulipComponentEntry({
      accountId: "zulip-test",
      id: "btn_1",
      senderId: 7,
    });

    expect(claim.kind).toBe("ok");
    if (claim.kind === "ok") {
      expect(claim.entry.messageId).toBe(42);
      expect(claim.entry.replyTo).toBe("stream:ops:topic:deploy");
    }
  });

  it("consumes sibling buttons at message scope", async () => {
    await registerZulipComponentEntries({
      entries: [buildEntry({ id: "btn_a" }), buildEntry({ id: "btn_b", label: "Deny" })],
      messageId: 99,
    });

    const firstClaim = await claimZulipComponentEntry({
      accountId: "zulip-test",
      id: "btn_a",
      senderId: 7,
    });
    expect(firstClaim.kind).toBe("ok");

    await consumeZulipComponentMessageEntries({ accountId: "zulip-test", messageId: 99 });

    const siblingClaim = await claimZulipComponentEntry({
      accountId: "zulip-test",
      id: "btn_b",
      senderId: 7,
    });
    expect(siblingClaim).toEqual({ kind: "consumed" });
  });

  it("returns unauthorized without consuming the widget", async () => {
    await registerZulipComponentEntries({
      entries: [buildEntry({ allowedUsers: [42] })],
      messageId: 13,
    });

    const unauthorized = await claimZulipComponentEntry({
      accountId: "zulip-test",
      id: "btn_1",
      senderId: 7,
    });
    expect(unauthorized.kind).toBe("unauthorized");

    const authorized = await claimZulipComponentEntry({
      accountId: "zulip-test",
      id: "btn_1",
      senderId: 42,
    });
    expect(authorized.kind).toBe("ok");
  });

  it("prunes expired entries on reload", async () => {
    await registerZulipComponentEntries({
      entries: [buildEntry()],
      messageId: 5,
      callbackExpiresAtMs: Date.now() - 1_000,
    });

    __testing.resetRegistries();
    await loadZulipComponentRegistry("zulip-test");

    const claim = await claimZulipComponentEntry({
      accountId: "zulip-test",
      id: "btn_1",
      senderId: 7,
    });

    expect(claim).toEqual({ kind: "missing" });
  });
});

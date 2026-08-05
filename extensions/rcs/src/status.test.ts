import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// RCS tests cover surfacing outbound delivery/read receipts to the agent-visible
// channel status path.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRcsRuntime } from "./runtime.js";
import { recordRcsStatusEvent } from "./status-store.js";
import { buildRcsDeliveryStatusLines, formatRcsProbeLines } from "./status.js";
import { buildTwilioStatusEvent } from "./twilio.js";

const ACCOUNT_ID = "default";
let stateDir = "";

function bindRuntime(): void {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("rcs", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  setRcsRuntime(runtime);
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rcs-status-"));
  bindRuntime();
});

afterEach(() => {
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("buildRcsDeliveryStatusLines (agent-visible session-status path)", () => {
  it("returns nothing before any receipt is recorded", () => {
    expect(buildRcsDeliveryStatusLines(ACCOUNT_ID)).toEqual([]);
  });

  it("surfaces a recorded READ status callback as a read receipt", () => {
    // Full path: a Twilio EventType=READ callback -> parsed event -> recorded in
    // the status store -> surfaced on the agent-visible channel status path.
    const event = buildTwilioStatusEvent({
      MessageSid: "SM123",
      EventType: "READ",
      To: "rcs:+15551234567",
    });
    expect(event).not.toBeNull();
    recordRcsStatusEvent(ACCOUNT_ID, event!);

    const lines = buildRcsDeliveryStatusLines(ACCOUNT_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tone: "success" });
    expect(lines[0]?.text).toContain("Read receipt");
    expect(lines[0]?.text).toContain("SM123");
  });

  it("surfaces a recorded delivered status callback", () => {
    const event = buildTwilioStatusEvent({ MessageSid: "SM777", MessageStatus: "delivered" });
    recordRcsStatusEvent(ACCOUNT_ID, event!);

    const lines = buildRcsDeliveryStatusLines(ACCOUNT_ID);
    expect(lines[0]?.text).toContain("Delivered");
    expect(lines[0]?.text).toContain("SM777");
  });

  it("surfaces failures with a warning tone and error code", () => {
    const event = buildTwilioStatusEvent({
      MessageSid: "SM9",
      MessageStatus: "failed",
      ErrorCode: "30008",
    });
    recordRcsStatusEvent(ACCOUNT_ID, event!);

    const lines = buildRcsDeliveryStatusLines(ACCOUNT_ID);
    expect(lines[0]).toMatchObject({ tone: "warn" });
    expect(lines[0]?.text).toContain("30008");
  });

  it("keeps the most recent receipt when several arrive for the account", () => {
    recordRcsStatusEvent(
      ACCOUNT_ID,
      buildTwilioStatusEvent({ MessageSid: "SM1", MessageStatus: "sent" })!,
    );
    recordRcsStatusEvent(
      ACCOUNT_ID,
      buildTwilioStatusEvent({ MessageSid: "SM2", MessageStatus: "delivered" })!,
    );
    recordRcsStatusEvent(
      ACCOUNT_ID,
      buildTwilioStatusEvent({ MessageSid: "SM2", EventType: "READ" })!,
    );

    const lines = buildRcsDeliveryStatusLines(ACCOUNT_ID);
    expect(lines[0]?.text).toContain("Read receipt");
    expect(lines[0]?.text).toContain("SM2");
  });

  it("keeps delivery receipts across runtime restarts", () => {
    recordRcsStatusEvent(
      ACCOUNT_ID,
      buildTwilioStatusEvent({ MessageSid: "SM-persisted", MessageStatus: "delivered" })!,
    );

    bindRuntime();

    expect(buildRcsDeliveryStatusLines(ACCOUNT_ID)[0]?.text).toContain("SM-persisted");
  });
});

describe("formatRcsProbeLines read-receipt surfacing", () => {
  it("renders the probe recentStatus read event with a success tone", () => {
    const lines = formatRcsProbeLines({
      ok: true,
      webhook: { status: "skipped", reason: "test" },
      recentStatus: { messageSid: "SM55", status: "read" },
      hints: [],
    });
    const readLine = lines.find((line) => line.text.includes("Read receipt"));
    expect(readLine).toBeDefined();
    expect(readLine?.tone).toBe("success");
  });
});

// WhatsApp boundary-harness proof: admission for an already-queued (debounced)
// message is stamped at receive/normalize time and does not re-check config at
// flush time. Documents current behavior for a config revocation that happens
// while a message is waiting in the debounce pipeline (see docs/STATE.md).
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import {
  buildNotifyMessageUpsert,
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

const GROUP_JID = "120363401234567890@g.us";
const CREW_PARTICIPANT = "15551234567@s.whatsapp.net";
const CREW_E164 = "+15551234567";

function permissiveConfig(): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        groupPolicy: "allowlist",
        groupAllowFrom: [CREW_E164],
      },
    },
  } as never;
}

function revokedConfig(): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        groupPolicy: "allowlist",
        groupAllowFrom: [],
      },
    },
  } as never;
}

it("keeps a message's admission frozen at receive time when revocation lands while it is still queued in the debouncer", async () => {
  let cfg = permissiveConfig();
  const onMessage = vi.fn<InboxOnMessage>(async () => {});
  const { listener, sock } = await startInboxMonitor(onMessage, {
    cfg: cfg as never,
    loadConfig: () => cfg as never,
    debounceMs: 60_000,
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  try {
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "queued-before-revocation",
        remoteJid: GROUP_JID,
        participant: CREW_PARTICIPANT,
        text: "still in the debounce window",
        timestamp: 1_700_000_000,
      }),
    );
    await settleInboundWork();
    // Still parked in the debouncer: admission was already decided at receive
    // time, but flush has not happened yet.
    expect(onMessage).not.toHaveBeenCalled();

    // Operator revokes the sender's group access while the message is queued.
    cfg = revokedConfig();

    await vi.advanceTimersByTimeAsync(60_000);
    await waitForMessageCalls(onMessage, 1);

    const [flushed] = onMessage.mock.calls[0] as [
      { admission: { ingress: { admission: string } } },
    ];
    // FINDING: the queued message still flushes with its pre-revocation
    // "dispatch" admission. Revocation during the debounce window does not
    // retroactively isolate a message that was already admitted.
    expect(flushed.admission.ingress.admission).toBe("dispatch");

    // Control: a message arriving AFTER the revocation from the same sender is
    // correctly dropped before it ever reaches onMessage, showing the gap is
    // specific to messages already sitting in the pipeline, not the policy
    // check itself.
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "arrives-after-revocation",
        remoteJid: GROUP_JID,
        participant: CREW_PARTICIPANT,
        text: "sent after revocation",
        timestamp: 1_700_000_100,
      }),
    );
    await settleInboundWork();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onMessage).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    await listener.close();
  }
});

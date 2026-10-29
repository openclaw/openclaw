import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as replacementWorker from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveSourceReplyDelivery } from "../embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { deliverAgentCommandResult } from "./delivery.js";
import { persistMarker, runtime } from "./delivery.test-support.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

it("checkpoints canonical storage while preserving ordinary and opaque caller keys", async () => {
  await withAdminIngress(async ({ state }) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    for (const [requestKey, storedKey] of [
      [
        "agent:main:assist:01M21F31SCNCCQQ3N4X43AY420",
        "agent:main:assist:01m21f31scnccqq3n4x43ay420",
      ],
      ["main", "agent:main:main"],
      ["agent:main:signal:group:AbC=", "agent:main:signal:group:AbC="],
      ["agent:main:matrix:group:!Room:example.org", "agent:main:matrix:group:!Room:example.org"],
    ] as const) {
      const entry = { sessionId: requestKey, updatedAt: 1 };
      const target = { agentId: "main", storePath, sessionKey: storedKey };
      await replaceSessionEntry(target, entry);
      const sessionStore = { [requestKey]: entry };
      const payloads = [{ text: "Final for this exact route" }];
      const result = await persistMarker({ ...target, sessionKey: requestKey }, entry, payloads, {
        sessionStore,
        deliveryContext: { channel: "matrix", to: "!owner:example" },
      });
      expect(result.pendingFinalDeliveryMarkerPersisted, requestKey).toBe(true);
      const persisted = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
      expect(persisted?.pendingFinalDelivery?.intentId).toBe(result.pendingFinalDeliveryIntentId);
      expect(sessionStore[requestKey]).toEqual(persisted);
      expect(Object.keys(sessionStore)).toEqual([requestKey]);
      expect(
        getReplyPayloadMetadata(payloads[0]!)?.pendingFinalDeliveryCompletion?.sessionKey,
      ).toBe(requestKey);
    }
  });
});

it("rechecks live source authority when marker planning yields before its worker commit", async () => {
  await withAdminIngress(async ({ state }) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:marker-race",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: "marker-race", updatedAt: 1 };
    await replaceSessionEntry(target, entry);
    const read = () => loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
    const entered = createDeferred();
    const released = createDeferred();
    let current = true;
    const commit = replacementWorker.commitSessionEntryReplacementsInWorker;
    const committing = vi
      .spyOn(replacementWorker, "commitSessionEntryReplacementsInWorker")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await released.promise;
        return await commit(...args);
      });
    const pending = persistMarker(target, entry, [{ text: "Original final" }], {
      assertCurrent: () => {
        if (!current) {
          throw new Error("Marker source was revoked");
        }
      },
    });
    void pending.catch(() => {});
    try {
      await Promise.race([entered.promise, pending]);
      expect(committing).toHaveBeenCalledOnce();
      const before = expectDefined(read(), "Marker target is missing");
      expect(before.pendingFinalDelivery).toBeUndefined();
      current = false;
      released.resolve();
      await expect(pending).rejects.toThrow("Marker source was revoked");
      expect(read()?.pendingFinalDelivery).toBeUndefined();
    } finally {
      released.resolve();
      await pending.catch(() => {});
      committing.mockRestore();
    }
  });
});

it.each([
  ["confirmed source reply", { didDeliverSourceReplyViaMessageTool: true }, "delivered"],
  [
    "source progress without a final",
    {
      sourceReplyDelivered: true,
      messagingToolSourceReplyPayloads: [{ text: "Working", sourceReplyFinal: false }],
    },
    "missing",
  ],
  ["pending source delivery", { sourceReplyDeliveryState: "pending" }, "pending"],
  [
    "an unrelated outbound send",
    { didSendViaMessagingTool: true, messagingToolSentTexts: ["Elsewhere"] },
    "missing",
  ],
] satisfies Array<[string, Partial<EmbeddedAgentRunResult>, string]>)(
  "preserves reply satisfaction for %s when automatic delivery is disabled",
  async (_name, result, expected) => {
    setActivePluginRegistry(createTestRegistry());
    const delivered = await deliverAgentCommandResult({
      cfg: {},
      deps: {},
      runtime,
      opts: { message: "Private completion", deliver: false },
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [],
      result: { meta: { durationMs: 1 }, ...result },
    });

    expect(resolveSourceReplyDelivery(delivered)).toBe(expected);
  },
);

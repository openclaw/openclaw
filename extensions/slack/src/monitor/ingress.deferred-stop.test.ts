import type { ReceiverEvent } from "@slack/bolt";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackIngressTurnLifecycle } from "./ingress.js";
import { attachBoltIngress, createReceiverEvent, withQueue } from "./ingress.test-support.js";

describe("Slack deferred ingress shutdown", () => {
  it("settles a failed session-routed delivery before shutdown without losing retry facts", async () => {
    await withQueue(async (queue) => {
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:failed-session");
        throw new Error("session dispatch failed");
      });
      const { app, ingress, receive } = attachBoltIngress(queue, { adoptionStallTimeoutMs: 5_000 });
      vi.spyOn(app, "processEvent").mockImplementation(processEvent);
      ingress.start();
      try {
        await receive(createReceiverEvent("Ev-failed-session"));
        await ingress.waitForIdle();
        await ingress.stop();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "Ev-failed-session",
            attempts: 1,
            lastError: "session dispatch failed",
          }),
        ]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("joins a deferred reply's replay settlement after its Bolt handler returns", async () => {
    await withQueue(async (queue) => {
      const commitStarted = createDeferred<void>();
      const commitGate = createDeferred<void>();
      let settlement: Promise<void> | undefined;
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(event.customProperties);
        if (!lifecycle) {
          throw new Error("Missing Slack ingress lifecycle");
        }
        await lifecycle.onSessionRouted?.("agent:main:slack:deferred-stop");
        lifecycle.onDeferred();
        settlement = (async () => {
          commitStarted.resolve();
          await commitGate.promise;
          await lifecycle.onAdopted();
        })();
      });
      const { app, ingress, receive } = attachBoltIngress(queue, { adoptionStallTimeoutMs: 5_000 });
      vi.spyOn(app, "processEvent").mockImplementation(processEvent);
      ingress.start();
      let stopped = false;
      let stop: Promise<void> | undefined;
      try {
        await receive(createReceiverEvent("Ev-deferred-settlement"));
        await commitStarted.promise;
        await ingress.waitForIdle();
        stop = ingress.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        commitGate.resolve();
        await settlement;
        await stop;
        expect(stopped).toBe(true);
      } finally {
        commitGate.resolve();
        await settlement;
        await (stop ?? ingress.stop());
      }
    });
  });
});

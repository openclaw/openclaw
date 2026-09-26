import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import { isLiveTestEnabled } from "../../test-support.js";

const mockStalledHostname = "policy-abort-live.test";
let mockPolicyLookupStarted = false;
let mockPolicyLookupObservedSignal = false;
let mockPolicyLookupSignalAborted = false;
let mockPolicyLookupSettled = false;
let mockReleasePolicyLookup: (() => void) | undefined;

// Keep the real SSRF policy owner and replace only one DNS lookup with a
// controlled, never-settling preflight. The production signal remains the
// only way the lookup normally settles.
vi.mock("../infra/net/ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/ssrf.js")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: (
      hostname: string,
      params: Parameters<typeof actual.resolvePinnedHostnameWithPolicy>[1] = {},
    ) => {
      if (hostname !== mockStalledHostname) {
        return actual.resolvePinnedHostnameWithPolicy(hostname, params);
      }

      mockPolicyLookupStarted = true;
      mockPolicyLookupObservedSignal = params.signal !== undefined;
      return actual.resolvePinnedHostnameWithPolicy(hostname, {
        ...params,
        lookupFn: async (): Promise<LookupAddress[]> => {
          const result = new Promise<LookupAddress[]>((resolve, reject) => {
            const signal = params.signal;
            let finished = false;
            const cleanup = () => {
              signal?.removeEventListener("abort", onAbort);
              if (mockReleasePolicyLookup === release) {
                mockReleasePolicyLookup = undefined;
              }
            };
            const finish = (error?: Error) => {
              if (finished) {
                return;
              }
              finished = true;
              cleanup();
              if (error === undefined) {
                resolve([]);
              } else {
                reject(error);
              }
            };
            const release = () => finish(new Error("released stalled policy lookup"));
            const onAbort = () => {
              mockPolicyLookupSignalAborted = true;
              finish(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error("policy lookup aborted"),
              );
            };
            mockReleasePolicyLookup = release;
            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) {
                onAbort();
              }
            }
          });
          try {
            return await result;
          } finally {
            mockPolicyLookupSettled = true;
          }
        },
      });
    },
  };
});

const liveCdpUrl = process.env.OPENCLAW_LIVE_BROWSER_CDP_URL?.trim() ?? "";
const describeLive = isLiveTestEnabled() && liveCdpUrl ? describe : describe.skip;

describeLive("browser interaction policy abort (real Chromium/CDP)", () => {
  it(
    "settles a stalled DNS policy hover and recovers on the same transport",
    { timeout: 15_000 },
    async () => {
      const policy = {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: [mockStalledHostname],
      };
      const abortReason = new Error("live policy abort proof");
      const controller = new AbortController();
      const { createPageViaPlaywright, getPageForTargetId } = await import("./pw-session.js");
      const { closePlaywrightBrowserConnection, hasCachedPlaywrightBrowserConnection } =
        await import("./pw-session.js");
      const { hoverViaPlaywright } = await import("./pw-tools-core.interactions.js");
      const { getPageTextViaPlaywright } = await import("./pw-tools-core.activity.js");

      let created: Awaited<ReturnType<typeof createPageViaPlaywright>> | undefined;
      let page: Awaited<ReturnType<typeof getPageForTargetId>> | undefined;
      let targetId = "";
      let pending: Promise<void> | undefined;
      let pendingSettled = false;
      let pendingError: unknown;
      let recoveryActionSucceeded = false;
      let createdTabClosed = false;
      let connectionClosed: boolean;
      const startedAt = Date.now();

      try {
        created = await createPageViaPlaywright({
          cdpUrl: liveCdpUrl,
          url: "about:blank",
        });
        targetId = created.targetId;
        page = await getPageForTargetId({ cdpUrl: liveCdpUrl, targetId });
        await page.setContent(
          `<button id="policy-abort-trigger" onmouseenter="location.href='http://${mockStalledHostname}/'">trigger</button>`,
        );

        pending = hoverViaPlaywright({
          cdpUrl: liveCdpUrl,
          targetId,
          selector: "#policy-abort-trigger",
          ssrfPolicy: policy,
          signal: controller.signal,
          timeoutMs: 5_000,
        });
        void pending.then(
          () => {
            pendingSettled = true;
          },
          (error: unknown) => {
            pendingSettled = true;
            pendingError = error;
          },
        );

        await expect
          .poll(() => mockPolicyLookupStarted, { timeout: 3_000, interval: 20 })
          .toBe(true);
        expect(mockPolicyLookupSettled).toBe(false);

        controller.abort(abortReason);
        await expect.poll(() => pendingSettled, { timeout: 3_000, interval: 20 }).toBe(true);
        await pending.catch(() => {});

        expect(pendingError).toBe(abortReason);
        expect(mockPolicyLookupObservedSignal).toBe(true);
        expect(mockPolicyLookupSignalAborted).toBe(true);
        expect(mockPolicyLookupSettled).toBe(true);

        await page.setContent('<button id="policy-abort-recovery">recovery</button>');
        await hoverViaPlaywright({
          cdpUrl: liveCdpUrl,
          targetId,
          selector: "#policy-abort-recovery",
          ssrfPolicy: policy,
          timeoutMs: 5_000,
        });
        const recoveredText = await getPageTextViaPlaywright({
          cdpUrl: liveCdpUrl,
          targetId,
          selector: "#policy-abort-recovery",
        });
        expect(recoveredText.text).toBe("recovery");
        recoveryActionSucceeded = true;

        console.info(
          JSON.stringify({
            liveCdpTransport: true,
            policyLookupStarted: mockPolicyLookupStarted,
            policyLookupObservedSignal: mockPolicyLookupObservedSignal,
            policyLookupSignalAborted: mockPolicyLookupSignalAborted,
            callerAbortSettled: pendingSettled,
            callerAbortExactReason: pendingError === abortReason,
            policyLookupSettled: mockPolicyLookupSettled,
            recoveryActionSucceeded,
            settlementMs: Date.now() - startedAt,
          }),
        );
      } finally {
        mockReleasePolicyLookup?.();
        if (pending && !pendingSettled) {
          await expect
            .poll(() => pendingSettled, { timeout: 3_000, interval: 20 })
            .toBe(true)
            .catch(() => {});
        }
        if (created) {
          await created.close().catch(() => {});
          try {
            const pages = await (
              await import("./pw-session.js")
            ).listPagesViaPlaywright({
              cdpUrl: liveCdpUrl,
            });
            createdTabClosed = !pages.some((pageInfo) => pageInfo.targetId === targetId);
          } catch {
            createdTabClosed = false;
          }
        }
        await closePlaywrightBrowserConnection({ cdpUrl: liveCdpUrl }).catch(() => {});
        connectionClosed = !hasCachedPlaywrightBrowserConnection(liveCdpUrl);
        console.info(
          JSON.stringify({
            createdTabClosed,
            connectionClosed,
            cleanupComplete: createdTabClosed && connectionClosed,
          }),
        );
      }

      expect(recoveryActionSucceeded).toBe(true);
      expect(createdTabClosed).toBe(true);
      expect(connectionClosed).toBe(true);
    },
  );
});

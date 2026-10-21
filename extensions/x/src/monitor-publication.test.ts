import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openXAllowlist } from "./allowlist.js";
import { completedMonitor } from "./test-support/completed-monitor.js";
import { client, config, page, post } from "./test-support/monitor-fixture.js";
import { openXWorkOrigins } from "./work-origin.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

beforeEach(() => {
  vi.useFakeTimers();
  client.getXApi.mockReset();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

describe("X work-session publication admission", () => {
  it.each(["off", "no-link", "public", "protected", "guest"])(
    "attaches publication intent only for opted-in public maintainer context: %s",
    async (kind) => {
      const cfg = structuredClone(config);
      cfg.channels!.x!.autoPublishWorkSessions = kind !== "off" && kind !== "no-link";
      if (kind === "guest") {
        cfg.channels!.x!.guests = { enabled: true };
        cfg.messages = { queue: { mode: "collect" } };
        cfg.agents = {
          entries: { maintainer: { skills: [], tools: { fs: { workspaceOnly: true } } } },
        };
      }
      const test = completedMonitor({
        cfg,
        ...(kind === "no-link" ? { visibleSessionUrl: null } : {}),
        posts: [post("501", kind === "guest" ? "20" : "10")],
      });
      if (kind === "protected") {
        test.api.getPublicPosts.mockResolvedValue({
          ...page([post("500", "10", "Original thread"), post("501", "10")]),
          includes: { tweets: [], users: [{ id: "10", username: "author", protected: true }] },
        });
      }
      await test.run(async () => {
        expect(test.dispatch).toHaveBeenCalledOnce();
        const admission = test.resolveStable.mock.calls.find(
          ([input]) => input.contextBinding,
        )?.[0];
        expect(Boolean(admission?.childSessionPublication)).toBe(kind === "public");
        const origin = await openXWorkOrigins(test.runtime).lookup("agent:maintainer:work:example");
        expect(test.api.getPublicPosts).toHaveBeenCalledTimes(
          kind === "off" || kind === "no-link" || kind === "guest" ? 0 : 1,
        );
        if (kind === "guest") {
          expect(origin).toBeUndefined();
          expect(test.dispatch.mock.calls[0]![0].route.sessionKey).toBe(
            "agent:maintainer:x:group:500:guest:501",
          );
          expect(test.replies[0]?.text).toBe("I am on it.");
        } else {
          expect(origin).toEqual({
            accountId: "default",
            postId: "501",
            postUrl: "https://x.com/config_maintainer/status/501",
            authorHandle: "config_maintainer",
            conversationId: "500",
            senderTier: "maintainer",
          });
        }
      });
    },
  );

  it.each(["allowlist", "configuration"])(
    "retires the captured publication intent after %s changes, not unrelated account writes",
    async (change) => {
      const cfg = structuredClone(config);
      cfg.channels!.x!.autoPublishWorkSessions = true;
      setRuntimeConfigSnapshot(cfg);
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const test = completedMonitor({ cfg });
      const dispatch = test.dispatch.getMockImplementation()!;
      test.dispatch.mockImplementationOnce(async (plan) => {
        entered.resolve();
        await resume.promise;
        return dispatch(plan);
      });
      await test.run(async () => {
        try {
          await entered.promise;
          const publication = test.resolveStable.mock.calls.find(
            ([input]) => input.contextBinding,
          )?.[0].childSessionPublication;
          expect(publication).toBeDefined();
          expect(() => publication!.assertCurrent()).not.toThrow();
          await openXAllowlist(test.runtime).remove("other", "999");
          expect(() => publication!.assertCurrent()).not.toThrow();
          if (change === "allowlist") {
            await openXAllowlist(test.runtime).remove("default", "999");
          } else {
            const next = structuredClone(cfg);
            next.channels!.x!.autoPublishWorkSessions = false;
            setRuntimeConfigSnapshot(next);
          }
          expect(() => publication!.assertCurrent()).toThrow(
            change === "allowlist" ? "allowlist changed" : "publication policy changed",
          );
        } finally {
          resume.resolve();
        }
      }, "during");
    },
  );
});

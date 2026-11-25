import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterEach, expect, it, vi } from "vitest";
import { rememberIMessageReplyCache, resolveIMessageMessageId } from "./monitor-reply-cache.js";
import {
  hasPersistedIMessageEcho,
  rememberPersistedIMessageEcho,
} from "./monitor/persisted-echo-cache.js";
import { installIMessageFailingStateRuntimeForTest } from "./test-support/runtime.js";

afterEach(() => vi.restoreAllMocks());

it("reports the first persistence failure independently for reply and echo caches", async () => {
  installIMessageFailingStateRuntimeForTest();
  const log = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
  expect(await resolveIMessageMessageId("uncached-guid")).toBe("uncached-guid");
  await rememberIMessageReplyCache({
    accountId: "default",
    messageId: "outbound-guid",
    timestamp: Date.now(),
  });
  await rememberPersistedIMessageEcho({ scope: "test", text: "synthetic reply" });
  expect(await hasPersistedIMessageEcho({ scope: "test", text: "synthetic reply" })).toBe(false);
  expect(log.mock.calls).toEqual([
    ["imessage reply-cache: read disabled after first failure: Error: test plugin-state failure"],
    ["imessage echo-cache: write disabled after first failure: Error: test plugin-state failure"],
  ]);
});

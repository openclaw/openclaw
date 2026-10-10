import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { readSubagentOutput } from "./subagent-announce-output.js";
import {
  announceTesting,
  outputTesting,
  setSubagentAnnounceDeliveryDepsForTest,
} from "./subagent-announce-overrides.test-support.js";
import type { callSubagentLifecycleGateway } from "./subagent-announce.runtime.js";

vi.mock("./subagent-announce.runtime.js", () => ({
  callSubagentLifecycleGateway: async () => ({
    messages: [{ role: "assistant", content: "original runtime" }],
  }),
  dispatchGatewayMethodInProcess: async () => ({}),
  getRuntimeConfig: () => ({}),
  readSubagentSessionEntry: () => undefined,
  readSessionMessagesAsync: async () => [],
  resolveAgentIdFromSessionKey: () => "main",
  resolveSessionStorePathCore: () => "/unused",
  isEmbeddedAgentRunActive: () => false,
  waitForEmbeddedAgentRunEnd: async () => true,
}));

afterEach(() => {
  outputTesting.setDepsForTest();
  announceTesting.setDepsForTest();
  setSubagentAnnounceDeliveryDepsForTest();
});

it("uses late overrides through cached output imports and restores the remaining scope", async () => {
  const read = () => readSubagentOutput("agent:main:subagent:cached-import");
  const release = createDeferred<Awaited<ReturnType<typeof callSubagentLifecycleGateway>>>();
  await expect(read()).resolves.toBe("original runtime");
  announceTesting.setDepsForTest({
    callGateway: vi.fn<typeof callSubagentLifecycleGateway>().mockResolvedValue({
      messages: [{ role: "assistant", content: "announce scope" }],
    }),
  });
  await expect(read()).resolves.toBe("announce scope");
  const output = vi.fn<typeof callSubagentLifecycleGateway>().mockReturnValue(release.promise);
  outputTesting.setDepsForTest({ callGateway: output });
  const pending = read();
  try {
    expect(output).toHaveBeenCalledOnce();
    release.resolve({ messages: [{ role: "assistant", content: "output scope" }] });
    await expect(pending).resolves.toBe("output scope");
  } finally {
    release.resolve({ messages: [] });
    await pending;
  }
  outputTesting.setDepsForTest();
  await expect(read()).resolves.toBe("announce scope");
  announceTesting.setDepsForTest();
  await expect(read()).resolves.toBe("original runtime");
});

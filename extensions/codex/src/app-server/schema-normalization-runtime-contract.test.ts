import path from "node:path";
import {
  createParameterFreeTool,
  createPermissiveTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, expect, it } from "vitest";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexThreadStartParams as StartParams } from "./protocol.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThreadWithEmptySkillCatalog as startThread,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetThreadLifecycleTestFixtures);

it("preserves canonical specs and replaces threads when the tool catalog or schema changes", async () => {
  const root = tempDirs.make("openclaw-codex-schema-contract-");
  const cwd = path.join(root, "workspace");
  const bindingStore = createCodexTestBindingStore();
  let nextThreadId = 1;
  const request = createLifecycleRequest(async (method) => {
    if (method !== "thread/start") {
      throw new Error(`unexpected method: ${method}`);
    }
    return { ...threadStartResult(`thread-${nextThreadId++}`, cwd), serviceTier: "priority" };
  });
  const start = (dynamicTools: NonNullable<StartParams["dynamicTools"]>) =>
    startThread({
      client: { request } as never,
      params: createParams(path.join(root, "session.jsonl"), cwd),
      cwd,
      dynamicTools,
      appServer: { ...createAppServerOptions(), connectionClass: "local-loopback" },
      bindingStore,
    });
  const payload = () =>
    request.mock.calls.findLast(([method]) => method === "thread/start")?.[1] as
      | StartParams
      | undefined;
  expect((await start([])).threadId).toBe("thread-1");
  expect(payload()?.dynamicTools).toStrictEqual([]);

  const { name, description } = createParameterFreeTool("message");
  const tool = { type: "function" as const, name, description };
  expect((await start([{ ...tool, inputSchema: normalizedParameterFreeSchema() }])).threadId).toBe(
    "thread-2",
  );
  expect(payload()?.dynamicTools).toStrictEqual([
    { ...tool, inputSchema: normalizedParameterFreeSchema() },
  ]);
  expect(payload()).toMatchObject({
    cwd,
    model: "gpt-5.4-codex",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "OpenClaw",
    experimentalRawEvents: true,
  });
  expect(payload()?.modelProvider).toBeUndefined();
  expect(payload()?.developerInstructions).toEqual(expect.stringContaining("OpenClaw"));
  expect(
    (await start([{ ...tool, inputSchema: createPermissiveTool("message").parameters }])).threadId,
  ).toBe("thread-3");
});

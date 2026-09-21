import "./run-attempt.configured-mcp.test-support.js";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createCronAuthorityCapabilityFixture } from "./codex-app-server.test-fixtures.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  tempDir,
} from "./run-attempt-test-harness.js";

const { admitLocalOperatorCronAuthority, configureFakeMcp, mcpMocks, setupConfiguredMcpTestHooks } =
  await import("./run-attempt.configured-mcp.test-support.js");

setupConfiguredMcpTestHooks();

describe("runCodexAppServerAttempt configured MCP creator authority", () => {
  it("withholds final provenance when a sender-attributed turn cannot snapshot native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-sender-attributed-mcp.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-sender-attributed-mcp"));
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    params.senderId = "external-sender";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();

    expect(mcpMocks.authorityResolvers).toHaveLength(0);
    expect(mcpMocks.captureRefs).toHaveLength(1);
    expect(mcpMocks.captureRefs[0]!.value).toBeUndefined();
    expect(mcpMocks.captureCalls[0]!.storedNames).not.toContain("fake__show");
  });

  it.each([
    { name: "missing", capabilityRunId: undefined },
    { name: "wrong-run", capabilityRunId: "other-run" },
    { name: "remote-management", capabilityRunId: "same-run" },
    { name: "channel-owner-management", capabilityRunId: "same-run" },
  ])(
    "does not bind $name local-operator authority at Codex tool construction",
    async (testCase) => {
      const sessionFile = path.join(tempDir, `session-local-operator-${testCase.name}.jsonl`);
      const params = createParams(
        sessionFile,
        path.join(tempDir, `workspace-local-operator-${testCase.name}`),
      );
      configureFakeMcp(params);
      params.trigger = "user";
      params.senderIsOwner = false;
      if (testCase.capabilityRunId) {
        const capability = createCronAuthorityCapabilityFixture(
          testCase.capabilityRunId === "same-run" ? params.runId : testCase.capabilityRunId,
        );
        params.cronCreatorAuthorityCapability =
          testCase.capabilityRunId === "same-run"
            ? {
                ...capability,
                callerOrigin: { kind: "unknown" },
                managementEntitlement:
                  testCase.name === "channel-owner-management"
                    ? { source: "channel-owner", isCurrent: () => true }
                    : { source: "control-ui-admin" },
              }
            : capability;
      }

      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).resolves.toBeDefined();

      expect(mcpMocks.authorityResolvers).toHaveLength(0);
    },
  );

  it("lazily snapshots configured MCP through the local-operator resolver without replacing native MCP", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = false;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const threadStart = harness.requests.find((request) => request.method === "thread/start")
      ?.params as { config?: Record<string, unknown>; dynamicTools?: unknown } | undefined;
    expect(JSON.stringify(threadStart?.config ?? {})).toContain("fake");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).toContain("automations");
    expect(JSON.stringify(threadStart?.dynamicTools ?? [])).not.toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(0);

    expect(mcpMocks.authorityResolvers).toHaveLength(2);
    const authority = await mcpMocks.authorityResolvers[0]!();
    expect(authority.provenance).toEqual({ version: 1, source: "final-executable-surface" });
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(
      authority.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).not.toContain("fake__app_only");
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.staticCalls[0]).toMatchObject({
      sessionId: `cron-authority:${params.runId}`,
      manifestRegistry: params.preparedModelRuntime?.metadataSnapshot.manifestRegistry,
      retireSessionRuntimeAfterDispose: true,
    });
    expect(mcpMocks.staticCalls[0]).not.toHaveProperty("sessionKey");
    expect(mcpMocks.captureCalls.at(-1)?.storedNames).toContain("fake__show");
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("preserves advertised configured MCP names when capturing automation authority", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-mcp-names.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-local-mcp-names"));
    configureFakeMcp(params);
    params.config!.mcp!.servers!.fake!.codex = { defaultToolsApprovalMode: "approve" };
    params.toolsAllow = ["automations", "fake__*"];
    params.trigger = "user";
    admitLocalOperatorCronAuthority(params);
    mcpMocks.useRealStaticMcp = true;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    try {
      const threadStart = harness.requests.find((request) => request.method === "thread/start")
        ?.params as { dynamicTools?: CodexDynamicToolSpec[] } | undefined;
      const advertisedMcpNames = flattenCodexDynamicToolFunctions(threadStart?.dynamicTools)
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("fake__"))
        .toSorted();
      expect(advertisedMcpNames).toContain("fake__show");

      const authority = await mcpMocks.authorityResolvers[0]!();
      const inheritedMcpNames = authority.tools
        .map((tool) => (typeof tool === "string" ? tool : tool.name))
        .filter((name) => name.startsWith("fake__"))
        .toSorted();
      expect(inheritedMcpNames).toEqual(advertisedMcpNames);
    } finally {
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
  });

  it("offers explicit finite tools when inherited configured MCP discovery is incomplete", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-incomplete-mcp.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-incomplete-mcp"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);
    mcpMocks.staticDiagnosticNotice =
      "Configured MCP is incomplete for this scheduled run: fake: authentication required.";

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    await expect(mcpMocks.authorityResolvers[0]!()).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("rematerializes after one cron operation aborts pending materialization", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-aborted-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-aborted-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstOperation = new AbortController();
    const firstResolution = resolver({ signal: firstOperation.signal });
    firstOperation.abort(new Error("first cron call timed out"));

    await expect(firstResolution).rejects.toThrow("first cron call timed out");
    const secondResolution = await resolver({ signal: new AbortController().signal });

    expect(
      secondResolution.tools.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("fake__show");
    expect(mcpMocks.staticCalls).toHaveLength(2);
    expect(mcpMocks.dispose).toHaveBeenCalledTimes(2);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("shares one configured-MCP materialization across concurrent active cron operations", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-concurrent-mutation.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-concurrent-mutation"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const firstResolution = resolver({ signal: new AbortController().signal });
    const secondResolution = resolver({ signal: new AbortController().signal });

    expect(secondResolution).toBe(firstResolution);
    const [first, second] = await Promise.all([firstResolution, secondResolution]);
    expect(second).toBe(first);
    expect(mcpMocks.staticCalls).toHaveLength(1);
    expect(mcpMocks.dispose).toHaveBeenCalledOnce();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("retains an unrelated cached timeout when its operation signal aborts concurrently", async () => {
    const sessionFile = path.join(tempDir, "session-local-operator-unrelated-timeout.jsonl");
    const params = createParams(
      sessionFile,
      path.join(tempDir, "workspace-local-operator-unrelated-timeout"),
    );
    configureFakeMcp(params);
    params.trigger = "user";
    params.senderIsOwner = true;
    admitLocalOperatorCronAuthority(params);
    const failureGate = createDeferred<void>();
    mcpMocks.staticFailureGate = failureGate.promise;
    mcpMocks.staticFailure = Object.assign(new Error("configured MCP materialization timed out"), {
      name: "TimeoutError",
    });

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const resolver = mcpMocks.authorityResolvers[0]!;
    const operation = new AbortController();
    const firstResolution = resolver({ signal: operation.signal });
    operation.abort(new Error("cron tool call was cancelled"));
    failureGate.resolve();

    await expect(firstResolution).rejects.toThrow(
      "provide an explicit finite toolsAllow list containing only currently visible tools",
    );
    const secondResolution = resolver({ signal: new AbortController().signal });
    expect(secondResolution).toBe(firstResolution);
    await expect(secondResolution).rejects.toThrow("configured MCP materialization timed out");
    expect(mcpMocks.staticCalls).toHaveLength(1);

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });
});

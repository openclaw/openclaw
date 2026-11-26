import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { cleanupTempDirs } from "../../../test/helpers/temp-dir.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import { materializeStaticMcpToolsForHarnessRunCore } from "../agent-bundle-mcp-harness.js";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../agent-bundle-mcp-manager-api.js";
import { createMcpProbeFixture } from "../agent-bundle-mcp-probe.test-support.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../plugin-runtime-refresh.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import {
  runWithCodexNativeChildToolHost,
  retainCodexNativeChildToolSource,
} from "./native-child-tool-bindings.js";

it("admits a distinct child after foreground teardown only through its own live operator source", async () => {
  const abort = new AbortController();
  const sourceOperator = createTestOperatorAuthority({
    profileId: "owner",
    scopes: ["operator.read"],
    signal: abort.signal,
  });
  const fixture = await createAdmittedHostCapabilityTestFixture(
    {
      agentId: "main",
      runId: "parent-run",
      sessionId: "parent",
      sessionKey: "agent:main:parent",
      config: {},
    },
    { nativeModelPolicySupport: "exact", operatorAuthority: sourceOperator },
  );
  const parent = fixture.hostCapabilities;
  const source = retainCodexNativeChildToolSource(parent)!;
  const modelOnly = parent.retainSourceAuthority!()!;
  fixture.closeHost();
  fixture.closeAdmission();
  const request = {
    toolName: "read",
    childRunId: "codex:child",
    threadId: "child",
    assertCurrent: vi.fn(),
    signal: new AbortController().signal,
  };
  const execute = vi.fn(async (child: AgentHarnessHostCapabilities, runId: string) => {
    expect(child).not.toBe(parent);
    child.assertActive();
    expect(getGatewayToolCallerIdentity()).toMatchObject({
      sessionKey: request.childRunId,
      operationalRunInstance: { runId },
      operatorAuthority: sourceOperator,
    });
    expect(runId).not.toBe("parent-run");
    return 42;
  });
  try {
    expect(() => parent.assertActive()).toThrow();
    await expect(
      runWithCodexNativeChildToolHost(parent, modelOnly, request, execute),
    ).rejects.toThrow(/No retained/);
    await expect(
      runWithCodexNativeChildToolHost({ ...parent }, source, request, execute),
    ).rejects.toThrow(/No retained/);
    await expect(
      runWithCodexNativeChildToolHost(parent, { ...source }, request, execute),
    ).rejects.toThrow(/No retained/);
    const foreground = new AsyncWorkScope();
    const refresh = createAgentPluginRuntimeRefresh();
    const dispatchFromAppServer = refresh.run(() =>
      foreground.run(() => AsyncLocalStorage.snapshot()),
    );
    await foreground.drain();
    refresh.close();
    expect(
      await dispatchFromAppServer(() =>
        runWithCodexNativeChildToolHost(parent, source, request, (host, id) =>
          captureAsyncWorkTracker()(() => {
            captureAgentPluginRuntimeRefresh().assertCurrent();
            return execute(host, id);
          }),
        ),
      ),
    ).toBe(42);
    abort.abort(new Error("revoked"));
    await expect(runWithCodexNativeChildToolHost(parent, source, request, execute)).rejects.toThrow(
      /revoked/,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    modelOnly.release();
    source.release();
  }
});

it("calls a projected stdio MCP tool through a child-owned host after the parent closes", async () => {
  const dirs: string[] = [];
  const scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
  const fixture = await createMcpProbeFixture(dirs);
  const config = fixture.config();
  const owner = await createAdmittedHostCapabilityTestFixture(
    {
      config,
      agentId: "main",
      sessionId: "native-parent",
      sessionKey: "agent:main:native-parent",
      runId: "parent-mcp",
      workspaceDir: fixture.params.workspaceDir,
    },
    {
      nativeModelPolicySupport: "exact",
      operatorAuthority: createTestOperatorAuthority({
        profileId: "tester",
        scopes: ["operator.read"],
      }),
    },
  );
  const parent = owner.hostCapabilities;
  const source = retainCodexNativeChildToolSource(parent)!;
  const toolName = "healthy__probe";
  const request = {
    toolName,
    childRunId: "codex:child",
    threadId: "child-thread",
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
  owner.closeHost();
  owner.closeAdmission();
  try {
    const evidence = await runWithCodexNativeChildToolHost(
      parent,
      source,
      request,
      async (host) => {
        const view = await materializeStaticMcpToolsForHarnessRunCore({
          ...fixture.params,
          cfg: config,
          agentId: "main",
          storeAdmission: host,
          autoApproveCodexAppServerApprovals: true,
          retireSessionRuntimeAfterDispose: true,
        });
        try {
          const tools = host.bindToolSurface(view.tools);
          const tool = tools.find((t) => t.name === toolName);
          expect(tool).toBeDefined();
          return await tool!.execute("child-call", {});
        } finally {
          await view.dispose();
        }
      },
    );
    expect(evidence.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"label":"healthy"'),
        }),
      ]),
    );
  } finally {
    source.release();
    await disposeAllSessionMcpRuntimes();
    await scheduler.stop();
    cleanupTempDirs(dirs);
  }
});

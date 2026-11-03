import { expect, it } from "vitest";
import {
  buildDynamicTools,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";
import { threadStartResult } from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import type {
  createLeasedCodexLifecycleHarness,
  startOrResumeAttemptThreadWithoutSkills,
  CodexAttemptThreadInput as LifecycleInput,
} from "./thread-lifecycle.test-fixtures.js";

type WebSearchBindingFixtures = {
  createPaths: () => { sessionFile: string; workspaceDir: string };
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  createSequentialLifecycleHarness: (
    resume: (params?: unknown) => ReturnType<typeof threadStartResult>,
  ) => ReturnType<typeof createLeasedCodexLifecycleHarness>;
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeAttemptThreadWithoutSkills>;
  createDeferredNamedDynamicTool: (name: string) => LifecycleInput["dynamicTools"][number];
  preflightMethods: readonly string[];
};

/** Search-policy cases retain the binding suite's shared lifecycle setup and cleanup. */
export function registerThreadWebSearchBindingTests({
  createPaths,
  createParams,
  createSequentialLifecycleHarness,
  startOrResumeThread,
  createDeferredNamedDynamicTool,
  preflightMethods,
}: WebSearchBindingFixtures) {
  it("uses a transient Codex thread when runtime toolsAllow denies web_search", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);
    params.model = createCodexTestModel("codex");
    params.preparedWebSearchPolicy = { allowed: true, persistentAllowed: true };
    setCodexTestToolFactory(params, () => []);

    const fixture = await createSequentialLifecycleHarness(() => threadStartResult("thread-1"));
    const { client, request } = fixture;
    const policies: Array<[persistent: boolean | undefined, current: boolean]> = [];
    const start = async () => {
      const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
        params,
        undefined,
        { nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params) },
      );
      let persistentWebSearchAllowed: boolean | undefined;
      let webSearchAllowed = false;
      const tools = await buildDynamicTools({
        params,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sandboxSessionKey: params.sessionKey!,
        sandbox: null,
        nativeToolSurfaceEnabled,
        runAbortController: new AbortController(),
        sessionAgentId: "main",
        policyAgentId: "main",
        pluginConfig: {},
        onYieldDetected: () => {},
        onPersistentWebSearchPolicyResolved: (allowed) => {
          persistentWebSearchAllowed = allowed;
        },
        onWebSearchPolicyResolved: (allowed) => {
          webSearchAllowed = allowed;
        },
      });
      expect(tools).toEqual([]);
      policies.push([persistentWebSearchAllowed, webSearchAllowed]);
      return startOrResumeThread({
        client,
        params,
        nativeCodeModeEnabled: nativeToolSurfaceEnabled,
        persistentWebSearchAllowed,
        webSearchAllowed,
      });
    };

    await start();
    params.toolsAllow = ["message"];
    await fixture.endTurn("thread-1");
    const restrictedBinding = await start();
    const savedAfterRestriction = await readCodexAppServerBinding(sessionFile);
    params.toolsAllow = undefined;
    await fixture.endTurn("thread-2");
    const resumedBinding = await start();

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(restrictedBinding).not.toHaveProperty("liveThreadConfigFingerprint");
    expect(savedAfterRestriction?.threadId).toBe("thread-1");
    expect(resumedBinding.threadId).toBe("thread-1");
    expect(policies).toEqual([
      [true, true],
      [true, false],
      [true, true],
    ]);
    const lifecycle = request.mock.calls.filter(
      ([method]) => method === "thread/start" || method === "thread/resume",
    );
    expect(lifecycle.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/start",
      "thread/resume",
    ]);
    expect(lifecycle[0]?.[1]).toMatchObject({ config: { web_search: "cached" } });
    expect(lifecycle[1]?.[1]).toMatchObject({ config: { web_search: "disabled" } });
  });

  it("persists config-denied search when runtime toolsAllow also excludes web_search", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    const params = createParams(sessionFile, workspaceDir);

    const fixture = await createSequentialLifecycleHarness((requestParams) =>
      threadStartResult((requestParams as { threadId: string }).threadId),
    );
    const { client, request } = fixture;

    await startOrResumeThread({
      client,
      params,
      dynamicTools: [createDeferredNamedDynamicTool("web_search")],
      persistentWebSearchAllowed: true,
      webSearchAllowed: true,
    });
    params.config = { tools: { deny: ["web_search"] } };
    params.toolsAllow = ["message"];
    params.pluginHarnessToolPolicyScope = "conversation";
    await fixture.endTurn("thread-1");
    const startRestricted = () =>
      startOrResumeThread({
        client,
        params,
        nativeCodeModeEnabled: false,
        persistentWebSearchAllowed: false,
        webSearchAllowed: false,
      });
    const restrictedBinding = await startRestricted();
    await fixture.endTurn("thread-2");
    const resumedRestrictedBinding = await startRestricted();

    expect(restrictedBinding.threadId).toBe("thread-2");
    expect(resumedRestrictedBinding.threadId).toBe("thread-2");
    expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      ...preflightMethods,
      ...`thread/start thread/unsubscribe config/read thread/start thread/unsubscribe
      config/read thread/read thread/resume thread/inject_items`.split(/\s+/),
    ]);
  });
}

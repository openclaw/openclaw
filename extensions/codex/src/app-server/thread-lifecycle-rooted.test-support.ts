import { expect, it, vi } from "vitest";
import type { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle-run.js";
import type { CodexAttemptThreadInput as LifecycleInput } from "./thread-lifecycle.test-fixtures.js";
import { buildThreadResumeParams } from "./thread-requests.js";

export function registerRequiredRootThreadPolicyTests({
  createParams,
  createPaths,
  createThreadLifecycleAppServerOptions,
  startOrResumeThread,
}: {
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
  createPaths: () => { sessionFile: string; workspaceDir: string };
  createThreadLifecycleAppServerOptions: () => LifecycleInput["appServer"];
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeThreadImpl>;
}) {
  const createRootedParams = (): LifecycleInput["params"] => {
    const { sessionFile, workspaceDir } = createPaths();
    return { ...createParams(sessionFile, workspaceDir), requireWorkspaceOnly: true };
  };
  const flags = (names: string, enabled: boolean) =>
    Object.fromEntries(names.split(/\s+/).map((name) => [name, enabled]));
  it("removes every native capability from a required-workspace thread", async () => {
    const params = createRootedParams();
    params.conversationToolPolicy = { deny: ["exec"] };
    const request = await buildThreadResumeParams(params, {
      threadId: "thread-policy-restricted",
      appServer: createThreadLifecycleAppServerOptions(),
      dynamicTools: [],
      config: {
        ...flags(
          `features.apps features.current_time_reminder features.deferred_executor
          features.hooks features.image_generation features.memories features.multi_agent
          features.multi_agent_v2 features.plugins features.standalone_web_search features.token_budget
          orchestrator.mcp.enabled orchestrator.skills.enabled
          tools.experimental_request_user_input.enabled tools.update_plan.enabled`,
          true,
        ),
        mcp_servers: { inherited: { command: "unsafe" } },
        web_search: "live",
      },
      nativeCodeModeEnabled: false,
      hostSystemAgentActive: false,
      restrictedToolSurfaceInheritedMcpServerNames: ["inherited"],
    });

    expect(request.config).toMatchObject({
      ...flags(
        `features.apps features.artifact features.browser_use features.browser_use_external
        features.browser_use_full_cdp_access features.chronicle features.computer_use
        features.current_time_reminder features.default_mode_request_user_input
        features.deferred_executor features.hooks features.image_generation features.memories
        features.multi_agent features.multi_agent_v2 features.plugins features.request_permissions_tool
        features.skill_search features.shell_tool features.standalone_web_search features.token_budget
        features.unified_exec features.view_image features.web_search_cached features.web_search_request
        features.workspace_dependencies orchestrator.mcp.enabled orchestrator.skills.enabled
        skills.bundled.enabled skills.include_instructions tools.experimental_request_user_input.enabled
        tools.update_plan.enabled`,
        false,
      ),
      mcp_servers: { inherited: { command: "unsafe", enabled: false } },
      web_search: "disabled",
    });
  });

  it("refuses required-root execution when managed policy requires native hooks", async () => {
    const params = createRootedParams();
    params.sessionRoot = params.workspaceDir;
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: { featureRequirements: { hooks: true } } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(
      startOrResumeThread({
        client: { request } as never,
        params,
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        hostSystemAgentActive: false,
      }),
    ).rejects.toThrow("cannot override required feature hooks");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
    ]);
  });
}

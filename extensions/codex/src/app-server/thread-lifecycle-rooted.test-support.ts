import path from "node:path";
import { expect, it, vi } from "vitest";
import { tempDir } from "./run-attempt-test-harness.js";
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
  const PREFLIGHT_METHODS = ["config/read", "configRequirements/read"];
  it.each(["plugin", "required workspace"] as const)(
    "removes every native capability from an explicitly restricted thread: %s",
    (restriction) => {
      const params = createParams(
        path.join(tempDir, "conversation-policy-session.jsonl"),
        path.join(tempDir, "conversation-policy-workspace"),
      );
      params.conversationToolPolicy = { deny: ["exec"] };
      if (restriction === "plugin") {
        params.pluginHarnessToolPolicyRestricted = true;
      } else {
        params.requireWorkspaceOnly = true;
      }
      const request = buildThreadResumeParams(params, {
        threadId: "thread-policy-restricted",
        appServer: createThreadLifecycleAppServerOptions(),
        dynamicTools: [],
        config: {
          "features.apps": true,
          "features.current_time_reminder": true,
          "features.deferred_executor": true,
          "features.hooks": true,
          "features.image_generation": true,
          "features.memories": true,
          "features.multi_agent": true,
          "features.multi_agent_v2": true,
          "features.plugins": true,
          "features.standalone_web_search": true,
          "features.token_budget": true,
          "orchestrator.mcp.enabled": true,
          "orchestrator.skills.enabled": true,
          "tools.experimental_request_user_input.enabled": true,
          "tools.update_plan.enabled": true,
          mcp_servers: { inherited: { command: "unsafe" } },
          web_search: "live",
        },
        nativeCodeModeEnabled: false,
        hostSystemAgentActive: false,
        restrictedToolSurfaceInheritedMcpServerNames: ["inherited"],
      });

      expect(request.config).toMatchObject({
        "features.apps": false,
        "features.artifact": false,
        "features.browser_use": false,
        "features.browser_use_external": false,
        "features.browser_use_full_cdp_access": false,
        "features.chronicle": false,
        "features.computer_use": false,
        "features.current_time_reminder": false,
        "features.default_mode_request_user_input": false,
        "features.deferred_executor": false,
        "features.hooks": false,
        "features.image_generation": false,
        "features.memories": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.plugins": false,
        "features.request_permissions_tool": false,
        "features.skill_search": false,
        "features.shell_tool": false,
        "features.standalone_web_search": false,
        "features.token_budget": false,
        "features.unified_exec": false,
        "features.view_image": false,
        "features.web_search_cached": false,
        "features.web_search_request": false,
        "features.workspace_dependencies": false,
        "orchestrator.mcp.enabled": false,
        "orchestrator.skills.enabled": false,
        "skills.bundled.enabled": false,
        "skills.include_instructions": false,
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
        mcp_servers: { inherited: { command: "unsafe", enabled: false } },
        web_search: "disabled",
      });
    },
  );

  it.each(["shell_tool", "multi_agent", "hooks", "code_mode"])(
    "refuses required-root execution when managed policy requires native %s",
    async (feature) => {
      const { sessionFile, workspaceDir } = createPaths();
      const params = createParams(sessionFile, workspaceDir);
      params.requireWorkspaceOnly = true;
      params.sessionRoot = workspaceDir;
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
        }
        if (method === "configRequirements/read") {
          return { requirements: { featureRequirements: { [feature]: true } } };
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
      ).rejects.toThrow(`cannot override required feature ${feature}`);
      expect(request.mock.calls.map(([method]) => method)).toEqual([...PREFLIGHT_METHODS]);
    },
  );
}

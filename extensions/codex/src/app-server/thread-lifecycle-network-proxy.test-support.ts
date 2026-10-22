import { expect, it } from "vitest";
import {
  readCodexAppServerBinding,
  type writeCodexAppServerBinding as writeCodexAppServerBindingImpl,
} from "./session-binding.test-helpers.js";
import type {
  createLifecycleRequest,
  CodexAttemptThreadInput as LifecycleInput,
  startOrResumeAttemptThreadWithoutSkills,
} from "./thread-lifecycle.test-fixtures.js";

export function registerThreadNetworkProxyBindingTests({
  preflightMethods: PREFLIGHT_METHODS,
  createPaths,
  writeCodexAppServerBinding,
  createThreadLifecycleAppServerOptions,
  createFixedThreadRequest,
  startOrResumeThread,
  createParams,
}: {
  preflightMethods: readonly string[];
  createPaths: () => { sessionFile: string; workspaceDir: string };
  writeCodexAppServerBinding: typeof writeCodexAppServerBindingImpl;
  createThreadLifecycleAppServerOptions: () => LifecycleInput["appServer"];
  createFixedThreadRequest: (
    threadId: string,
    methods: string[],
  ) => ReturnType<typeof createLifecycleRequest>;
  startOrResumeThread: (
    input: Pick<LifecycleInput, "client"> & Partial<LifecycleInput>,
  ) => ReturnType<typeof startOrResumeAttemptThreadWithoutSkills>;
  createParams: (sessionFile: string, workspaceDir: string) => LifecycleInput["params"];
}) {
  function createNetworkProxyThreadLifecycleAppServerOptions() {
    const configPatch = {
      "features.network_proxy.enabled": true,
      default_permissions: "openclaw-network",
      permissions: {
        "openclaw-network": {
          filesystem: {
            ":minimal": "read",
            ":project_roots": {
              ".": "write",
            },
          },
          network: {
            enabled: true,
            domains: {
              "api.openai.com": "allow",
            },
            proxy_url: "http://127.0.0.1:3128",
          },
        },
      },
    };
    return {
      ...createThreadLifecycleAppServerOptions(),
      networkProxy: {
        profileName: "openclaw-network",
        configFingerprint: "test-network-proxy",
        configPatch,
      },
    };
  }

  it("starts a new thread when the network proxy config is not active on the binding", async () => {
    const { sessionFile, workspaceDir } = createPaths();
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const appServer = createNetworkProxyThreadLifecycleAppServerOptions();
    const request = createFixedThreadRequest("thread-network-proxy", ["thread/start"]);

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      appServer,
    });

    const requestCalls = request.mock.calls as unknown as Array<[string, { config?: unknown }]>;
    expect(requestCalls.map(([method]) => method)).toEqual([...PREFLIGHT_METHODS, "thread/start"]);
    expect(requestCalls.find(([method]) => method === "thread/start")?.[1]).not.toHaveProperty(
      "sandbox",
    );
    expect(requestCalls.find(([method]) => method === "thread/start")?.[1].config).toMatchObject(
      appServer.networkProxy.configPatch,
    );
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-network-proxy");
    expect(binding?.networkProxyProfileName).toBe("openclaw-network");
    expect(binding?.networkProxyConfigFingerprint).toBe(appServer.networkProxy.configFingerprint);
  });
}

type SandboxRuntime = typeof import("../../sandbox/runtime-status.js");

export const resolveSandboxRuntimeStatus: SandboxRuntime["resolveSandboxRuntimeStatus"] = () => ({
  agentId: "main",
  sessionKey: "agent:main:main",
  classificationAgentId: "main",
  classificationSessionKey: "agent:main:main",
  mainSessionKey: "agent:main:main",
  mode: "off",
  sandboxed: false,
  sandboxRequired: false,
  toolPolicy: {
    allow: [],
    deny: [],
    sources: {
      allow: { source: "default", key: "" },
      deny: { source: "default", key: "" },
    },
  },
});

export const withSandboxRuntimeStatusInWorker: SandboxRuntime["withSandboxRuntimeStatusInWorker"] =
  async (params, _source, consume) => await consume(resolveSandboxRuntimeStatus(params));

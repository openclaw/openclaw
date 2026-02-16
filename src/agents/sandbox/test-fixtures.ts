import type { SandboxContext } from "./types.js";

export function createSandboxTestContext(params?: {
  overrides?: Partial<SandboxContext>;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
}): SandboxContext {
  const overrides = params?.overrides ?? {};
  const { docker: _unusedDockerOverrides, ...sandboxOverrides } = overrides;
  const docker = {
    image: "smart-agent-neo-sandbox:bookworm-slim",
    containerPrefix: "smart-agent-neo-sbx-",
    network: "none",
    user: "1000:1000",
    workdir: "/workspace",
    readOnlyRoot: false,
    tmpfs: [],
    capDrop: [],
    seccompProfile: "",
    apparmorProfile: "",
    setupCommand: "",
    binds: [],
    dns: [],
    extraHosts: [],
    pidsLimit: 0,
    ...overrides.docker,
    ...params?.dockerOverrides,
  };

  return {
    enabled: true,
    sessionKey: "sandbox:test",
    workspaceDir: "/tmp/workspace",
    agentWorkspaceDir: "/tmp/workspace",
    workspaceAccess: "rw",
    containerName: "smart-agent-neo-sbx-test",
    containerWorkdir: "/workspace",
    tools: { allow: ["*"], deny: [] },
    browserAllowHostControl: false,
    ...sandboxOverrides,
    docker,
  };
}

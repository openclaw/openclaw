import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";

export function createSmolBackendSandboxConfig(
  overrides: Partial<CreateSandboxBackendParams["cfg"]["docker"]> = {},
  workspaceAccess: CreateSandboxBackendParams["cfg"]["workspaceAccess"] = "rw",
): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "smol",
    scope: "session",
    workspaceAccess,
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "configured",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
      env: {},
      ...overrides,
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: ["*"], deny: [] },
    prune: createSandboxPruneConfig(),
  };
}

export function createSmolRuntimeEntryFixture(runtimeId: string, image = "python:3.12-slim") {
  return {
    containerName: runtimeId,
    backendId: "smol",
    runtimeLabel: runtimeId,
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image,
    configLabelKind: "Image",
  } as const;
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const {
  ensureSandboxContainerMock,
  ensureSandboxBrowserMock,
  loadCredentialBagMock,
  loadNetworkPolicyMock,
} = vi.hoisted(() => ({
  ensureSandboxContainerMock: vi.fn(async () => "openclaw-sbx-test"),
  ensureSandboxBrowserMock: vi.fn(async () => null),
  loadCredentialBagMock: vi.fn(),
  loadNetworkPolicyMock: vi.fn(),
}));

vi.mock("./sandbox/docker.js", () => ({
  ensureSandboxContainer: ensureSandboxContainerMock,
}));
vi.mock("./sandbox/browser.js", () => ({
  ensureSandboxBrowser: ensureSandboxBrowserMock,
}));
vi.mock("./sandbox/prune.js", () => ({
  maybePruneSandboxes: vi.fn(async () => undefined),
}));
vi.mock("./sandbox/credential-bag.js", () => ({
  loadCredentialBagForAgent: loadCredentialBagMock,
}));
vi.mock("./sandbox/network-policy.js", () => ({
  loadNetworkPolicyForAgent: loadNetworkPolicyMock,
}));

import { resolveSandboxContext } from "./sandbox/context.js";

// RI-025 + RI-026 activation wiring (Block 1.5 item #2).
// These tests prove that `resolveSandboxContext` — the single spawn-site
// orchestrator for every sandbox container in OpenClaw — loads the per-agent
// credential bag and network policy from their module-level loaders and
// threads them into both `ensureSandboxContainer` and `ensureSandboxBrowser`.
// The loaders themselves are unit-tested in credential-bag.test.ts /
// network-policy.test.ts; here we only care that the activation points wire
// the resolved values to the spawn calls.
describe("resolveSandboxContext credential + network policy wiring", () => {
  beforeEach(() => {
    ensureSandboxContainerMock.mockClear();
    ensureSandboxBrowserMock.mockClear();
    loadCredentialBagMock.mockReset();
    loadNetworkPolicyMock.mockReset();
  });

  const buildConfig = async (): Promise<{ cfg: OpenClawConfig; workspaceDir: string }> => {
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wiring-bundled-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wiring-ws-"));
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "rw",
            workspaceRoot: path.join(bundledDir, "sandboxes"),
          },
        },
        list: [{ id: "main" }],
      },
    };
    return { cfg, workspaceDir };
  };

  it("loads bag + policy for the resolved agentId and forwards to container spawn", async () => {
    const { cfg, workspaceDir } = await buildConfig();
    const bag = { agentId: "main", vars: { ANTHROPIC_API_KEY: "sk-test-123" } };
    const policy = { agentId: "main", mode: "none" as const };
    loadCredentialBagMock.mockReturnValue(bag);
    loadNetworkPolicyMock.mockReturnValue(policy);

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:work",
      workspaceDir,
    });

    expect(context?.enabled).toBe(true);
    expect(loadCredentialBagMock).toHaveBeenCalledWith("main");
    expect(loadNetworkPolicyMock).toHaveBeenCalledWith("main");
    expect(ensureSandboxContainerMock).toHaveBeenCalledTimes(1);
    expect(ensureSandboxContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialBag: bag, networkPolicy: policy }),
    );
  }, 15_000);

  it("passes null to spawn when loaders return null (missing files on disk)", async () => {
    const { cfg, workspaceDir } = await buildConfig();
    loadCredentialBagMock.mockReturnValue(null);
    loadNetworkPolicyMock.mockReturnValue(null);

    await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:work",
      workspaceDir,
    });

    expect(ensureSandboxContainerMock).toHaveBeenCalledTimes(1);
    expect(ensureSandboxContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialBag: null, networkPolicy: null }),
    );
  }, 15_000);

  it("forwards bag + policy to the browser spawn path as well", async () => {
    const { cfg, workspaceDir } = await buildConfig();
    // Enable the sandbox browser so ensureSandboxBrowser is actually called.
    cfg.agents!.defaults!.sandbox!.browser = { enabled: true };
    const bag = { agentId: "main", vars: { GH_TOKEN: "ghp_test_token_0000" } };
    const policy = { agentId: "main", mode: "open" as const };
    loadCredentialBagMock.mockReturnValue(bag);
    loadNetworkPolicyMock.mockReturnValue(policy);

    await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:work",
      workspaceDir,
    });

    expect(ensureSandboxBrowserMock).toHaveBeenCalledTimes(1);
    expect(ensureSandboxBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialBag: bag, networkPolicy: policy }),
    );
  }, 15_000);
});

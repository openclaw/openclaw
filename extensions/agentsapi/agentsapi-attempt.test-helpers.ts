import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import {
  createWorkspaceAttachmentPreparer,
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { onTestFinished, vi } from "vitest";
import { createModel } from "./agentsapi.test-support.js";

export function createAttemptParams({
  hostCapabilities,
  ...overrides
}: Omit<Partial<AgentHarnessAttemptParamsV2>, "hostCapabilities"> & {
  hostCapabilities?: Partial<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
} = {}): AgentHarnessAttemptParamsV2 {
  const authStorage = overrides.authStorage ?? AuthStorage.inMemory();
  return {
    sessionId: "local-fixture",
    sessionKey: "agent:main:fixture",
    sessionFile: "/fixture/session.jsonl",
    agentId: "main",
    workspaceDir: "/fixture/project",
    runId: "run-fixture",
    timeoutMs: 1_000,
    prompt: "Fixture prompt",
    provider: "openai",
    modelId: "fixture-model",
    model: createModel(),
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: overrides.modelRegistry ?? ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
    resolvedApiKey: "fixture-not-a-real-api-key",
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async ({ params }) => ({ blocked: false, params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
      ...hostCapabilities,
    },
    ...overrides,
  };
}

export async function createWorkspaceAttachmentFixture(directory: string) {
  const gatewayRoot = path.join(directory, "gateway");
  const remoteRoot = path.join(directory, "executor");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(directory, "state"));
  await fs.mkdir(gatewayRoot);
  await fs.mkdir(remoteRoot);
  const bridge: AgentWorkspaceAccess["bridge"] = {
    readFile: ({ filePath }) => fs.readFile(path.join(remoteRoot, filePath)),
    writeFile: async () => {
      throw new Error("Attachment staging must use exclusive creation");
    },
    async createFileExclusive({ filePath, data, mkdir }) {
      const destination = path.join(remoteRoot, filePath);
      if (mkdir) {
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      }
      try {
        await fs.writeFile(destination, data, { flag: "wx", mode: 0o600 });
        return "created";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return "exists";
        }
        throw error;
      }
    },
    async stat({ filePath }) {
      try {
        const stat = await fs.stat(path.join(remoteRoot, filePath));
        return {
          type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
  };
  const release = registerAgentWorkspaceAccess(gatewayRoot, {
    bridge,
    prepareTurnAttachments: createWorkspaceAttachmentPreparer({
      remoteRoot,
      createBridge: () => ({
        readFile: bridge.readFile,
        stat: bridge.stat,
        createFileExclusive: bridge.createFileExclusive!,
      }),
    }),
  });
  onTestFinished(release);
  return { gatewayRoot, remoteRoot, release };
}

/** DM-vs-group canary tests proving MEMORY.md privacy boundary via production session key chain. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { buildAgentPeerSessionKey, isSharedChannelSessionKey } from "../routing/session-key.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

describe("DM-vs-group canary: MEMORY.md privacy boundary via production session key chain", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  const ALL_BOOTSTRAP_FILES: Array<[string, string]> = [
    ["AGENTS.md", "project rules"],
    ["TOOLS.md", "tool rules"],
    ["SOUL.md", "persona"],
    ["IDENTITY.md", "identity"],
    ["USER.md", "user profile"],
    ["MEMORY.md", "canary:REDACTED-PRIVATE-MEMORY-108881"],
    ["HEARTBEAT.md", "heartbeat"],
    ["BOOTSTRAP.md", "setup"],
  ];

  async function createCanaryWorkspace(): Promise<string> {
    const workspaceDir = await makeTempWorkspace("openclaw-canary-");
    await Promise.all(
      ALL_BOOTSTRAP_FILES.map(([fileName, content]) =>
        fs.writeFile(path.join(workspaceDir, fileName), content, "utf8"),
      ),
    );
    return workspaceDir;
  }

  interface CanaryTestCase {
    label: string;
    sessionKey: string;
    expectMemoryIncluded: boolean;
    buildVia: "direct" | "buildAgentPeerSessionKey";
    channel: string;
    peerKind: "group" | "channel" | "direct";
    peerId: string;
  }

  const CANARY_CASES: readonly CanaryTestCase[] = [
    {
      label: "Telegram group (supergroup)",
      sessionKey: "agent:main:telegram:group:-1001234567890",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "telegram",
      peerKind: "group",
      peerId: "-1001234567890",
    },
    {
      label: "Telegram group with topic thread",
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "telegram",
      peerKind: "group",
      peerId: "-1001234567890",
    },
    {
      label: "Telegram DM (per-channel-peer scope)",
      sessionKey: "agent:main:telegram:direct:123456",
      expectMemoryIncluded: true,
      buildVia: "buildAgentPeerSessionKey",
      channel: "telegram",
      peerKind: "direct",
      peerId: "123456",
    },
    {
      label: "Discord guild channel",
      sessionKey: "agent:main:discord:channel:c1",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "discord",
      peerKind: "channel",
      peerId: "c1",
    },
    {
      label: "Discord group DM",
      sessionKey: "agent:main:discord:group:group-dm-1",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "discord",
      peerKind: "group",
      peerId: "group-dm-1",
    },
    {
      label: "Discord DM (per-channel-peer scope)",
      sessionKey: "agent:main:discord:direct:user1",
      expectMemoryIncluded: true,
      buildVia: "buildAgentPeerSessionKey",
      channel: "discord",
      peerKind: "direct",
      peerId: "user1",
    },
    {
      label: "Slack channel",
      sessionKey: "agent:main:slack:channel:general",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "slack",
      peerKind: "channel",
      peerId: "general",
    },
    {
      label: "WhatsApp group (JID format)",
      sessionKey: "agent:main:whatsapp:123456789@g.us",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "whatsapp",
      peerKind: "group",
      peerId: "123456789@g.us",
    },
    {
      label: "WhatsApp DM",
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      expectMemoryIncluded: true,
      buildVia: "buildAgentPeerSessionKey",
      channel: "whatsapp",
      peerKind: "direct",
      peerId: "+15551234567",
    },
    {
      label: "Matrix channel",
      sessionKey: "agent:main:matrix:channel:!Room:example.org",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "matrix",
      peerKind: "channel",
      peerId: "!Room:example.org",
    },
    {
      label: "Signal group",
      sessionKey: "agent:main:signal:group:AbC123",
      expectMemoryIncluded: false,
      buildVia: "buildAgentPeerSessionKey",
      channel: "signal",
      peerKind: "group",
      peerId: "AbC123",
    },
    {
      label: "Agent main session (default DM scope)",
      sessionKey: "agent:main:main",
      expectMemoryIncluded: true,
      buildVia: "buildAgentPeerSessionKey",
      channel: "telegram",
      peerKind: "direct",
      peerId: "",
    },
  ];

  it.each(CANARY_CASES)(
    "$label: sessionKey=$sessionKey => MEMORY.md $expectMemoryIncluded",
    async ({ sessionKey, expectMemoryIncluded, buildVia, channel, peerKind, peerId }) => {
      const workspaceDir = await createCanaryWorkspace();

      let resolvedKey = sessionKey;
      if (buildVia === "buildAgentPeerSessionKey") {
        resolvedKey = buildAgentPeerSessionKey({
          agentId: "main",
          channel,
          peerKind,
          peerId: peerId || undefined,
          dmScope: peerKind === "direct" && !peerId ? "main" : "per-channel-peer",
        });
      }

      expect(isSharedChannelSessionKey(resolvedKey)).toBe(!expectMemoryIncluded);

      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        sessionKey: resolvedKey,
      });

      const names = files.map((f) => f.name);
      const memoryPresent = names.includes("MEMORY.md");

      if (expectMemoryIncluded) {
        expect(memoryPresent).toBe(true);
        const memoryFile = files.find((f) => f.name === "MEMORY.md");
        expect(memoryFile?.content).toContain("canary:REDACTED-PRIVATE-MEMORY-108881");
      } else {
        expect(memoryPresent).toBe(false);
        for (const file of files) {
          expect(file.content).not.toContain("REDACTED-PRIVATE-MEMORY-108881");
        }
        expect(names).toContain("AGENTS.md");
        expect(names).toContain("SOUL.md");
        expect(names).toContain("USER.md");
      }
    },
  );

  it("Telegram group: hook-injected MEMORY.md is stripped by enforcePrivateMemoryBoundary", async () => {
    const workspaceDir = await createCanaryWorkspace();
    const groupKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      peerKind: "group",
      peerId: "-1001234567890",
    });

    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "MEMORY.md",
          path: path.join(context.workspaceDir, "MEMORY.md"),
          content: "hook-injected canary:REDACTED-PRIVATE-MEMORY-108881",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: groupKey,
    });

    expect(files.map((f) => f.name)).not.toContain("MEMORY.md");
    for (const file of files) {
      expect(file.content).not.toContain("REDACTED-PRIVATE-MEMORY-108881");
    }
  });

  it("Discord channel: hook-injected lowercase memory.md is stripped", async () => {
    const workspaceDir = await createCanaryWorkspace();
    const channelKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "discord",
      peerKind: "channel",
      peerId: "dev-channel",
    });

    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "memory.md",
          path: path.join(context.workspaceDir, "memory.md"),
          content: "hook-injected lowercase canary:REDACTED-PRIVATE-MEMORY-108881",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: channelKey,
    });

    expect(files.map((f) => f.name)).not.toContain("memory.md");
    expect(files.map((f) => f.name)).not.toContain("MEMORY.md");
    for (const file of files) {
      expect(file.content).not.toContain("REDACTED-PRIVATE-MEMORY-108881");
    }
  });

  it("Telegram DM: MEMORY.md is present and hook does not strip it", async () => {
    const workspaceDir = await createCanaryWorkspace();
    const dmKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      peerKind: "direct",
      peerId: "123456",
      dmScope: "per-channel-peer",
    });

    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra context",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: dmKey,
    });

    const names = files.map((f) => f.name);
    expect(names).toContain("MEMORY.md");
    expect(names).toContain("EXTRA.md");
    const memoryFile = files.find((f) => f.name === "MEMORY.md");
    expect(memoryFile?.content).toContain("canary:REDACTED-PRIVATE-MEMORY-108881");
  });

  it("Discord guild/channel legacy format: MEMORY.md excluded", async () => {
    const workspaceDir = await createCanaryWorkspace();
    const legacyKey = "agent:main:discord:guild-123:channel-456";

    expect(isSharedChannelSessionKey(legacyKey)).toBe(true);

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: legacyKey,
    });

    expect(files.map((f) => f.name)).not.toContain("MEMORY.md");
    for (const file of files) {
      expect(file.content).not.toContain("REDACTED-PRIVATE-MEMORY-108881");
    }
  });

  it("Feishu group with nested topic/sender: MEMORY.md excluded", async () => {
    const workspaceDir = await createCanaryWorkspace();
    const feishuKey = "agent:main:feishu:group:oc_chat:topic:om_root:sender:ou_user";

    expect(isSharedChannelSessionKey(feishuKey)).toBe(true);

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: feishuKey,
    });

    expect(files.map((f) => f.name)).not.toContain("MEMORY.md");
  });

  it("DM-vs-group asymmetry: same workspace, same MEMORY.md, different access", async () => {
    const workspaceDir = await createCanaryWorkspace();

    const groupKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      peerKind: "group",
      peerId: "-1001234567890",
    });
    const dmKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      peerKind: "direct",
      peerId: "123456",
      dmScope: "per-channel-peer",
    });

    const groupFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: groupKey,
    });
    const dmFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: dmKey,
    });

    expect(groupFiles.map((f) => f.name)).not.toContain("MEMORY.md");
    expect(dmFiles.map((f) => f.name)).toContain("MEMORY.md");

    const dmMemory = dmFiles.find((f) => f.name === "MEMORY.md");
    expect(dmMemory?.content).toContain("canary:REDACTED-PRIVATE-MEMORY-108881");

    for (const file of groupFiles) {
      expect(file.content).not.toContain("REDACTED-PRIVATE-MEMORY-108881");
    }
  });
});

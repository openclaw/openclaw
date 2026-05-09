import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import {
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
} from "./conversation-control.js";

let tempDir: string;

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

describe("codex conversation controls", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearRuntimeAuthProfileStoreSnapshots();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists fast mode and permissions for later bound turns", async () => {
    const sessionId = "session";
    await writeCodexAppServerBinding(sessionId, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setCodexConversationFastMode({ sessionId, enabled: true })).resolves.toBe(
      "Codex fast mode enabled.",
    );
    await expect(setCodexConversationPermissions({ sessionId, mode: "default" })).resolves.toBe(
      "Codex permissions set to default.",
    );

    await expect(readCodexAppServerBinding(sessionId)).resolves.toMatchObject({
      threadId: "thread-1",
      serviceTier: "priority",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("does not persist public OpenAI provider after model changes on native auth bindings", async () => {
    const sessionId = "session";
    upsertAuthProfile({
      profileId: "work",
      credential: {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    await writeCodexAppServerBinding(sessionId, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-1", cwd: tempDir },
        model: "gpt-5.5",
        modelProvider: "openai",
      })),
    });

    await expect(setCodexConversationModel({ sessionId, model: "gpt-5.5" })).resolves.toBe(
      "Codex model set to gpt-5.5.",
    );

    const binding = await readCodexAppServerBinding(sessionId);
    expect(binding).toMatchObject({
      threadId: "thread-1",
      authProfileId: "work",
      model: "gpt-5.5",
    });
    expect(binding?.modelProvider).toBeUndefined();
  });

  it("escapes model names returned from Codex before chat display", async () => {
    const sessionId = "session";
    await writeCodexAppServerBinding(sessionId, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({
        thread: { id: "thread-1", cwd: tempDir },
        model: "gpt-5.5 <@U123> [trusted](https://evil)",
        modelProvider: "openai",
      })),
    });

    await expect(setCodexConversationModel({ sessionId, model: "gpt-5.5" })).resolves.toBe(
      "Codex model set to gpt-5.5 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09.",
    );
  });
});

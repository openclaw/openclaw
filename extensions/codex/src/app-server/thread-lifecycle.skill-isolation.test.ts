import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { registerCodexTestSessionIdentity } from "./session-binding.test-helpers.js";
import { createAppServerOptions, startOrResumeThread } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

it("reuses isolated retained threads until native skills change", async () => {
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, "isolated-state"));
  const sessionFile = path.join(tempDir, "warm-isolated-session.jsonl");
  const workspaceDir = path.join(tempDir, "warm-isolated-workspace");
  const personalSkill = path.join(tempDir, ".claude", "skills", "personal", "SKILL.md");
  await fs.mkdir(path.dirname(personalSkill), { recursive: true });
  await fs.writeFile(personalSkill, "personal");
  const personalSkillRealPath = await fs.realpath(personalSkill);
  const nativeSkillPaths = [personalSkillRealPath];
  let starts = 0;
  const request = vi.fn(async (method: string, _requestParams?: unknown) => {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "skills/list") {
      return {
        data: [
          {
            cwd: workspaceDir,
            errors: [],
            skills: nativeSkillPaths.map((skillPath) => ({
              name: path.basename(path.dirname(skillPath)),
              description: "Personal skill",
              path: skillPath,
              scope: "user",
              enabled: true,
            })),
          },
        ],
      };
    }
    if (method === "thread/start") {
      starts += 1;
      return threadStartResult(
        starts === 1 ? "thread-warm-isolated" : "thread-refreshed-isolation",
      );
    }
    if (method === "thread/unsubscribe") {
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const fixture = createFakeCodexAppServerClient(request);
  const { client } = fixture;
  ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
  const params = createParams(sessionFile, workspaceDir);
  params.disableTools = false;
  params.config = undefined;
  registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
  const common: Parameters<typeof startOrResumeThread>[0] = {
    client,
    params,
    cwd: workspaceDir,
    dynamicTools: [],
    appServer: {
      ...createAppServerOptions(),
      connectionClass: "local-loopback",
      remoteAppsSubstrate: "preconfigured",
    },
    userMcpServersEnabled: false,
  };

  try {
    const started = await startOrResumeThread(common);
    await expect(
      retainCodexAppServerLiveThread(
        client,
        started.threadId,
        undefined,
        started.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);
    const warm = await startOrResumeThread(common);
    expect(warm).toMatchObject({
      threadId: "thread-warm-isolated",
      lifecycle: { action: "resumed" },
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "skills/list",
      "config/read",
      "configRequirements/read",
      "thread/start",
      "config/read",
      "configRequirements/read",
    ]);
    const startRequest = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    expect(startRequest).toMatchObject({
      config: {
        "skills.include_instructions": false,
        "skills.config": [{ path: personalSkillRealPath, enabled: false }],
      },
    });
    await expect(
      retainCodexAppServerLiveThread(
        client,
        warm.threadId,
        warm.liveThreadOwnership?.release,
        warm.liveThreadConfigFingerprint,
      ),
    ).resolves.toBe(true);

    const newPersonalSkill = path.join(tempDir, ".claude", "skills", "updated", "SKILL.md");
    await fs.mkdir(path.dirname(newPersonalSkill), { recursive: true });
    await fs.writeFile(newPersonalSkill, "updated");
    const newPersonalSkillRealPath = await fs.realpath(newPersonalSkill);
    nativeSkillPaths.push(newPersonalSkillRealPath);
    await fixture.notify({ method: "skills/changed", params: {} });

    await expect(startOrResumeThread(common)).resolves.toMatchObject({
      threadId: "thread-refreshed-isolation",
      lifecycle: { action: "started" },
    });
    const startRequests = request.mock.calls.filter(([method]) => method === "thread/start");
    expect(startRequests).toHaveLength(2);
    expect(startRequests[1]?.[1]).toMatchObject({
      config: {
        "skills.include_instructions": false,
        "skills.config": [
          { path: personalSkillRealPath, enabled: false },
          { path: newPersonalSkillRealPath, enabled: false },
        ],
      },
    });
  } finally {
    fixture.close();
  }
});

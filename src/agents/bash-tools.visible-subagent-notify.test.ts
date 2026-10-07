/** Real exec/process -> system-event -> heartbeat -> channel-boundary regression. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import {
  seedMainSessionStore,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "../infra/heartbeat-runner.test-utils.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { getFinishedSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: requestHeartbeatMock,
}));

const RUN_ID = "visible-exec-channel-fixture";
beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  requestHeartbeatMock.mockClear();
});
afterEach(() => {
  subagentRuns.delete(RUN_ID);
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32").each([
  {
    kind: "visible child borrowing parent tool policy",
    sessionKey: "agent:main:dashboard:borrowed",
    child: true,
    borrowedPolicy: true,
  },
  { kind: "hidden child", sessionKey: "agent:main:subagent:hidden", child: true },
  {
    kind: "dashboard with only a navigation parent",
    sessionKey: "agent:main:dashboard:navigation",
    child: false,
    navigation: true,
  },
])(
  "keeps a real failed background exec owned by its $kind",
  async ({ sessionKey, child, navigation, borrowedPolicy }) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tmpDir, heartbeat: { every: "0m", target: "telegram" } } },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const delivery = { lastChannel: "telegram", lastProvider: "telegram", lastTo: "100123" };
      await seedMainSessionStore(storePath, cfg, delivery);
      await seedSessionStore(storePath, sessionKey, {
        ...delivery,
        sessionId: "dashboard-fixture",
        ...(child ? { spawnDepth: 1, spawnedBy: "agent:main:main" } : {}),
        ...(navigation ? { spawnedBy: "agent:main:main" } : {}),
      });
      const scriptFile = path.join(tmpDir, "background-child.cjs");
      const releaseFile = path.join(tmpDir, "release-child");
      await fs.writeFile(
        scriptFile,
        [
          'const fs = require("node:fs");',
          `const releaseFile = ${JSON.stringify(releaseFile)};`,
          'const finish = () => { if (fs.existsSync(releaseFile)) { watcher.close(); process.stdout.write("synthetic failed build\\n"); process.exit(7); } };',
          `const watcher = fs.watch(${JSON.stringify(tmpDir)}, finish);`,
          "finish();",
        ].join("\n"),
      );
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const exec = createExecTool({
        config: cfg,
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: true,
        timeoutSec: 10,
        notifyOnExit: true,
        sessionKey: borrowedPolicy ? "agent:main:main" : sessionKey,
        ...(borrowedPolicy ? { runSessionKey: sessionKey } : {}),
        scopeKey: sessionKey,
        messageProvider: "telegram",
        currentChannelId: "100123",
      });
      const started = await exec.execute("background-child", {
        command: `${quote(process.execPath)} ${quote(scriptFile)}`,
        background: true,
      });
      if (started.details.status !== "running") {
        throw new Error(`Expected running exec, received ${started.details.status}`);
      }
      const sessionId = started.details.sessionId;
      // Registration can follow child dispatch. Both registration and retirement
      // happen while the real background process is waiting, before it exits.
      if (child) {
        subagentRuns.set(
          RUN_ID,
          createSubagentRunRecord({ runId: RUN_ID, childSessionKey: sessionKey }),
        );
      }
      subagentRuns.delete(RUN_ID);
      const processTool = createProcessTool({ scopeKey: sessionKey });
      await fs.writeFile(releaseFile, "go");
      await waitForExecScope(sessionKey);
      expect(getFinishedSession(sessionId)?.exitCode).toBe(7);
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);

      replySpy.mockResolvedValue({ text: "The background build exited with code 7." });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "synthetic-message", chatId: "100123" });
      // Drain actual producer requests through the real heartbeat runner. Only the
      // model response and Telegram transport are stubbed; no live message is sent.
      for (const [wake] of requestHeartbeatMock.mock.calls) {
        await runHeartbeatOnce({
          cfg,
          ...wake,
          deps: { getQueueSize: () => 0, getReplyFromConfig: replySpy, telegram: sendTelegram },
        });
      }
      expect(replySpy).toHaveBeenCalledTimes(child ? 0 : 1);
      expect(sendTelegram).toHaveBeenCalledTimes(child ? 0 : 1);
      expect(requestHeartbeatMock).toHaveBeenCalledTimes(child ? 0 : 1);
      if (child) {
        const result = await processTool.execute("poll-child", { action: "poll", sessionId });
        expect(result.details).toMatchObject({ status: "completed", exitCode: 7 });
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        acknowledgeInternalToolResult(result);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      }
    });
  },
);

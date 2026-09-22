import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "./app-server/client.js";
import { createCodexNativeTestState } from "./app-server/native-app-server.test-support.js";
import type { CodexThreadListResponse } from "./app-server/protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
} from "./session-catalog.test-helpers.js";

it("pages and refreshes exact-millisecond ties through the real native app-server", async () => {
  const root = await fs.realpath(process.env.OPENCLAW_STATE_DIR!);
  const state = await createCodexNativeTestState(root);
  const directory = path.join(state.codexHome, "sessions", "2025", "01", "01");
  await fs.mkdir(directory, { recursive: true });
  const timestamp = "2025-01-01T00:00:00.000Z";
  const ids = Array.from(
    { length: 81 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  for (const [i, id] of ids.entries()) {
    const file = path.join(directory, `rollout-2025-01-01T00-00-00-${id}.jsonl`);
    await fs.writeFile(
      file,
      [
        {
          timestamp,
          type: "session_meta",
          payload: {
            id,
            timestamp,
            cwd: state.cwd,
            originator: "codex_cli_rs",
            source: "cli",
            cli_version: CODEX_APP_SERVER_VERSION,
            model_provider: "openai",
          },
        },
        {
          timestamp,
          type: "event_msg",
          payload: { type: "user_message", message: `Synthetic tie ${i}`, kind: "plain" },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    // Historical mtimes survive native repair; one newer row establishes its high-water mark.
    const mtime = i === 0 ? 1_789_520_400 : 1_735_689_600;
    await fs.utimes(file, mtime, mtime);
  }
  const child = spawn(state.command, ["app-server"], {
    cwd: state.cwd,
    env: state.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = CodexAppServerClient.fromTransportForTests(child);
  try {
    await client.initialize();
    const baseline = await client.request<CodexThreadListResponse>("thread/list", {
      limit: 100,
      archived: false,
      modelProviders: [],
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    expect(baseline.data).toHaveLength(81);
    const batches: string[][] = [];
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (_plugin, method, request, options) => {
        expect(method).toBe("thread/list");
        const response = await client.request<CodexThreadListResponse>(method, request, {
          catalogListKey: options.catalogListKey,
          timeoutMs: 10_000,
        });
        batches.push(response.data.map((row) => row.id));
        return response;
      },
    );
    let now = 1_000;
    const factory = createCodexSessionCatalogControlFactory({
      env: state.env,
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => undefined,
      now: () => now,
    });
    const control = factory.forRequest("main", (await factory.homesForAgent("main"))[0]);
    const first = await control.listPage({ limit: 100 });
    const second = await control.listPage({ limit: 100, cursor: first.nextCursor });
    expect(first.sessions).toHaveLength(64);
    expect(second.sessions).toHaveLength(17);
    expect([...first.sessions, ...second.sessions].map((row) => row.threadId).toSorted()).toEqual(
      ids.toSorted(),
    );

    await client.request("thread/name/set", { threadId: ids[0], name: "Changed catalog head" });
    now += 32_001;
    batches.length = 0;
    const refreshed = await control.listPage({ limit: 100 });
    expect(refreshed.sessions[0]).toMatchObject({ threadId: ids[0], name: "Changed catalog head" });
    expect(batches.map((batch) => batch.length)).toEqual([1, 64, 17]);
    const remaining = await control.listPage({ limit: 100, cursor: refreshed.nextCursor });
    expect(
      [...refreshed.sessions, ...remaining.sessions].map((row) => row.threadId).toSorted(),
    ).toEqual(ids.toSorted());

    now += 32_001;
    batches.length = 0;
    await control.listPage({ limit: 100 });
    expect(batches.map((batch) => batch.length)).toEqual([1]);

    const tail = second.sessions[0];
    if (!tail) {
      throw new Error("expected tied tail page");
    }
    await client.request("thread/name/set", { threadId: tail.threadId, name: "Changed tied tail" });
    for (let i = 0; i < 8; i++) {
      now += 32_001;
      await control.listPage({ limit: 100 });
    }
    now += 32_001;
    batches.length = 0;
    const headAfterOverlap = await control.listPage({ limit: 100 });
    expect(batches.map((batch) => batch.length)).toEqual([64, 17]);
    const tailAfterOverlap = await control.listPage({
      limit: 100,
      cursor: headAfterOverlap.nextCursor,
    });
    expect(tailAfterOverlap.sessions.find((row) => row.threadId === tail.threadId)?.name).toBe(
      "Changed tied tail",
    );
    expect(
      [...headAfterOverlap.sessions, ...tailAfterOverlap.sessions]
        .map((row) => row.threadId)
        .toSorted(),
    ).toEqual(ids.toSorted());
  } finally {
    await client.closeAndWait();
  }
}, 30_000);

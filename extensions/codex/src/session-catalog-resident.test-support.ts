import fs from "node:fs/promises";
import path from "node:path";
import type { CodexThread } from "./app-server/protocol.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  idleThread,
} from "./session-catalog.test-helpers.js";

export function nativeCatalogFixture(count = 160, previewBytes = 32) {
  let now = 1_000;
  const rows = Array.from({ length: count }, (_, i) => ({
    ...idleThread({
      id: `thread-${String(i).padStart(3, "0")}`,
      source: "cli",
      originator: "codex_cli_rs",
      preview: `Please inspect the session sidebar, fix issue ${i}, and verify the result. ${"x".repeat(previewBytes)}`,
    }),
    updatedAt: 10_000 - i,
    recencyAt: 10_000 - i,
  }));
  const fetched: string[][] = [];
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    if (method === "thread/archive") {
      const index = rows.findIndex((row) => row.id === params.threadId);
      if (index >= 0) {
        rows.splice(index, 1);
      }
      return {};
    }
    if (method === "thread/read") {
      return { thread: structuredClone(rows.find((row) => row.id === params.threadId)) };
    }
    const offset = Number(params.cursor ?? 0);
    const field = params.sortKey === "recency_at" ? "recencyAt" : "updatedAt";
    const ordered = rows
      .filter((row) => !params.cwd || row.cwd === params.cwd)
      .toSorted((a, b) => b[field] - a[field] || b.id.localeCompare(a.id));
    const data = structuredClone(ordered.slice(offset, offset + params.limit));
    fetched.push(data.map((row) => row.id));
    return {
      data,
      nextCursor: offset + data.length < ordered.length ? String(offset + data.length) : null,
    };
  });
  const make = async () => {
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => undefined,
      now: () => now,
    });
    const home = (await factory.homesForAgent("main"))[0]!;
    const control = factory.forRequest("main", { ...home, localSessionsRoot: undefined });
    await control.initialize();
    return control;
  };
  const expire = () => {
    now += 32_001;
    fetched.length = 0;
  };
  return { rows, fetched, make, expire };
}

export async function writeCatalogRollout(
  sessionsRoot: string,
  thread: CodexThread,
  paddingBytes = 0,
) {
  const timestamp = "2026-09-16T12:00:00.000Z";
  const line = (type: string, payload: unknown) =>
    `${JSON.stringify({ timestamp, type, payload })}\n`;
  const day = path.join(sessionsRoot, "2026", "09", "16");
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-${thread.id}.jsonl`);
  await fs.writeFile(
    file,
    line("session_meta", {
      id: thread.id,
      timestamp,
      cwd: thread.cwd ?? "/workspace/project",
      source: thread.source ?? "cli",
      originator: "codex_cli_rs",
    }) +
      line("event_msg", {
        type: "user_message",
        message: thread.preview ?? "Please fix the sidebar and verify the result.",
      }) +
      (paddingBytes
        ? line("event_msg", { type: "agent_message", message: "x".repeat(paddingBytes) })
        : ""),
  );
  return file;
}

export async function measureCatalogLists(
  control: CodexSessionCatalogControl,
  advanceClock: () => void,
) {
  let page = await control.listPage({ limit: 100 });
  while (page.nextCursor) {
    page = await control.listPage({ limit: 100, cursor: page.nextCursor });
  }
  const elapsed: number[] = [];
  const cpu: number[] = [];
  const beforeCalls = commandRpcMocks.codexControlRequest.mock.calls.length;
  for (let i = 0; i < 100; i++) {
    advanceClock();
    const startCpu = process.threadCpuUsage();
    const start = performance.now();
    await control.listPage({
      limit: 64,
      ...(i % 3 === 1 ? { cwd: "/workspace/project" } : {}),
      ...(i % 3 === 2 ? { searchTerm: "native" } : {}),
    });
    elapsed.push(performance.now() - start);
    const usage = process.threadCpuUsage(startCpu);
    cpu.push((usage.user + usage.system) / 1_000);
  }
  elapsed.sort((a, b) => a - b);
  return {
    fixtureThreads: 3_000,
    lists: 100,
    p50Ms: elapsed[49],
    p95Ms: elapsed[94],
    threadListCalls: commandRpcMocks.codexControlRequest.mock.calls
      .slice(beforeCalls)
      .filter((call) => call[1] === "thread/list").length,
    mainThreadCpuMsPerList: cpu.reduce((sum, value) => sum + value, 0) / cpu.length,
  };
}

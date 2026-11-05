/**
 * node --import ./scripts/tsx.mjs --expose-gc scripts/perf/plugin-fresh-arrays-measure.mjs BASE_REF [CALLS=1000] [PAIRS=5] [WORKLOAD=all] [CANDIDATE_REF=WORKTREE]
 * Exact complete owner modules from BASE_REF versus CANDIDATE_REF, with shared
 * unchanged dependencies and in-memory API responses. Adjacent temporary modules
 * preserve normal import resolution and are removed on exit. No Gateway claim.
 * Workloads: ~1.5 KiB Discord Markdown, 100 Slack history messages, 50 X posts.
 * Counterbalanced CPU passes are untraced; allocation passes separately sample
 * owner stacks including collected objects. JSONL records source hashes, host load,
 * GC count/time/max/kind, RSS/heap, CPU/op, and sampled allocation/op.
 * WORKLOAD: all, discord, channel, dm, or x. Use one workload per short local run.
 * Set CANDIDATE_REF to BASE_REF for an A/A control; WORKTREE reads current files.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { sampledOwnerBytes } from "../lib/sampled-owner-allocation.mjs";

const [baseRef, callsArg = "1000", pairsArg = "5", selected = "all", candidateRef = "WORKTREE"] =
  process.argv.slice(2);
const calls = Number(callsArg),
  pairs = Number(pairsArg);
const samplingInterval = 8192;
assert(baseRef && globalThis.gc, "BASE_REF and --expose-gc are required");
assert([calls, pairs].every((n) => Number.isSafeInteger(n) && n > 0));
const files = {
  discord: "extensions/discord/src/markdown.ts",
  channel: "extensions/slack/src/monitor/thread.ts",
  dm: "extensions/slack/src/monitor/message-handler/prepare-dm-history.ts",
  x: "extensions/x/src/thread.ts",
};
assert(selected === "all" || Object.hasOwn(files, selected), "unknown WORKLOAD");
const temporaryFiles = [];
process.once("exit", () => temporaryFiles.forEach((file) => rmSync(file, { force: true })));
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
const owners = {};
for (const side of ["base", "candidate"]) {
  owners[side] = {};
  for (const [key, file] of Object.entries(files)) {
    if (selected !== "all" && selected !== key) {
      continue;
    }
    const ref = side === "base" ? baseRef : candidateRef;
    const source =
      ref !== "WORKTREE"
        ? execFileSync("git", ["show", `${ref}:${file}`], {
            encoding: "utf8",
            env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
          })
        : readFileSync(file, "utf8");
    const temporary = path.resolve(path.dirname(file), `.fresh-arrays-${process.pid}-${side}.ts`);
    writeFileSync(temporary, source, { flag: "wx" });
    temporaryFiles.push(temporary);
    const url = pathToFileURL(temporary).href;
    owners[side][key] = {
      module: await import(url),
      url,
      hash: createHash("sha256").update(source).digest("hex"),
    };
  }
}

const markdown = Array.from(
  { length: 20 },
  (_, i) => `__Status ${i}__ with *emphasis* and [docs](https://example.test/item/${i}) <@123>\n`,
).join("");
const messages = Object.freeze(
  Array.from({ length: 100 }, (_, i) =>
    Object.freeze({
      ts: `${100 - i}.000`,
      text: `Synthetic message ${100 - i}`,
      user: `U${i % 10}`,
    }),
  ),
);
const client = { conversations: { history: async () => ({ ok: true, messages }) } };
const posts = Object.freeze(
  Array.from({ length: 50 }, (_, i) =>
    Object.freeze({
      id: String(50 - i),
      conversation_id: "1",
      author_id: "7",
      text: `Synthetic post ${50 - i}`,
    }),
  ),
);
const users = Object.freeze([Object.freeze({ id: "7", username: "synthetic" })]);
const xPage = { data: posts, includes: { users, tweets: [] }, meta: {} };
const inputBefore = JSON.stringify({ messages, posts, users });
const workloads = [
  {
    key: "discord",
    run: (m) => m.renderDiscordMarkdown(markdown, "off"),
    verify: (result) => assert.equal(result, markdown.replace(/__/g, "**")),
  },
  {
    key: "channel",
    run: (m) =>
      m.resolveSlackChannelHistory({
        client,
        channelId: "C1",
        currentMessageTs: "101.000",
        excludedMessageIds: new Set(),
        limit: 100,
      }),
    verify: (result) =>
      assert.deepEqual(
        result.map((row) => row.ts),
        Array.from({ length: 100 }, (_, i) => `${i + 1}.000`),
      ),
  },
  {
    key: "dm",
    run: (m) =>
      m.resolveSlackDmHistoryContext({
        ctx: {
          app: { client },
          botToken: "synthetic",
          resolveUserName: async (id) => ({ name: id }),
        },
        channelId: "D1",
        currentMessageTs: "101.000",
        limit: 100,
        envelopeOptions: { includeTimestamp: false, includeElapsed: false },
      }),
    verify: (result) =>
      assert.deepEqual(
        result.inboundHistory.map((row) => row.timestamp),
        Array.from({ length: 100 }, (_, i) => (i + 1) * 1000),
      ),
  },
  {
    key: "x",
    run: (m) =>
      m.assembleXThread({
        api: {
          searchConversation: async () => xPage,
          getPosts: async () => {
            throw new Error("unexpected X lookup");
          },
        },
        mention: posts[0],
        users,
        maxPosts: 50,
      }),
    verify: (result) =>
      assert.deepEqual(
        result.posts.map((row) => row.id),
        Array.from({ length: 50 }, (_, i) => String(i + 1)),
      ),
  },
];
let gcEntries = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
const results = [];
let checksum = 0;
const output = (row) => console.log(JSON.stringify(row));
output({
  protocol: "plugin-fresh-arrays-v1",
  baseRef,
  candidateRef,
  node: process.version,
  calls,
  pairs,
  selected,
  samplingInterval,
  fixture: { markdownChars: markdown.length, slackMessages: messages.length, xPosts: posts.length },
  hashes: Object.fromEntries(
    Object.entries(owners).map(([side, entries]) => [
      side,
      Object.fromEntries(Object.entries(entries).map(([key, owner]) => [key, owner.hash])),
    ]),
  ),
});
try {
  for (const workload of workloads) {
    if (selected !== "all" && selected !== workload.key) {
      continue;
    }
    const operations = Object.fromEntries(
      ["base", "candidate"].map((side) => [
        side,
        () => workload.run(owners[side][workload.key].module),
      ]),
    );
    const proof = [await operations.base(), await operations.candidate()];
    proof.forEach(workload.verify);
    assert.deepEqual(proof[0], proof[1]);
    for (const run of Object.values(operations)) {
      for (let warm = 0; warm < Math.min(200, calls); warm++) {
        await run();
      }
    }
    for (const mode of ["cpu", "allocation"]) {
      const inspector = mode === "allocation" ? new Session() : undefined;
      inspector?.connect();
      try {
        for (let pair = 0; pair < pairs; pair++) {
          for (const side of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
            globalThis.gc();
            await setImmediate();
            await setImmediate();
            gcEntries = [];
            if (inspector) {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const hostLoad = loadavg(),
              cpu = process.cpuUsage(),
              thread = process.threadCpuUsage?.();
            const started = performance.now();
            for (let call = 0; call < calls; call++) {
              const result = await operations[side]();
              checksum +=
                typeof result === "string"
                  ? result.length
                  : Array.isArray(result)
                    ? result.length
                    : (result.body?.length ?? result.bodyForAgent.length);
            }
            const ended = performance.now(),
              used = process.cpuUsage(cpu);
            const threadUsed = thread && process.threadCpuUsage(thread),
              memory = process.memoryUsage();
            const allocated = inspector
              ? sampledOwnerBytes(
                  (await inspector.post("HeapProfiler.stopSampling")).profile,
                  owners[side][workload.key].url,
                )
              : undefined;
            await setImmediate();
            await setImmediate();
            const pauses = gcEntries.filter((e) => e.startTime >= started && e.startTime < ended);
            const kinds = {};
            for (const pause of pauses) {
              const kind = (kinds[pause.detail.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
              kind.count++;
              kind.totalMs += pause.duration;
              kind.maxMs = Math.max(kind.maxMs, pause.duration);
            }
            const row = {
              workload: workload.key,
              mode,
              side,
              pair,
              calls,
              hostLoad,
              wallUsPerOp: ((ended - started) * 1000) / calls,
              processCpuUsPerOp: (used.user + used.system) / calls,
              threadCpuUsPerOp: threadUsed ? (threadUsed.user + threadUsed.system) / calls : null,
              gcMs: pauses.reduce((sum, p) => sum + p.duration, 0),
              gcCount: pauses.length,
              gcMaxMs: Math.max(0, ...pauses.map((p) => p.duration)),
              gcByKind: kinds,
              rssBytes: memory.rss,
              heapUsedBytes: memory.heapUsed,
              ...(allocated
                ? {
                    sampledBytesPerOp: allocated.bytes / calls,
                    allocationSamples: allocated.samples,
                  }
                : {}),
            };
            results.push(row);
            output(row);
          }
        }
      } finally {
        inspector?.disconnect();
      }
    }
    assert.equal(JSON.stringify({ messages, posts, users }), inputBefore);
    for (const [mode, metric] of [
      ["cpu", "processCpuUsPerOp"],
      ["cpu", "threadCpuUsPerOp"],
      ["allocation", "sampledBytesPerOp"],
    ]) {
      const rows = results.filter((r) => r.workload === workload.key && r.mode === mode);
      if (rows.some((r) => r[metric] === null)) {
        continue;
      }
      const mean = (side) =>
        rows.filter((r) => r.side === side).reduce((sum, r) => sum + r[metric], 0) / pairs;
      const base = mean("base"),
        candidate = mean("candidate");
      output({
        summary: workload.key,
        metric,
        base,
        candidate,
        absoluteDelta: candidate - base,
        deltaPercent: (candidate / base - 1) * 100,
      });
    }
  }
  assert(checksum > 0);
} finally {
  observer.disconnect();
}

# QMD Search Policy Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shannon の cheap 自動検索を 1 回に制限し、重い `qmd query` を explicit-only に戻しつつ、QMD timeout 後の孤児 `bun/qmd` プロセスを残さない。

**Architecture:** OpenClaw source では QMD runtime の 2 つの失敗モードを直す。`src/memory/qmd-manager.ts` では `search` / `vsearch` から `query` への自動昇格をやめ、`src/memory/qmd-process.ts` では timeout 時に process group を kill する。Shannon 側では `~/.openclaw/openclaw.json` と workspace docs を cheap search 前提に戻し、運用ルールもそれに揃える。

**Tech Stack:** TypeScript, Vitest, pnpm, OpenClaw memory/QMD runtime, local Shannon workspace config

---

### Task 1: QMD Timeout Cleanup Tests

**Files:**
- Modify: `src/memory/qmd-process.test.ts`
- Test: `src/memory/qmd-process.test.ts`

- [ ] **Step 1: Write the failing timeout cleanup tests**

```ts
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const processKillMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

type MockChild = EventEmitter & {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createHungChild(pid = 4321): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("runCliCommand timeout cleanup", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    processKillMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("kills the process group on POSIX timeout", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "kill").mockImplementation(processKillMock as typeof process.kill);
    const child = createHungChild(4321);
    spawnMock.mockReturnValue(child);

    const promise = runCliCommand({
      commandSummary: "qmd search",
      spawnInvocation: { command: "qmd", argv: ["search", "hello"] },
      env: process.env,
      cwd: "/tmp",
      timeoutMs: 25,
      maxOutputChars: 1000,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).rejects.toThrow("qmd search timed out after 25ms");
    expect(processKillMock).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to child.kill on Windows timeout", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process, "kill").mockImplementation(processKillMock as typeof process.kill);
    const child = createHungChild(9876);
    spawnMock.mockReturnValue(child);

    const promise = runCliCommand({
      commandSummary: "qmd search",
      spawnInvocation: { command: "qmd", argv: ["search", "hello"] },
      env: process.env,
      cwd: "/tmp",
      timeoutMs: 25,
      maxOutputChars: 1000,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(promise).rejects.toThrow("qmd search timed out after 25ms");
    expect(processKillMock).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/shannon/repos/openclaw
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-process.test.ts
```

Expected: FAIL because `runCliCommand` is not imported/tested yet and timeout cleanup still only calls `child.kill("SIGKILL")`.

- [ ] **Step 3: Write minimal implementation in `src/memory/qmd-process.ts`**

```ts
export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
      detached: process.platform !== "win32",
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const discardStdout = params.discardStdout === true;
    const timer = params.timeoutMs
      ? setTimeout(() => {
          killCliChild(child);
          settled = true;
          reject(new Error(`${params.commandSummary} timed out after ${params.timeoutMs}ms`));
        }, params.timeoutMs)
      : null;

    child.stdout.on("data", (data) => {
      if (discardStdout) {
        return;
      }
      const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });

    child.stderr.on("data", (data) => {
      const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (settled) {
        return;
      }
      settled = true;
      if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
        reject(
          new Error(
            `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${params.commandSummary} failed (code ${code}): ${stderr || stdout}`));
      }
    });
  });
}

function killCliChild(child: { pid?: number; kill: (signal?: NodeJS.Signals) => void }): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to direct kill if the process group no longer exists.
    }
  }
  child.kill("SIGKILL");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /Users/shannon/repos/openclaw
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-process.test.ts
```

Expected: PASS with both timeout cleanup tests and the existing Windows shim tests green.

- [ ] **Step 5: Commit**

```bash
cd /Users/shannon/repos/openclaw
git add src/memory/qmd-process.ts src/memory/qmd-process.test.ts
git commit -m "fix: kill qmd process groups on timeout"
```

### Task 2: Remove Implicit Heavy-Search Escalation

**Files:**
- Modify: `src/memory/qmd-manager.test.ts`
- Modify: `src/memory/search-manager.test.ts`
- Test: `src/memory/qmd-manager.test.ts`
- Test: `src/memory/search-manager.test.ts`

- [ ] **Step 1: Replace the old auto-query fallback test in `src/memory/qmd-manager.test.ts`**

```ts
it("surfaces unsupported search flags without retrying qmd query", async () => {
  cfg = {
    ...cfg,
    memory: {
      backend: "qmd",
      qmd: {
        includeDefaultMemory: false,
        searchMode: "search",
        update: { interval: "0s", debounceMs: 60_000, onBoot: false },
        paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
      },
    },
  } as OpenClawConfig;

  spawnMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === "search") {
      const child = createMockChild({ autoClose: false });
      emitAndClose(child, "stderr", "unknown flag: --json", 2);
      return child;
    }
    if (args[0] === "query") {
      const child = createMockChild({ autoClose: false });
      emitAndClose(child, "stdout", "[]");
      return child;
    }
    return createMockChild();
  });

  const { manager } = await createManager();

  await expect(
    manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
  ).rejects.toThrow("unknown flag: --json");

  const commands = spawnMock.mock.calls.map((call: unknown[]) => (call[1] as string[])[0]);
  expect(commands.filter((command: string) => command === "search")).toHaveLength(1);
  expect(commands).not.toContain("query");
  await manager.close();
});
```

- [ ] **Step 2: Add wrapper-level fallback coverage in `src/memory/search-manager.test.ts`**

```ts
it("falls back to builtin search when qmd search mode rejects flags", async () => {
  const retryAgentId = "retry-agent-unsupported-search";
  const { manager } = await createFailedQmdSearchHarness({
    agentId: retryAgentId,
    errorMessage: "qmd search failed (code 2): unknown flag: --json",
  });

  const results = await manager.search("hello");

  expect(results).toHaveLength(1);
  expect(results[0]?.path).toBe("MEMORY.md");
  expect(fallbackSearch).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /Users/shannon/repos/openclaw
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-manager.test.ts src/memory/search-manager.test.ts
```

Expected: FAIL because `qmd-manager` still retries `query`, so the new `not.toContain("query")` assertion fails.

- [ ] **Step 4: Update `src/memory/qmd-manager.ts` to stop auto-escalating to `query`**

```ts
      } catch (err) {
        if (allowMissingCollectionRepair && this.isMissingCollectionSearchError(err)) {
          throw err;
        }
        const label = mcporterEnabled ? "mcporter/qmd" : `qmd ${qmdSearchCommand}`;
        log.warn(`${label} failed: ${String(err)}`);
        throw err instanceof Error ? err : new Error(String(err));
      }
```

Delete this block entirely:

```ts
        if (
          !mcporterEnabled &&
          qmdSearchCommand !== "query" &&
          this.isUnsupportedQmdOptionError(err)
        ) {
          log.warn(
            `qmd ${qmdSearchCommand} does not support configured flags; retrying search with qmd query`,
          );
          try {
            if (collectionNames.length > 1) {
              return await this.runQueryAcrossCollections(trimmed, limit, collectionNames, "query");
            }
            const fallbackArgs = this.buildSearchArgs("query", trimmed, limit);
            fallbackArgs.push(...this.buildCollectionFilterArgs(collectionNames));
            const fallback = await this.runQmd(fallbackArgs, {
              timeoutMs: this.qmd.limits.timeoutMs,
            });
            return parseQmdQueryJson(fallback.stdout, fallback.stderr);
          } catch (fallbackErr) {
            log.warn(`qmd query fallback failed: ${String(fallbackErr)}`);
            throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
          }
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd /Users/shannon/repos/openclaw
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-manager.test.ts src/memory/search-manager.test.ts
```

Expected: PASS with one `search` attempt only in `qmd-manager`, and builtin fallback used in `search-manager`.

- [ ] **Step 6: Commit**

```bash
cd /Users/shannon/repos/openclaw
git add src/memory/qmd-manager.ts src/memory/qmd-manager.test.ts src/memory/search-manager.test.ts
git commit -m "fix: keep qmd search on cheap path"
```

### Task 3: Align Shannon Config And Docs With Cheap-Search Policy

**Files:**
- Modify: `/Users/shannon/.openclaw/openclaw.json`
- Modify: `/Users/shannon/.openclaw/workspace/AGENTS.md`
- Modify: `/Users/shannon/.openclaw/workspace/tools/memory-stack.md`
- Modify: `docs/reference/memory-config.md`

- [ ] **Step 1: Update Shannon live config**

Apply this JSON change in `/Users/shannon/.openclaw/openclaw.json`:

```json
"memory": {
  "backend": "qmd",
  "qmd": {
    "searchMode": "search",
    "includeDefaultMemory": true,
    "paths": [
      {
        "path": "tools",
        "name": "tools",
        "pattern": "**/*.md"
      }
    ],
    "update": {
      "interval": "5m",
      "debounceMs": 15000,
      "onBoot": true,
      "embedInterval": "30m"
    },
    "limits": {
      "maxResults": 6,
      "timeoutMs": 4000
    },
    "scope": {
      "default": "allow"
    }
  }
}
```

- [ ] **Step 2: Update Shannon operating rules in `/Users/shannon/.openclaw/workspace/AGENTS.md`**

Add this under `Compaction Recovery` or adjacent memory guidance:

```md
## Memory Search Policy【必須】
- 自動の `memory_search` は 1 ターン 1 回まで。cheap recall として使う。
- 2 回目以降の追加検索は勝手にやらない。必要ならユーザーに深掘り許可を求める。
- `qmd query` / deep search は明示指示時だけ使う。
- cheap search が失敗しても、自動で heavy search に昇格しない。
```

- [ ] **Step 3: Rewrite the QMD section in `/Users/shannon/.openclaw/workspace/tools/memory-stack.md`**

Update the config example and OpenClaw linkage text to this shape:

````md
### 設定（2026-04-03）
```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "searchMode": "search",
      "includeDefaultMemory": true,
      "update": { "interval": "5m", "embedInterval": "30m", "onBoot": true },
      "limits": { "maxResults": 6, "timeoutMs": 4000 },
      "scope": { "default": "allow" },
      "paths": [{ "name": "tools", "path": "tools", "pattern": "**/*.md" }]
    }
  }
}
```

- `memory_search` ツールは `searchMode` に従って QMD を使う
- Shannon の標準は cheap な `qmd search`
- `qmd query` は明示 deep-search 時だけ
````

- [ ] **Step 4: Update OpenClaw docs in `docs/reference/memory-config.md`**

Replace the fallback sentence with:

```md
- Searches run via `memory.qmd.searchMode` (default `qmd search --json`; also
  supports `vsearch` and `query`). If QMD fails or the binary is missing,
  OpenClaw falls back to the builtin SQLite manager so memory tools keep working.
```

And make sure the config section still documents `searchMode` choices without implying automatic escalation to `query`.

- [ ] **Step 5: Run targeted tests plus doc sanity checks**

Run:

```bash
cd /Users/shannon/repos/openclaw
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-process.test.ts src/memory/qmd-manager.test.ts src/memory/search-manager.test.ts
```

Then inspect:

```bash
sed -n '724,752p' /Users/shannon/.openclaw/openclaw.json
sed -n '1,120p' /Users/shannon/.openclaw/workspace/tools/memory-stack.md
sed -n '1,120p' /Users/shannon/.openclaw/workspace/AGENTS.md
```

Expected: tests PASS, live config shows `searchMode: "search"` and `timeoutMs: 4000`, docs no longer say `memory_search` always runs `qmd query --json`.

- [ ] **Step 6: Commit repo-tracked doc changes**

```bash
cd /Users/shannon/repos/openclaw
git add docs/reference/memory-config.md
git commit -m "docs: align qmd memory search guidance"
```

Note: `~/.openclaw/openclaw.json`, `~/.openclaw/workspace/AGENTS.md`, and `~/.openclaw/workspace/tools/memory-stack.md` are local state files, so they are verified in place and not committed in this repo.

### Task 4: Manual Cleanup And End-to-End Verification

**Files:**
- Modify: none
- Test: local process table and Shannon runtime behavior

- [ ] **Step 1: Stop the current runaway QMD processes**

Run:

```bash
kill -9 76482 90545
```

Then verify:

```bash
ps -p 76482,90545 -o pid=,state=,command=
```

Expected: no output.

- [ ] **Step 2: Verify no new orphaned QMD child survives a forced timeout**

Run the targeted test suite again:

```bash
cd /Users/shannon/repos/openclaw
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-process.test.ts src/memory/qmd-manager.test.ts src/memory/search-manager.test.ts
```

Then check for residual QMD/Bun jobs:

```bash
ps -Ao pid,ppid,%cpu,etime,command | rg 'qmd|bun .*qmd' 
```

Expected: no long-running orphan `bun ... qmd` processes remain.

- [ ] **Step 3: Verify Shannon policy behavior**

Manual acceptance criteria:

```text
1. 通常の文脈復元では cheap な 1 回目の recall だけで返答する。
2. cheap recall が弱くても、勝手に deep search へ昇格しない。
3. 「重い検索して」「deep に探して」のような明示指示がある時だけ deep search を使う。
```

- [ ] **Step 4: Final verification snapshot**

Run:

```bash
cd /Users/shannon/repos/openclaw
git status --short
pnpm exec vitest run --config vitest.unit.config.ts src/memory/qmd-process.test.ts src/memory/qmd-manager.test.ts src/memory/search-manager.test.ts
ps -Ao pid,ppid,%cpu,%mem,state,etime,command | sort -k3 -nr | head -n 15
```

Expected: targeted tests PASS, modified repo files are intentional, and CPU top consumers no longer include day-long orphaned `bun/qmd` jobs.

import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{
    command: string;
    args: string[];
    prompt: string;
    transport?: "execFile" | "spawn";
    wrapperCommand?: string;
    wrapperArgs?: string[];
  }>,
  childrenByPid: new Map<number, { emit: (event: string, ...args: unknown[]) => boolean }>(),
  mode: "success" as
    | "success"
    | "all-error"
    | "role-context"
    | "windows-hang"
    | "codex-thread-not-found",
  pidCounter: 1000,
}));

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}

vi.mock("./embedding.js", () => ({
  cosineSimilarity: cosine,
  getEmbedder: vi.fn(async () => ({
    backend: "ollama",
    dimension: 2,
    embed: async () => [1, 0],
    similarity: cosine,
    topK: () => [],
  })),
  semanticSearchPatterns: vi.fn(async () => []),
}));

function commandKind(command: string): "claude" | "codex" | "unknown" {
  const lower = command.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("codex")) {
    return "codex";
  }
  return "unknown";
}

function modelArg(args: string[]): string {
  const index = args.findIndex((arg) => arg === "--model" || arg === "-m");
  return index >= 0 ? (args[index + 1] ?? "unknown") : "unknown";
}

function promptArg(command: string, args: string[]): string {
  if (commandKind(command) === "claude") {
    const index = args.indexOf("-p");
    return index >= 0 ? (args[index + 1] ?? "") : "";
  }
  return args.at(-1) ?? "";
}

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      command: string,
      args: string[] = [],
      options:
        | Record<string, unknown>
        | ((error: Error | null, result: { stdout: string; stderr: string }) => void) = {},
      callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const cb = typeof options === "function" ? options : (callback ?? (() => undefined));
      const kind = commandKind(command);
      const prompt = promptArg(command, args);
      const model = modelArg(args);
      mockState.calls.push({ command, args: [...args], prompt });

      queueMicrotask(() => {
        if (mockState.mode === "all-error" && (kind === "claude" || kind === "codex")) {
          cb(Object.assign(new Error(`missing ${kind}`), { code: "ENOENT" }), {
            stdout: "",
            stderr: "",
          });
          return;
        }
        if (mockState.mode === "codex-thread-not-found" && kind === "codex") {
          cb(
            Object.assign(new Error("codex exec failed: thread 019dc1b7 not found"), { code: 1 }),
            {
              stdout: "",
              stderr:
                "ERROR codex_core::session: failed to record rollout items: thread 019dc1b7 not found",
            },
          );
          return;
        }

        const text = prompt.includes("獨立驗證代理")
          ? '{"correctness":0.8,"completeness":0.7,"consistency":0.9,"specificity":0.8,"feedback":"ok"}'
          : prompt.includes("Mixture of Agents")
            ? `final:${model}`
            : mockState.mode === "role-context" && kind === "claude"
              ? "API 實作需補測試。資料庫 schema 需檢查。型別 interface 要收斂。使用者意圖尾段。策略尾段。"
              : mockState.mode === "role-context" && kind === "codex"
                ? "使用者需求應保留語義。策略意圖要先確認。概念推理需清楚。資料庫 schema 尾段。API 實作尾段。"
                : `${kind}:${model}`;

        const stdout =
          kind === "claude"
            ? JSON.stringify({ result: text })
            : `${JSON.stringify({ type: "turn.completed", payload: { content: text } })}\n`;
        cb(null, { stdout, stderr: "" });
      });
      return {};
    },
  ),
  spawn: vi.fn((command: string, args: string[] = []) => {
    if (command.toLowerCase() === "taskkill") {
      const child = new EventEmitter();
      mockState.calls.push({ command, args: [...args], prompt: "", transport: "spawn" });
      queueMicrotask(() => {
        const pidIndex = args.findIndex((arg) => arg.toLowerCase() === "/pid");
        const targetPid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : Number.NaN;
        mockState.childrenByPid.get(targetPid)?.emit("close", null, "SIGTERM");
        child.emit("close", 0, null);
      });
      return child;
    }

    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = ++mockState.pidCounter;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    mockState.childrenByPid.set(child.pid, child);
    child.on("close", () => {
      mockState.childrenByPid.delete(child.pid);
    });

    let prompt = "";
    child.stdin = {
      write: vi.fn((chunk: string | Buffer) => {
        prompt += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }),
      end: vi.fn(() => {
        queueMicrotask(() => {
          const wrapperLine = args[3] ?? "";
          const kind = wrapperLine.toLowerCase().includes("codex") ? "codex" : "claude";
          const model = wrapperLine.match(/--model\s+([^\s"]+)/)?.[1] ?? "unknown";
          mockState.calls.push({
            command: kind,
            args: wrapperLine.split(/\s+/).filter(Boolean),
            prompt,
            transport: "spawn",
            wrapperCommand: command,
            wrapperArgs: [...args],
          });

          if (mockState.mode === "windows-hang" && (kind === "claude" || kind === "codex")) {
            return;
          }

          if (mockState.mode === "all-error" && (kind === "claude" || kind === "codex")) {
            child.stderr.emit("data", Buffer.from(`${kind} is not recognized as a command`));
            child.emit("close", 1, null);
            return;
          }
          if (mockState.mode === "codex-thread-not-found" && kind === "codex") {
            child.stderr.emit(
              "data",
              Buffer.from(
                "ERROR codex_core::session: failed to record rollout items: thread 019dc1b7 not found",
              ),
            );
            child.emit("close", 1, null);
            return;
          }

          const text = prompt.includes("獨立驗證代理")
            ? '{"correctness":0.8,"completeness":0.7,"consistency":0.9,"specificity":0.8,"feedback":"ok"}'
            : prompt.includes("Mixture of Agents")
              ? `final:${model}`
              : mockState.mode === "role-context" && kind === "claude"
                ? "API 實作需補測試。資料庫 schema 需檢查。型別 interface 要收斂。使用者意圖尾段。策略尾段。"
                : mockState.mode === "role-context" && kind === "codex"
                  ? "使用者需求應保留語義。策略意圖要先確認。概念推理需清楚。資料庫 schema 尾段。API 實作尾段。"
                  : `${kind}:${model}`;
          const stdout =
            kind === "claude"
              ? JSON.stringify({ result: text })
              : `${JSON.stringify({ type: "turn.completed", payload: { content: text } })}\n`;
          child.stdout.emit("data", Buffer.from(stdout));
          child.emit("close", 0, null);
        });
      }),
    };

    return child;
  }),
}));

function createDb(
  opts: {
    hasDebates?: boolean;
    hasPatterns?: boolean;
    patternRows?: Array<{
      slug: string;
      target: string;
      context?: string | null;
      mental_models?: string | null;
    }>;
    run?: ReturnType<typeof vi.fn>;
    sqls?: string[];
  } = {},
): Database.Database {
  const run = opts.run ?? vi.fn();
  return {
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes("FROM patterns")) {
          return opts.patternRows ?? [];
        }
        return [];
      },
      get: () => {
        if (!sql.includes("sqlite_master")) {
          return undefined;
        }
        if (sql.includes("name='debates'") && opts.hasDebates) {
          return { ok: 1 };
        }
        if (sql.includes("name='patterns'") && opts.hasPatterns) {
          return { ok: 1 };
        }
        return undefined;
      },
      run: (...args: unknown[]) => {
        opts.sqls?.push(sql);
        return run(...args);
      },
    }),
  } as unknown as Database.Database;
}

let runDMAD: typeof import("./dmad-debate.js").runDMAD;

describe("runDMAD v2", () => {
  beforeAll(async () => {
    ({ runDMAD } = await import("./dmad-debate.js"));
  });

  beforeEach(() => {
    mockState.calls = [];
    mockState.childrenByPid.clear();
    mockState.mode = "success";
    mockState.pidCounter = 1000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: "openclaw:ollama-response" }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a bounded v2 debate and switches MoA/verification to Sonnet", async () => {
    const progressEvents: Array<{ phase: string; status: string; agent?: string; round?: number }> =
      [];
    const result = await runDMAD("修 API schema bug 並補 test", createDb(), {
      maxRounds: 2,
      claudeModel: "claude-haiku-4-5",
      codexModel: "gpt-5.3-codex",
      timeoutMs: 100,
      onProgress: (event) => progressEvents.push(event),
    });

    expect(result.totalRounds).toBe(1);
    expect(result.stoppedBy).toBe("convergence");
    expect(result.finalAnswer).toBe("final:claude-sonnet-4-5");
    expect(result.estimatedCostUsd).toBe(0.005);
    expect(result.trajectoryScores).toEqual({ claude: 0, codex: 0, openclaw: 0 });
    expect(result.hadCliError).toBe(false);
    expect(result.qualityStatus).toBe("pass");
    expect(result.degradedReason).toBeNull();
    expect(result.cliErrorSummary).toEqual({
      claudeMissing: 0,
      claudeFailed: 0,
      codexMissing: 0,
      codexFailed: 0,
    });
    expect(result.phaseTimingsMs).toMatchObject({
      embedder: expect.any(Number),
      routing: expect.any(Number),
      priorSearch: expect.any(Number),
      rounds: expect.any(Number),
      moa: expect.any(Number),
      verification: expect.any(Number),
      trajectory: expect.any(Number),
      dbWrite: expect.any(Number),
      total: expect.any(Number),
    });
    expect(result.rounds[0].stabilityScore).toBe(0);
    expect(result.rounds[0].hadCliError).toBe(false);
    expect(result.rounds[0].cliErrors).toEqual([]);
    expect(result.rounds[0].timingsMs).toMatchObject({
      claude: expect.any(Number),
      codex: expect.any(Number),
      openclaw: expect.any(Number),
      convergence: expect.any(Number),
      stability: 0,
      total: expect.any(Number),
    });
    expect(progressEvents).toContainEqual(
      expect.objectContaining({ phase: "agent", status: "start", agent: "claude", round: 1 }),
    );
    expect(progressEvents).toContainEqual(
      expect.objectContaining({ phase: "agent", status: "complete", agent: "codex", round: 1 }),
    );
    expect(progressEvents).toContainEqual(
      expect.objectContaining({ phase: "moa", status: "complete" }),
    );

    const claudeModels = mockState.calls
      .filter((call) => commandKind(call.command) === "claude")
      .map((call) => modelArg(call.args));
    expect(claudeModels).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"]);
  });

  it("uses RCR-filtered round 2 context without live Ollama dependency", async () => {
    mockState.mode = "role-context";

    const result = await runDMAD("分析 API 架構與策略", createDb(), {
      maxRounds: 2,
      convergenceThreshold: 1.1,
      varianceThreshold: -1,
      claudeModel: "claude-haiku-4-5",
      codexModel: "gpt-5.3-codex",
      timeoutMs: 100,
    });

    const claudeRound2 = mockState.calls
      .filter((call) => commandKind(call.command) === "claude")
      .find((call) => call.prompt.includes("[Codex 技術"));
    const codexRound2 = mockState.calls
      .filter((call) => commandKind(call.command) === "codex")
      .find((call) => call.prompt.includes("[Claude"));

    expect(claudeRound2).toBeDefined();
    expect(codexRound2).toBeDefined();
    expect(claudeRound2!.prompt).toContain("使用者需求應保留語義");
    expect(claudeRound2!.prompt).toContain("策略意圖要先確認");
    expect(claudeRound2!.prompt).not.toContain("資料庫 schema 尾段");
    expect(codexRound2!.prompt).toContain("API 實作需補測試");
    expect(codexRound2!.prompt).toContain("資料庫 schema 需檢查");
    expect(codexRound2!.prompt).not.toContain("使用者意圖尾段");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.rounds.map((round) => round.stabilityScore)).toEqual([0, 1]);
  });

  it("writes v2 debate metadata when the debates table exists", async () => {
    const run = vi.fn();
    const sqls: string[] = [];

    await runDMAD("修 API schema bug", createDb({ hasDebates: true, run, sqls }), {
      maxRounds: 1,
      convergenceThreshold: 1.1,
      claudeModel: "claude-haiku-4-5",
      codexModel: "gpt-5.3-codex",
      timeoutMs: 100,
    });

    const insertCallIndex = sqls.findIndex((sql) => sql.includes("INSERT OR IGNORE INTO debates"));
    expect(insertCallIndex).toBeGreaterThanOrEqual(0);
    const [payload] = run.mock.calls[insertCallIndex];
    expect(payload).toMatchObject({
      routeConfidence: "high",
      verifyPass: 1,
      verifyConfidence: 0.8,
      priorInjected: 0,
      calibratedThreshold: 1.1,
    });
    expect(JSON.parse(payload.trajectoryScoresJson)).toEqual({
      claude: 0,
      codex: 0,
      openclaw: 0,
    });
  });

  it("keeps CLI installation failures visible in result text", async () => {
    mockState.mode = "all-error";

    const result = await runDMAD("測試任務", createDb(), {
      maxRounds: 1,
      claudeModel: "claude-haiku-4-5",
      codexModel: "gpt-5.3-codex",
      timeoutMs: 100,
    });

    expect(result.rounds[0].claudeResponse).toContain("Claude CLI 未安裝");
    expect(result.rounds[0].codexResponse).toContain("Codex CLI 未安裝");
    expect(result.finalAnswer).toContain("Claude CLI 未安裝");
    expect(result.hadCliError).toBe(true);
    expect(result.qualityStatus).toBe("degraded_agents");
    expect(result.degradedReason).toBe("claude_missing=1,codex_missing=1");
    expect(result.rounds[0].hadCliError).toBe(true);
    expect(result.rounds[0].cliErrors).toEqual(["claude_missing", "codex_missing"]);
    expect(result.cliErrorSummary).toEqual({
      claudeMissing: 1,
      claudeFailed: 0,
      codexMissing: 1,
      codexFailed: 0,
    });
  });

  it("classifies codex thread-not-found runtime error as codex_failed (not codex_missing)", async () => {
    mockState.mode = "codex-thread-not-found";

    const result = await runDMAD("測試任務", createDb(), {
      maxRounds: 1,
      claudeModel: "claude-haiku-4-5",
      codexModel: "gpt-5.3-codex",
      timeoutMs: 100,
    });

    expect(result.rounds[0].codexResponse).toContain("Codex 呼叫失敗");
    expect(result.rounds[0].codexResponse).not.toContain("Codex CLI 未安裝");
    expect(result.rounds[0].cliErrors).toContain("codex_failed");
    expect(result.rounds[0].cliErrors).not.toContain("codex_missing");
    expect(result.cliErrorSummary).toEqual({
      claudeMissing: 0,
      claudeFailed: 0,
      codexMissing: 0,
      codexFailed: 1,
    });
    expect(result.degradedReason).toBe("codex_failed=1");
  });

  it("uses a Windows cmd wrapper with prompt over stdin for CLI shims", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const result = await runDMAD("修 API schema bug 並補 test", createDb(), {
        maxRounds: 1,
        claudeModel: "claude-haiku-4-5",
        codexModel: "gpt-5.3-codex",
        timeoutMs: 100,
      });

      expect(result.qualityStatus).toBe("pass");
      const spawned = mockState.calls.filter((call) => call.transport === "spawn");
      expect(spawned.length).toBeGreaterThanOrEqual(3);
      expect(spawned.every((call) => call.wrapperCommand === "cmd.exe")).toBe(true);
      expect(spawned.every((call) => call.wrapperArgs?.slice(0, 3).join(" ") === "/d /s /c")).toBe(
        true,
      );
      expect(spawned.some((call) => call.command === "claude" && call.args.includes("-"))).toBe(
        true,
      );
      expect(spawned.some((call) => call.command === "codex" && call.args.includes("-"))).toBe(
        true,
      );
      expect(spawned.some((call) => call.prompt.includes("修 API schema bug"))).toBe(true);
      expect(
        spawned.some((call) => call.wrapperArgs?.join(" ").includes("修 API schema bug")),
      ).toBe(false);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("aborts Windows CLI wrappers by terminating the process tree", async () => {
    mockState.mode = "windows-hang";
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const abortController = new AbortController();
    const progressEvents: Array<{ phase: string; status: string; agent?: string; round?: number }> =
      [];

    try {
      const resultPromise = runDMAD("測試 abort", createDb(), {
        maxRounds: 1,
        claudeModel: "claude-haiku-4-5",
        codexModel: "gpt-5.3-codex",
        timeoutMs: 5_000,
        abortSignal: abortController.signal,
        onProgress: (event) => progressEvents.push(event),
      });

      await vi.waitFor(() => {
        expect(
          mockState.calls.filter((call) => call.wrapperCommand === "cmd.exe").length,
        ).toBeGreaterThanOrEqual(2);
      });

      abortController.abort();
      const result = await resultPromise;

      const taskkillCalls = mockState.calls.filter(
        (call) => call.command.toLowerCase() === "taskkill",
      );
      expect(taskkillCalls.length).toBeGreaterThanOrEqual(2);
      expect(
        taskkillCalls.every((call) => call.args.includes("/t") && call.args.includes("/f")),
      ).toBe(true);
      expect(result.hadCliError).toBe(true);
      expect(result.rounds[0].claudeResponse).toContain("AbortError");
      expect(result.rounds[0].codexResponse).toContain("AbortError");
      expect(progressEvents).toContainEqual(
        expect.objectContaining({ phase: "agent", status: "start", agent: "claude", round: 1 }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});

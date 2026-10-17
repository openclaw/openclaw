import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { rotateOversizedCodexAppServerStartupBinding as rotateStartupBindingImpl } from "./startup-binding.js";

function byteLimitConfig(
  maxActiveTranscriptBytes: number | string,
): NonNullable<Parameters<typeof rotateStartupBindingImpl>[0]["config"]> {
  return { agents: { defaults: { compaction: { maxActiveTranscriptBytes } } } };
}

function tokenRecord(totalTokens?: number, modelContextWindow?: number, cumulativeTokens?: number) {
  return JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        ...(totalTokens === undefined ? {} : { last_token_usage: { total_tokens: totalTokens } }),
        ...(cumulativeTokens === undefined
          ? {}
          : { total_token_usage: { total_tokens: cumulativeTokens } }),
        model_context_window: modelContextWindow,
      },
    },
  });
}

describe("Codex app-server startup binding", () => {
  let tempDir: string;
  let sessionFile: string;
  let workspaceDir: string;
  let agentDir: string;
  let rolloutDir: string;
  let rolloutPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-binding-"));
    sessionFile = path.join(tempDir, "session.jsonl");
    workspaceDir = path.join(tempDir, "workspace");
    agentDir = path.join(tempDir, "agent");
    rolloutDir = path.join(agentDir, "codex-home", "sessions");
    rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
  });

  async function resolveBinding(
    overrides: Partial<Parameters<typeof rotateStartupBindingImpl>[0]> = {},
  ) {
    return rotateStartupBindingImpl({
      binding: await readCodexAppServerBinding(sessionFile),
      bindingStore: testCodexAppServerBindingStore,
      identity: { kind: "session", agentId: "main", sessionId: sessionFile },
      agentDir,
      config: undefined,
      ...overrides,
    });
  }

  async function rotateBinding(overrides: Parameters<typeof resolveBinding>[0] = {}) {
    return (await resolveBinding(overrides)).binding;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeExistingBinding(
    overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  ) {
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      ...overrides,
    });
  }

  async function writeRollout(records: string | string[]) {
    await fs.writeFile(rolloutPath, Array.isArray(records) ? records.join("\n") : records);
  }

  async function writeLegacySessionRecord(
    file: string,
    record: { totalTokens: number; contextTokens?: number },
  ) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(file), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile: file,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          ...record,
        },
      }),
    );
  }

  it.each([
    { pressure: "bytes", authority: "expected" },
    { pressure: "bytes", authority: "ordinary" },
    { pressure: "tokens", authority: "expected" },
    { pressure: "tokens", authority: "revoked" },
  ])(
    "handles preserve-only $pressure pressure with $authority authority",
    async ({ pressure, authority }) => {
      await writeExistingBinding({ preserveNativeModel: true });
      const before = await readCodexAppServerBinding(sessionFile);
      await writeRollout(tokenRecord(120_000, 128_000) + "\n");
      const operation = rotateBinding({
        binding: before,
        config:
          pressure === "bytes"
            ? { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "1b" } } } }
            : undefined,
        expectedSessionRuntimeOwnership:
          authority === "expected" ? { model: "native", auth: "host" } : undefined,
        ...(authority === "revoked"
          ? {
              assertCurrent: () => {
                throw new Error("startup generation is no longer current");
              },
            }
          : {}),
      });

      if (authority !== "ordinary") {
        await expect(operation).rejects.toMatchObject(
          authority === "expected"
            ? { name: "AgentHarnessPreflightError" }
            : { message: "startup generation is no longer current" },
        );
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
      } else {
        await expect(operation).resolves.toBeUndefined();
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
      }
    },
  );

  it("never rotates a materialized supervised native thread", async () => {
    await writeExistingBinding({
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    await writeRollout(`${tokenRecord(120_000, 128_000)}\n`);

    const binding = await rotateBinding({
      projectedTurnTokens: 999_999,
      config: {
        agents: {
          defaults: {
            compaction: { maxActiveTranscriptBytes: "1b" },
          },
        },
      } as never,
    });

    expect(binding).toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
      connectionScope: "supervision",
    });
  });

  it("reads the latest native token snapshot from one bounded rollout tail", async () => {
    await writeRollout([
      JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(200_000) } }),
      tokenRecord(120_000, 128_000),
      "",
    ]);
    await writeExistingBinding({ rolloutPath });
    const openFile = fs.open.bind(fs);
    const countFileReads: Array<() => number> = [];
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await openFile(file, flags, mode);
      const read = vi.spyOn(handle, "read");
      countFileReads.push(() => read.mock.calls.length);
      return handle;
    });

    const binding = await rotateBinding();

    expect(binding).toBeUndefined();
    expect(countFileReads.map((count) => count())).toEqual([1]);
  });

  it("keeps rollouts above the safe root default on the bounded direct path", async () => {
    const tokenSnapshot = Buffer.from(`\n${tokenRecord(120_000, 128_000)}\n`);
    const oversizedOffset = 16 * 1024 * 1024 + 1;
    const rolloutHandle = await fs.open(rolloutPath, "w");
    try {
      await rolloutHandle.truncate(oversizedOffset);
      await rolloutHandle.write(tokenSnapshot, 0, tokenSnapshot.byteLength, oversizedOffset);
    } finally {
      await rolloutHandle.close();
    }
    await writeExistingBinding({ rolloutPath });
    const readDirectories = vi.spyOn(fs, "readdir");
    const openFile = fs.open.bind(fs);
    const countFileReads: Array<() => number> = [];
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await openFile(file, flags, mode);
      const read = vi.spyOn(handle, "read");
      countFileReads.push(() => read.mock.calls.length);
      return handle;
    });

    const binding = await rotateBinding();

    expect(binding).toBeUndefined();
    expect(readDirectories).not.toHaveBeenCalled();
    expect(countFileReads.map((count) => count())).toEqual([1]);
  });

  it("scans a large trailing transcript record without repeatedly copying it", async () => {
    await writeRollout([
      tokenRecord(120_000, 128_000),
      JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(200_000) } }),
      "",
    ]);
    await writeExistingBinding({ rolloutPath });
    const concatenateBuffers = vi.spyOn(Buffer, "concat");

    const binding = await rotateBinding();

    expect(binding).toBeUndefined();
    const largeRecordCopies = concatenateBuffers.mock.calls.filter(
      ([fragments]) =>
        fragments.reduce((total, fragment) => total + fragment.byteLength, 0) > 65_536,
    );
    expect(largeRecordCopies).toHaveLength(1);
  });

  it("fills short filesystem reads before advancing the rollout tail cursor", async () => {
    await writeRollout([
      JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(80_000) } }),
      tokenRecord(120_000, 128_000),
      "",
    ]);
    await writeExistingBinding({ rolloutPath });
    const openFile = fs.open.bind(fs);
    let fileReads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await openFile(file, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return (buffer: Uint8Array, offset: number, length: number, position: number) => {
              fileReads += 1;
              return target.read(buffer, offset, Math.min(length, 8_192), position);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    const binding = await rotateBinding();

    expect(binding).toBeUndefined();
    expect(fileReads).toBeGreaterThan(1);
  });

  it.each([
    { boundary: 0, eol: "\n", suffix: "" },
    { boundary: 65_535, eol: "\r\n", suffix: "\r\n" },
  ])("reads older windows across byte $boundary", async ({ boundary, eol, suffix }) => {
    const paddedTokenRecord = (totalTokens: number, modelContextWindow?: number, text?: string) =>
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: totalTokens },
            model_context_window: modelContextWindow,
          },
          text,
        },
      });
    const latest = paddedTokenRecord(120_000, undefined, "🦞€".repeat(12_000));
    const afterBoundary = `{malformed${eol}${latest}${suffix}`;
    const padding =
      (2 * 65_536 - boundary - 1 - (Buffer.byteLength(afterBoundary) % 65_536)) % 65_536;
    const older = paddedTokenRecord(1_000, 128_000);
    const contents = Buffer.from(older + eol + "x".repeat(padding) + afterBoundary);
    const newlineOffset = Buffer.byteLength(older) + eol.length - 1;
    expect((newlineOffset - (contents.length % 65_536) + 65_536) % 65_536).toBe(boundary);
    await fs.writeFile(rolloutPath, contents);
    await writeExistingBinding({ rolloutPath, cwd: tempDir });

    const binding = await rotateBinding();

    expect(binding).toBeUndefined();
  });

  it.each([
    { name: "small native window", records: [tokenRecord(100, 16_000)] },
    {
      name: "current before cumulative usage",
      records: [tokenRecord(12_000, undefined, 300_000)],
      maxBytes: "1mb",
    },
    {
      name: "native before legacy window",
      records: [tokenRecord(300_000, 1_050_000)],
      maxBytes: "1mb",
      legacyContextTokens: 272_000,
    },
  ])("preserves the binding with $name", async (scenario) => {
    await writeExistingBinding({ dynamicToolsFingerprint: "[]" });
    if (scenario.legacyContextTokens) {
      await writeLegacySessionRecord(sessionFile, {
        totalTokens: 12_000,
        contextTokens: scenario.legacyContextTokens,
      });
    }
    await writeRollout([...scenario.records, ""]);
    const resolution = await resolveBinding({
      config: scenario.maxBytes ? byteLimitConfig(scenario.maxBytes) : undefined,
    });
    expect(resolution).toMatchObject({
      binding: { threadId: "thread-existing" },
      ...(scenario.legacyContextTokens ? { startupContextTokens: 1_050_000 } : {}),
    });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-existing",
    });
  });

  it("checks the native rollout path without walking the session directories", async () => {
    rolloutDir = path.join(agentDir, "codex-home", "sessions", "2026", "07", "27");
    rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(rolloutPath, "x".repeat(2_000));
    await writeExistingBinding({ rolloutPath });
    const readDirectories = vi.spyOn(fs, "readdir");

    const binding = await rotateBinding({
      config: byteLimitConfig("1k"),
    });

    expect(binding).toBeUndefined();
    expect(readDirectories).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it.each(["outside file", "file symlink", "parent symlink"] as const)(
    "rejects a stored rollout through an %s and discovers the safe file",
    async (escape) => {
      const outsideDir = path.join(tempDir, "outside");
      const outsidePath = path.join(outsideDir, "rollout-thread-existing.jsonl");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsidePath, "x".repeat(2_000));
      await fs.writeFile(rolloutPath, "x".repeat(2_000));
      let storedPath = outsidePath;
      if (escape === "file symlink") {
        storedPath = path.join(rolloutDir, "symlink-rollout-thread-existing.jsonl");
        await fs.symlink(outsidePath, storedPath);
      } else if (escape === "parent symlink") {
        const redirectedDir = path.join(rolloutDir, "redirect");
        await fs.symlink(outsideDir, redirectedDir, "dir");
        storedPath = path.join(redirectedDir, "rollout-thread-existing.jsonl");
      }
      await writeExistingBinding({ rolloutPath: storedPath });
      const stat = vi.spyOn(fs, "stat");
      const readDirectories = vi.spyOn(fs, "readdir");
      expect(await rotateBinding({ config: byteLimitConfig("1k") })).toBeUndefined();
      if (escape === "outside file") {
        expect(stat.mock.calls.filter(([file]) => file === outsidePath)).toHaveLength(0);
      }
      expect(readDirectories).toHaveBeenCalled();
    },
  );

  it("honors custom Codex home rollout files for native rollout limits", async () => {
    const codexHome = path.join(tempDir, "custom-codex-home");
    await writeExistingBinding({ dynamicToolsFingerprint: "[]" });
    rolloutDir = path.join(codexHome, "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(path.join(rolloutDir, "rollout-thread-existing.jsonl"), "x".repeat(2_000));

    const binding = await rotateBinding({
      codexHome,
      config: byteLimitConfig(1_000),
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("clears native rollouts at Codex's reported model context window", async () => {
    await writeExistingBinding({ dynamicToolsFingerprint: "[]" });
    const rolloutFile = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    await fs.writeFile(
      rolloutFile,
      [tokenRecord(128_000), tokenRecord(undefined, 128_000)].join("\n") + "\n",
    );
    const binding = await rotateBinding({
      config: byteLimitConfig("1mb"),
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });

  it("includes projected turn tokens in the native rollout pressure check", async () => {
    await writeExistingBinding({ dynamicToolsFingerprint: "[]" });
    await writeRollout(`${tokenRecord(220_000, 258_400)}\n`);

    const binding = await rotateBinding({
      projectedTurnTokens: 30_000,
    });

    expect(binding).toBeUndefined();
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding).toBeUndefined();
  });
});

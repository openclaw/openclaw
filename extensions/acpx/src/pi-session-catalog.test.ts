import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];

const nodeHostMocks = await vi.hoisted(async () => {
  const { createNodeHostMocks } = await import("../../test-support/node-host.test-support.js");
  return createNodeHostMocks();
});
const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

// mock-isolation: Shared owner preserves real exports with fresh command-resolution mocks.
vi.mock("openclaw/plugin-sdk/node-host", nodeHostMocks.mockRuntime);

import { registerPiSessionCatalog } from "./pi-session-catalog-plugin.js";
import { listLocalPiSessionPage, readLocalPiTranscriptPage } from "./pi-session-catalog.js";
import {
  capturePiCatalog as captureCatalog,
  capturePiContinuationCatalog,
  piJsonl,
  piMessage,
  piSessionHeader,
  usePiFixtures,
} from "./pi-session-catalog.test-support.js";

const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";
const PI_TERMINAL_RESUME_COMMAND = "acpx.pi.terminal.resume.v1";

const {
  directories: temporaryDirectories,
  createStore: createPiStore,
  installPi: installFakePi,
} = usePiFixtures();
const localRequest = { hostId: "gateway", threadId: "pi-session" };
const transcriptRequest = { threadId: "pi-session", limit: 20 };
const containingSessions = (session: Record<string, unknown>) => [
  expect.objectContaining({ sessions: [expect.objectContaining(session)] }),
];

const sessionInfo = (id: string, name: string, parentId: string | null = null, second = 1) => ({
  type: "session_info",
  id,
  name,
  parentId,
  timestamp: `2026-07-13T10:00:0${second}Z`,
});
const header = (id = "pi-session", version = 3) =>
  piSessionHeader({ id, version, timestamp: "2026-07-13T10:00:00Z" });

function usePiCandidateCacheClock(): () => void {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return () => {
    now += 32_001;
  };
}

afterEach(() => {
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  nodeHostMocks.runNodePtyCommand.mockClear();
});

describe("Pi session catalog", () => {
  it("lists named sessions and reads the active JSONL branch", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    await installFakePi();
    const listed = await listLocalPiSessionPage({ limit: 20 });
    expect(listed).toEqual({
      sessions: [
        expect.objectContaining({
          threadId: "pi-session",
          name: "Pi catalog session",
          cwd: "/workspace",
          source: "pi-cli",
          canContinue: true,
        }),
      ],
    });

    const transcript = await readLocalPiTranscriptPage(transcriptRequest);
    expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
      ["toolResult", "bash\n/workspace"],
      ["toolCall", 'bash\n{"command":"pwd"}'],
      ["agentMessage", "hi"],
      ["reasoning", "thinking"],
      ["userMessage", "hello"],
    ]);
    const itemIds = transcript.items.flatMap((item) => (item.id ? [item.id] : []));
    expect(new Set(itemIds).size).toBe(itemIds.length);

    const latest = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 2 });
    expect(latest.items.map((item) => item.type)).toEqual(["toolResult", "toolCall"]);
    expect(latest.nextCursor).toBeTruthy();
    const older = await readLocalPiTranscriptPage({
      ...transcriptRequest,
      limit: 2,
      cursor: latest.nextCursor,
    });
    expect(older.items.map((item) => item.type)).toEqual(["agentMessage", "reasoning"]);
    const nonEmitted = Buffer.from(JSON.stringify({ offset: 2, extra: true }), "utf8").toString(
      "base64url",
    );
    const unsafeOffset = Buffer.from(
      JSON.stringify({ offset: Number.MAX_SAFE_INTEGER + 1 }),
      "utf8",
    ).toString("base64url");
    for (const cursor of [
      `${latest.nextCursor}$`,
      `${latest.nextCursor}=`,
      ` ${latest.nextCursor} `,
      nonEmitted,
      unsafeOffset,
    ]) {
      await expect(readLocalPiTranscriptPage({ threadId: "pi-session", cursor })).rejects.toThrow(
        "cursor is invalid",
      );
    }
    await expect(listLocalPiSessionPage({ cursor: " " })).rejects.toThrow("cursor is invalid");
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session", cursor: 123 }),
    ).rejects.toThrow("cursor is invalid");

    const { provider } = captureCatalog();
    await expect(
      provider!.read({
        allowProcessHomeFallback: false,
        ...localRequest,
        limit: 2,
      }),
    ).resolves.toMatchObject({ threadId: "pi-session", items: expect.any(Array) });
    await expect(provider!.list({ allowProcessHomeFallback: false })).resolves.toEqual([
      expect.objectContaining({ hostId: "gateway", sessions: [expect.any(Object)] }),
    ]);

    for (const key of ["PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR"] as const) {
      delete process.env[key];
    }
    process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-isolated-home-"));
    temporaryDirectories.push(process.env.HOME);
    const isolatedRequest = { ...localRequest, allowProcessHomeFallback: false };
    for (const operation of [provider!.continueSession, provider!.openTerminal]) {
      await expect(operation?.(isolatedRequest)).rejects.toThrow(
        "local Pi sessions are unavailable in isolated state",
      );
    }
  });

  it("keeps truncated tool arguments on a valid UTF-16 boundary", async () => {
    await createPiStore("hi", "Pi catalog session", {
      value: `${"x".repeat(19_989)}🎉`,
    });
    const transcript = await readLocalPiTranscriptPage(transcriptRequest);
    const toolCall = transcript.items.find((item) => item.type === "toolCall");

    expect(toolCall?.text).toMatch(/…$/u);
    expect(toolCall?.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("reads legacy linear sessions and visible extended messages", async () => {
    const directory = await createPiStore();
    const entries = [
      header("pi-session", 1),
      ...[
        { role: "user", content: "legacy hello" },
        { role: "user", content: [{ type: "image", mimeType: "image/png", data: "cG5n" }] },
        { role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0 },
        { role: "custom", customType: "review", content: "visible note", display: true },
        {
          role: "hookMessage",
          customType: "legacy-review",
          content: "legacy visible note",
          display: true,
        },
      ].map((message, index) =>
        piMessage(message, { timestamp: `2026-07-13T10:00:0${index + 1}Z` }),
      ),
    ];
    await fs.writeFile(path.join(directory, "session.jsonl"), piJsonl(entries));

    const transcript = await readLocalPiTranscriptPage(transcriptRequest);
    expect(transcript.items.map((item) => [item.type, item.text])).toEqual([
      ["other", "legacy-review\nlegacy visible note"],
      ["other", "review\nvisible note"],
      ["toolResult", "/workspace"],
      ["toolCall", "bash\npwd"],
      ["userMessage", "[image: image/png]"],
      ["userMessage", "legacy hello"],
    ]);
  });

  it("indexes final records without a trailing newline", async () => {
    const directory = await createPiStore();
    const file = path.join(directory, "session.jsonl");
    await fs.writeFile(file, JSON.stringify(header()));
    const expireCandidates = usePiCandidateCacheClock();
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.threadId).toBe("pi-session");

    await fs.appendFile(file, `\n${JSON.stringify(sessionInfo("name", "No final newline"))}`);
    expireCandidates();
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBe(
      "No final newline",
    );
  });

  it("paginates, searches, and reads beyond the newest summary batch", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-catalog-"));
    temporaryDirectories.push(directory);
    process.env.PI_CODING_AGENT_SESSION_DIR = directory;
    const baseTime = Date.parse("2026-07-13T10:00:00Z") / 1_000;
    await Promise.all(
      Array.from({ length: 105 }, async (_, index) => {
        const file = path.join(directory, `session-${String(index)}.jsonl`);
        const entries = [
          header(`pi-session-${String(index)}`),
          sessionInfo(`info-${String(index)}`, `Cafe\u0301 history ${String(index)}`),
        ];
        await fs.writeFile(file, piJsonl(entries));
        await fs.utimes(file, baseTime + index, baseTime + index);
      }),
    );

    const first = await listLocalPiSessionPage({ limit: 100 });
    expect(first.sessions).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await listLocalPiSessionPage({ limit: 100, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      listLocalPiSessionPage({ limit: 20, searchTerm: "CAFÉ history 0" }),
    ).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: "pi-session-0" })],
    });
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session-0", limit: 20 }),
    ).resolves.toMatchObject({ threadId: "pi-session-0" });
  });

  it("uses the configured Pi session directory and lists oversized sessions", async () => {
    const agentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-agent-"));
    const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-home-"));
    temporaryDirectories.push(agentDirectory, homeDirectory);
    const sessionDirectory = path.join(homeDirectory, "custom-sessions");
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(agentDirectory, "settings.json"),
      `${JSON.stringify({ sessionDir: "~/custom-sessions" })}\n`,
    );
    const file = path.join(sessionDirectory, "large.jsonl");
    await fs.writeFile(file, piJsonl([header("pi-large-session")]));
    await fs.truncate(file, 2 * 1024 * 1024);
    await fs.appendFile(file, `\n${piJsonl([sessionInfo("large-info", "Pi large session")])}`);
    await fs.truncate(file, 33 * 1024 * 1024);
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    process.env.HOME = homeDirectory;
    process.env.USERPROFILE = homeDirectory;
    const expireCandidates = usePiCandidateCacheClock();

    await expect(listLocalPiSessionPage({ limit: 20 })).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({ threadId: "pi-large-session", name: "Pi large session" }),
      ],
    });
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-large-session", limit: 20 }),
    ).rejects.toThrow("32 MiB read safety limit");

    await fs.appendFile(file, `\n${piJsonl([sessionInfo("large-clear", "", "large-info", 2)])}`);
    expireCandidates();
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBeUndefined();
  });

  it("auto-detects the store and honors the node-local Web UI switch", async () => {
    const directory = await createPiStore();
    const binDirectory = await installFakePi();
    const { commands } = captureCatalog();
    expect(commands.map((command) => command.command)).toEqual([
      PI_SESSIONS_LIST_COMMAND,
      PI_SESSION_READ_COMMAND,
      PI_TERMINAL_RESUME_COMMAND,
    ]);
    const availableEnv = { PI_CODING_AGENT_SESSION_DIR: directory, PATH: binDirectory };
    const disabled = {
      plugins: { entries: { acpx: { config: { piSessionCatalog: { enabled: false } } } } },
    };
    for (const [config, env, expected] of [
      [{}, availableEnv, true],
      [disabled, availableEnv, false],
      [{}, { PI_CODING_AGENT_SESSION_DIR: path.join(directory, "missing") }, false],
      [{}, { PI_CODING_AGENT_SESSION_DIR: ".pi/sessions" }, false],
    ] as const) {
      expect(commands.every((command) => command.isAvailable?.({ config, env } as never))).toBe(
        expected,
      );
    }
  });

  it("opens validated local Pi sessions with the upstream terminal resume contract", async () => {
    await createPiStore();
    const binDirectory = await installFakePi();
    const executable = path.join(binDirectory, process.platform === "win32" ? "pi.cmd" : "pi");
    const { provider, commands } = captureCatalog();

    await expect(provider!.list({ hostIds: ["gateway"] })).resolves.toEqual(
      containingSessions({ threadId: "pi-session", canOpenTerminal: true }),
    );
    await expect(provider!.openTerminal!(localRequest)).resolves.toEqual({
      kind: "local",
      argv: [executable, "--session", "pi-session"],
      cwd: "/workspace",
      title: "pi --session pi-session…",
    });
    await expect(
      provider!.openTerminal!({ hostId: "gateway", threadId: "missing" }),
    ).rejects.toThrow("Pi session is unavailable");

    const terminal = commands.find((command) => command.command === PI_TERMINAL_RESUME_COMMAND)!;
    const io = {
      signal: new AbortController().signal,
      onInput: vi.fn(),
      emitChunk: vi.fn(),
    };
    await expect(
      terminal.handle?.(
        JSON.stringify({ threadId: "pi-session", cols: 100, rows: 30 }),
        io as never,
      ),
    ).resolves.toBe(JSON.stringify({ exitCode: 0 }));
    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      {
        file: executable,
        args: ["--session", "pi-session"],
        cwd: "/workspace",
        cols: 100,
        rows: 30,
      },
      io,
    );
    await expect(
      terminal.handle?.(JSON.stringify({ threadId: "--help", cols: 100, rows: 30 }), io as never),
    ).rejects.toThrow("threadId is invalid");
  });

  it.each([
    ["ACP policy", "ACP is disabled by policy"],
    ["custom store", "outside the session store supported by pi-acp"],
    ["missing CLI", "Pi CLI is unavailable"],
  ])("hides and rejects Continue for %s", async (reason, message) => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, reason !== "custom store");
    if (reason === "missing CLI") {
      process.env.PATH = "";
    } else {
      await installFakePi();
    }
    if (reason === "ACP policy") {
      acpRuntimeMocks.resolveAcpSessionAvailability.mockReturnValue({ available: false, message });
    }
    const { provider } = capturePiContinuationCatalog();
    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual(
      containingSessions({ threadId: "pi-session", canContinue: false }),
    );
    await expect(provider.continueSession!(localRequest)).rejects.toThrow(message);
  });

  it("opens paired-node Pi sessions only through the advertised terminal command", async () => {
    const page = {
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "pi-remote",
            cwd: "/remote/workspace",
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: false,
          },
        ],
      }),
    };
    const invoke = vi.fn().mockResolvedValue(page);
    const nodes = [
      {
        nodeId: "node-1",
        connected: true,
        commands: [PI_SESSIONS_LIST_COMMAND, PI_TERMINAL_RESUME_COMMAND],
      },
    ];
    const runtimeListNodes = vi.fn().mockResolvedValue({ nodes });
    const requestListNodes = vi.fn().mockResolvedValue({ nodes });
    const { provider } = captureCatalog({ nodes: { list: runtimeListNodes, invoke } });

    await expect(
      provider!.list({
        hostIds: ["node:node-1"],
        search: "remote",
        listNodes: requestListNodes,
      }),
    ).resolves.toEqual(
      containingSessions({ threadId: "pi-remote", canContinue: false, canOpenTerminal: true }),
    );
    expect(requestListNodes).toHaveBeenCalledOnce();
    expect(runtimeListNodes).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenNthCalledWith(1, {
      nodeId: "node-1",
      command: PI_SESSIONS_LIST_COMMAND,
      params: { searchTerm: "remote" },
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });
    await expect(
      provider!.openTerminal!({ hostId: "node:node-1", threadId: "pi-remote" }),
    ).resolves.toEqual({
      kind: "node",
      nodeId: "node-1",
      command: PI_TERMINAL_RESUME_COMMAND,
      uploadPathStyle: "native",
      paramsJSON: JSON.stringify({ threadId: "pi-remote" }),
      cwd: "/remote/workspace",
      title: "pi --session pi-remote…",
    });
    expect(invoke).toHaveBeenLastCalledWith({
      nodeId: "node-1",
      command: PI_SESSIONS_LIST_COMMAND,
      params: { searchTerm: "pi-remote", limit: 100 },
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });
  });

  it("does not register the catalog when explicitly disabled", () => {
    const registerSessionCatalog = vi.fn();
    const api = {
      pluginConfig: { piSessionCatalog: { enabled: false } },
      registerSessionCatalog,
    } as unknown as OpenClawPluginApi;
    registerPiSessionCatalog(api);
    expect(registerSessionCatalog).not.toHaveBeenCalled();
  });
});

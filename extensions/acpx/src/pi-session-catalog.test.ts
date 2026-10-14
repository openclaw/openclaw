import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

type ResolveAcpSessionAvailability =
  (typeof import("openclaw/plugin-sdk/acp-runtime"))["resolveAcpSessionAvailability"];

const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
}));
const acpRuntimeMocks = vi.hoisted(() => ({
  resolveAcpSessionAvailability: vi.fn<ResolveAcpSessionAvailability>(() => ({ available: true })),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/acp-runtime")>()),
  resolveAcpSessionAvailability: acpRuntimeMocks.resolveAcpSessionAvailability,
}));

vi.mock("openclaw/plugin-sdk/node-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/node-host")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
      },
    ) => {
      const env = options.env ?? process.env;
      return actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: options.pathEnv ?? env.PATH ?? env.Path ?? "",
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
    },
  };
});

import { registerPiSessionCatalog } from "./pi-session-catalog-plugin.js";
import { listLocalPiSessionPage, readLocalPiTranscriptPage } from "./pi-session-catalog.js";
import {
  bindTestCatalogOwner,
  capturePiContinuationCatalog,
  createPiStoreFixture,
  installFakePiFixture,
  registerPiNodeHostCommands,
  type TestSessionCatalogProvider,
} from "./pi-session-catalog.test-support.js";

const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";
const PI_TERMINAL_RESUME_COMMAND = "acpx.pi.terminal.resume.v1";

const temporaryDirectories: string[] = [];
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPath = process.env.PATH;

const createPiStore = (
  assistantText = "hi",
  sessionName = "Pi catalog session",
  toolArguments: unknown = { command: "pwd" },
  acpResolvable = false,
) =>
  createPiStoreFixture(
    temporaryDirectories,
    assistantText,
    sessionName,
    toolArguments,
    acpResolvable,
  );
const installFakePi = () => installFakePiFixture(temporaryDirectories, originalPath);

function usePiCandidateCacheClock(): () => void {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return () => {
    now += 32_001;
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  acpRuntimeMocks.resolveAcpSessionAvailability.mockReset().mockReturnValue({ available: true });
  nodeHostMocks.runNodePtyCommand.mockClear();
  process.env.PATH = originalPath;
  if (originalSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
  }
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
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

    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
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
      threadId: "pi-session",
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
      await expect(
        readLocalPiTranscriptPage({
          threadId: "pi-session",
          cursor,
        }),
      ).rejects.toThrow("cursor is invalid");
    }
    await expect(listLocalPiSessionPage({ cursor: " " })).rejects.toThrow("cursor is invalid");
    await expect(
      readLocalPiTranscriptPage({ threadId: "pi-session", cursor: 123 }),
    ).rejects.toThrow("cursor is invalid");

    let provider: TestSessionCatalogProvider | undefined;
    registerPiSessionCatalog({
      pluginConfig: {},
      runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
      registerSessionCatalog: (
        value: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0],
      ) => {
        provider = bindTestCatalogOwner(value);
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi);
    await expect(
      provider!.read({
        allowProcessHomeFallback: false,
        hostId: "gateway",
        threadId: "pi-session",
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
    const request = { hostId: "gateway", threadId: "pi-session" };
    const isolatedRequest = { ...request, allowProcessHomeFallback: false };
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
    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
    const toolCall = transcript.items.find((item) => item.type === "toolCall");

    expect(toolCall?.text).toMatch(/…$/u);
    expect(toolCall?.text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("reads legacy linear sessions and visible extended messages", async () => {
    const directory = await createPiStore();
    const entries = [
      {
        type: "session",
        version: 1,
        id: "pi-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:01Z",
        message: { role: "user", content: "legacy hello" },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:02Z",
        message: {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:03Z",
        message: { role: "bashExecution", command: "pwd", output: "/workspace", exitCode: 0 },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:04Z",
        message: { role: "custom", customType: "review", content: "visible note", display: true },
      },
      {
        type: "message",
        timestamp: "2026-07-13T10:00:05Z",
        message: {
          role: "hookMessage",
          customType: "legacy-review",
          content: "legacy visible note",
          display: true,
        },
      },
    ];
    await fs.writeFile(
      path.join(directory, "session.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const transcript = await readLocalPiTranscriptPage({ threadId: "pi-session", limit: 20 });
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
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      }),
    );
    const expireCandidates = usePiCandidateCacheClock();
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.threadId).toBe("pi-session");

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "session_info",
        id: "name",
        parentId: null,
        timestamp: "2026-07-13T10:00:01Z",
        name: "No final newline",
      })}`,
    );
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
          {
            type: "session",
            version: 3,
            id: `pi-session-${String(index)}`,
            timestamp: "2026-07-13T10:00:00Z",
            cwd: "/workspace",
          },
          {
            type: "session_info",
            id: `info-${String(index)}`,
            parentId: null,
            timestamp: "2026-07-13T10:00:01Z",
            name: `Pi history ${String(index)}`,
          },
        ];
        await fs.writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
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
      listLocalPiSessionPage({ limit: 20, searchTerm: "Pi history 0" }),
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
    await fs.writeFile(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-large-session",
        timestamp: "2026-07-13T10:00:00Z",
        cwd: "/workspace",
      })}\n`,
    );
    const middle = await fs.open(file, "r+");
    await middle.truncate(2 * 1024 * 1024);
    await middle.close();
    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "session_info",
        id: "large-info",
        parentId: null,
        timestamp: "2026-07-13T10:00:01Z",
        name: "Pi large session",
      })}\n`,
    );
    const handle = await fs.open(file, "r+");
    await handle.truncate(33 * 1024 * 1024);
    await handle.close();
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

    await fs.appendFile(
      file,
      `\n${JSON.stringify({
        type: "session_info",
        id: "large-clear",
        parentId: "large-info",
        timestamp: "2026-07-13T10:00:02Z",
        name: "",
      })}\n`,
    );
    expireCandidates();
    expect((await listLocalPiSessionPage({ limit: 20 })).sessions[0]?.name).toBeUndefined();
  });

  it("auto-detects the store and honors the node-local Web UI switch", async () => {
    const directory = await createPiStore();
    const binDirectory = await installFakePi();
    const commands = registerPiNodeHostCommands();
    expect(commands.map((command) => command.command)).toEqual([
      PI_SESSIONS_LIST_COMMAND,
      PI_SESSION_READ_COMMAND,
      PI_TERMINAL_RESUME_COMMAND,
    ]);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {},
          env: { PI_CODING_AGENT_SESSION_DIR: directory, PATH: binDirectory },
        } as never),
      ),
    ).toBe(true);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {
            plugins: { entries: { acpx: { config: { piSessionCatalog: { enabled: false } } } } },
          },
          env: { PI_CODING_AGENT_SESSION_DIR: directory, PATH: binDirectory },
        } as never),
      ),
    ).toBe(false);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {},
          env: { PI_CODING_AGENT_SESSION_DIR: path.join(directory, "missing") },
        } as never),
      ),
    ).toBe(false);
    expect(
      commands.every((command) =>
        command.isAvailable?.({
          config: {},
          env: { PI_CODING_AGENT_SESSION_DIR: ".pi/sessions" },
        } as never),
      ),
    ).toBe(false);
  });

  it("opens validated local Pi sessions with the upstream terminal resume contract", async () => {
    await createPiStore();
    const binDirectory = await installFakePi();
    const executable = path.join(binDirectory, process.platform === "win32" ? "pi.cmd" : "pi");
    let provider: TestSessionCatalogProvider | undefined;
    const commands: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0][] = [];
    registerPiSessionCatalog({
      pluginConfig: {},
      runtime: { nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) } },
      registerSessionCatalog: (
        value: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0],
      ) => {
        provider = bindTestCatalogOwner(value);
      },
      registerNodeHostCommand: (
        command: Parameters<OpenClawPluginApi["registerNodeHostCommand"]>[0],
      ) => commands.push(command),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi);

    await expect(provider!.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canOpenTerminal: true })],
      }),
    ]);
    await expect(
      provider!.openTerminal!({ hostId: "gateway", threadId: "pi-session" }),
    ).resolves.toEqual({
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

  it("hides and rejects Continue when ACP cannot resume Pi", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    await installFakePi();
    acpRuntimeMocks.resolveAcpSessionAvailability.mockReturnValue({
      available: false,
      message: "ACP is disabled by policy",
    });
    const { provider } = capturePiContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: false })],
      }),
    ]);
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("ACP is disabled by policy");
  });

  it("keeps custom Pi stores browse-only when pi-acp cannot resolve them", async () => {
    await createPiStore();
    await installFakePi();
    const { provider } = capturePiContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: false })],
      }),
    ]);
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("outside the session store supported by pi-acp");
  });

  it("hides and rejects Continue when the Pi CLI is unavailable", async () => {
    await createPiStore("hi", "Pi catalog session", { command: "pwd" }, true);
    process.env.PATH = "";
    const { provider } = capturePiContinuationCatalog();

    await expect(provider.list({ hostIds: ["gateway"] })).resolves.toEqual([
      expect.objectContaining({
        sessions: [expect.objectContaining({ threadId: "pi-session", canContinue: false })],
      }),
    ]);
    await expect(
      provider.continueSession!({ hostId: "gateway", threadId: "pi-session" }),
    ).rejects.toThrow("Pi CLI is unavailable");
  });

  it("opens paired-node Pi sessions only through the advertised terminal command", async () => {
    let provider: TestSessionCatalogProvider | undefined;
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
    registerPiSessionCatalog({
      pluginConfig: {},
      runtime: {
        nodes: {
          list: runtimeListNodes,
          invoke,
        },
      },
      registerSessionCatalog: (
        value: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0],
      ) => {
        provider = bindTestCatalogOwner(value);
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi);

    await expect(
      provider!.list({
        hostIds: ["node:node-1"],
        search: "remote",
        listNodes: requestListNodes,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            threadId: "pi-remote",
            canContinue: false,
            canOpenTerminal: true,
          }),
        ],
      }),
    ]);
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

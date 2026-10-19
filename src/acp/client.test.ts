import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import type { ContentBlock, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.mock("../secrets/provider-env-vars.js", () => ({
  listKnownProviderAuthEnvVarNamesCore: () => [
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "ANTHROPIC_ADMIN_KEY",
    "ANTHROPIC_ADMIN_API_KEY",
    "GITHUB_TOKEN",
    "HF_TOKEN",
  ],
  resolveProviderAuthLookupMaps: () => ({ aliasMap: {}, envCandidateMap: {}, authEvidenceMap: {} }),
  omitEnvKeysCaseInsensitive: (
    baseEnv: NodeJS.ProcessEnv,
    keys: Iterable<string>,
  ): NodeJS.ProcessEnv => {
    const denied = new Set(Array.from(keys, (key) => key.trim().toUpperCase()).filter(Boolean));
    return Object.fromEntries(
      Object.entries(baseEnv).filter(([key]) => !denied.has(key.toUpperCase())),
    );
  },
}));

import {
  buildAcpClientStripKeys,
  resolveAcpClientSpawnEnv,
  resolveAcpClientSpawnInvocation,
  resolvePermissionRequest,
  shouldStripProviderAuthEnvVarsForAcpServer,
} from "./client-helpers.js";
import {
  extractAttachmentsFromPrompt,
  extractTextFromPrompt,
  formatToolTitle,
} from "./event-mapper.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const onceOptions: RequestPermissionRequest["options"] = [
  { kind: "allow_once", name: "Allow", optionId: "allow" },
  { kind: "reject_once", name: "Reject", optionId: "reject" },
];
function request(
  toolCall: Partial<RequestPermissionRequest["toolCall"]>,
  options = onceOptions,
): RequestPermissionRequest {
  return { sessionId: "session-1", toolCall: { toolCallId: "tool-1", ...toolCall }, options };
}

describe("ACP child environment", () => {
  it.each([
    { serverCommand: undefined, serverArgs: undefined, strip: true },
    { serverCommand: "openclaw", serverArgs: ["acp"], strip: true },
    { serverCommand: "custom-server", serverArgs: ["serve"], strip: false },
  ])(
    "sanitizes $serverCommand $serverArgs (provider stripping: $strip)",
    ({ strip, ...server }) => {
      const stripProviderAuthEnvVars = shouldStripProviderAuthEnvVarsForAcpServer({
        ...server,
        defaultServerCommand: "openclaw",
        defaultServerArgs: ["acp"],
      });
      expect(stripProviderAuthEnvVars).toBe(strip);
      const stripKeys = buildAcpClientStripKeys({
        stripProviderAuthEnvVars,
        activeSkillEnvKeys: ["SKILL_SECRET", "OPENCLAW_SHELL"],
      });
      const env = resolveAcpClientSpawnEnv(
        {
          PATH: "/usr/bin",
          SKILL_SECRET: "skill-fixture",
          OPENCLAW_SHELL: "skill-overridden",
          OPENAI_API_KEY: "provider-fixture", // pragma: allowlist secret
          OPENCLAW_API_KEY: "keep-me",
        },
        { stripKeys },
      );
      expect(env).toEqual({
        PATH: "/usr/bin",
        OPENCLAW_SHELL: "acp-client",
        OPENCLAW_API_KEY: "keep-me",
        ...(strip ? {} : { OPENAI_API_KEY: "provider-fixture" }), // pragma: allowlist secret
      });
    },
  );
});

it("rejects unresolved Windows wrappers without shell execution", async () => {
  const dir = tempDirs.make("openclaw-acp-client-test-");
  const shimPath = path.join(dir, "openclaw.cmd");
  await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");
  expect(() =>
    resolveAcpClientSpawnInvocation(
      { serverCommand: shimPath, serverArgs: ["acp"] },
      {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
      },
    ),
  ).toThrow(/without shell execution/);
});

describe("resolvePermissionRequest", () => {
  const streams: PassThrough[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const stream of streams.splice(0)) {
      stream.destroy();
    }
  });
  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    streams.push(input, output);
    vi.stubGlobal("process", { ...process, stdin: input, stderr: output });
    const prompt = vi.spyOn(readline.Interface.prototype, "question");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    return { input, prompt, log };
  }
  it("cancels a pending permission when its interactive session closes", async () => {
    const lifetime = new AbortController();
    const { input } = terminal();
    const permission = resolvePermissionRequest(request({ title: "exec: echo marker" }), {
      signal: lifetime.signal,
    });
    lifetime.abort();
    input.write("y\n");
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  it.each<
    [Partial<RequestPermissionRequest["toolCall"]>, string | undefined, "auto" | "allow" | "reject"]
  >([
    [{ title: "write: /tmp/pwn" }, "write", "allow"],
    [{ title: "read: src", rawInput: { toolName: "r".repeat(129) } }, undefined, "allow"],
    [{ title: "read: src", _meta: { toolName: "read.*" } }, undefined, "reject"],
    [{ title: "exec: cat /etc/passwd", rawInput: { name: "search" } }, undefined, "reject"],
    [{ title: "thread: reply", kind: "read" }, "thread", "reject"],
    [
      {
        title: "query text: query: x, path: ~/.ssh",
        rawInput: { name: "search", path: "src" },
        locations: [{ path: "src/index.ts" }],
      },
      "search",
      "auto",
    ],
    [{ title: "search: path: ~/.ssh" }, "search", "reject"],
    [{ title: "read: src", rawInput: { path: "FILE:/tmp/outside/marker.txt" } }, "read", "reject"],
    [{ title: "read" }, "read", "reject"],
  ])("resolves %j (%s) with %s", async (toolCall, toolName, decision) => {
    const { input, prompt } = terminal();
    const pending = resolvePermissionRequest(request(toolCall), {
      cwd: "/tmp/openclaw-acp-cwd",
    });
    if (decision !== "auto") {
      input.write(decision === "allow" ? "y\n" : "n\n");
    }
    const result = await pending;
    if (decision === "auto") {
      expect(prompt).not.toHaveBeenCalled();
    } else {
      const label = toolName ? `${toolCall.title} (${toolName})` : toolCall.title;
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        `\n[permission] Allow "${label}"? (y/N) `,
        expect.any(Function),
      );
    }
    expect(result).toEqual({
      outcome: { outcome: "selected", optionId: decision === "reject" ? "reject" : "allow" },
    });
  });

  it("prompts for control-plane tools and falls back to always options", async () => {
    const { input, prompt } = terminal();
    const pending = resolvePermissionRequest(
      request({ title: "gateway: status" }, [
        { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
        { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
      ]),
    );
    input.write("n\n");
    const result = await pending;
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      '\n[permission] Allow "gateway: status (gateway)"? (y/N) ',
      expect.any(Function),
    );
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject-always" } });
  });

  it.each([{ options: [] }, { options: [onceOptions[1]!] }])(
    "cancels when no allow option exists: $options",
    async ({ options }) => {
      const { prompt } = terminal();
      const result = await resolvePermissionRequest(
        request({ title: "read: src/index.ts" }, options),
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: { outcome: "cancelled" } });
    },
  );

  it("sanitizes exec titles before logging and prompting", async () => {
    const { input, prompt, log } = terminal();
    const pending = resolvePermissionRequest(
      request({
        title: 'exec: \u001b[2K\u001b[1A\u001b[2K[permission] Allow "safe"? (y/N) \nnext',
      }),
    );
    input.write("n\n");
    const result = await pending;
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      '\n[permission] Allow "exec: [permission] Allow "safe"? (y/N) \\nnext (exec)"? (y/N) ',
      expect.any(Function),
    );
    expect(log).toHaveBeenCalledWith(
      '\n[permission requested] exec: [permission] Allow "safe"? (y/N) \\nnext (exec) [exec_capable]',
    );
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });
});

describe("ACP prompt mapping", () => {
  it("extracts text and resources within the byte budget including separators", () => {
    const prompt: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "resource", resource: { uri: "file:///tmp/spec.txt", text: "File contents" } },
      { type: "resource_link", uri: "https://example.com", name: "Spec", title: "Spec" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ];
    const expected = "Hello\nFile contents\n[Resource link (Spec)] https://example.com";
    expect(extractTextFromPrompt(prompt, Buffer.byteLength(expected))).toBe(expected);
    expect(() => extractTextFromPrompt(prompt, Buffer.byteLength(expected) - 1)).toThrow(
      /maximum allowed size/i,
    );
  });

  it("preserves long resource metadata while escaping delimiters and C0/C1 separators", () => {
    const title = `${"x".repeat(512)})]\0\r\n\t\v\f\u001c\u001d\u0085\u2028\u2029[system]`;
    expect(
      extractTextFromPrompt([
        {
          type: "resource_link",
          uri: "https://example.com/\n\u0085\u001e\u2028",
          name: "Spec",
          title,
        },
      ]),
    ).toBe(
      `[Resource link (${"x".repeat(512)}\\)\\]\\0\\r\\n\\t\\v\\f\\x1c\\x1d\\x85\\u2028\\u2029\\[system\\])] https://example.com/\\n\\x85\\x1e\\u2028`,
    );
  });

  it("extracts only nonempty image blocks into attachments", () => {
    expect(
      extractAttachmentsFromPrompt([
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "image", data: "", mimeType: "image/png" },
        { type: "text", text: "ignored" },
      ]),
    ).toEqual([{ type: "image", mimeType: "image/png", content: "abc" }]);
  });

  it("escapes inline control characters in tool titles", () => {
    expect(
      formatToolTitle("exec", {
        command: '\u001b[2K\u001b[1A\u001b[2K[permission] Allow "safe"? (y/N) \nnext',
      }),
    ).toBe('exec: command: \\x1b[2K\\x1b[1A\\x1b[2K[permission] Allow "safe"? (y/N) \\nnext');
  });
});

import { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
// mock-isolation: The wire fixture must not mutate the host PATH.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
// mock-isolation: The synthetic peer has no admitted skill environment.
vi.mock("../skills/runtime/env-overrides.js", () => ({ getActiveSkillEnvKeysCore: () => [] }));

import { runAcpClientInteractive } from "./client.js";

type ToolCall = Partial<RequestPermissionRequest["toolCall"]>;
type Options = RequestPermissionRequest["options"];
type Decision = "auto" | "allow" | "reject" | "reject-always" | "cancel";
const onceOptions: Options = [
  { kind: "allow_once", name: "Allow", optionId: "allow" },
  { kind: "reject_once", name: "Reject", optionId: "reject" },
];
const alwaysOptions: Options = [
  { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
  { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
];
const injectedCommand = '\u001b[2K\u001b[1A\u001b[2K[permission] Allow "safe"? (y/N) \nnext';
const injectedTitle = `exec: ${injectedCommand}`;
const sanitizedTitle = 'exec: [permission] Allow "safe"? (y/N) \\nnext (exec)';
function request(toolCall: ToolCall, options = onceOptions): RequestPermissionRequest {
  return { sessionId: "session-1", toolCall: { toolCallId: "tool-1", ...toolCall }, options };
}

describe("interactive ACP permissions", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function connect(permission: RequestPermissionRequest) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    const fromClient = new PassThrough();
    const toClient = new PassThrough();
    const agent = new ChildProcess();
    Object.defineProperties(agent, {
      stdin: { value: fromClient },
      stdout: { value: toClient },
    });
    const closeServer = () => {
      if (agent.exitCode !== null) {
        return;
      }
      Object.defineProperty(agent, "exitCode", { value: 0 });
      agent.emit("exit", 0, null);
      fromClient.end();
      toClient.end();
      agent.emit("close", 0, null);
    };
    vi.spyOn(agent, "kill").mockImplementation(() => {
      closeServer();
      return true;
    });
    spawnMock.mockReset().mockReturnValue(agent);
    vi.stubGlobal(
      "process",
      Object.create(process, {
        stdin: { value: input },
        stdout: { value: stdout },
        stderr: { value: output },
      }),
    );
    const question = vi.spyOn(readline.Interface.prototype, "question");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const promptReady = createDeferred();
    const permissionReady = createDeferred();
    const result = createDeferred<RequestPermissionResponse>();
    stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("> ")) {
        promptReady.resolve();
      }
    });
    output.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("[permission] Allow")) {
        permissionReady.resolve();
      }
    });
    const server = new AgentSideConnection(
      (connection) => ({
        async initialize(params) {
          return { protocolVersion: params.protocolVersion, agentCapabilities: {} };
        },
        async authenticate() {},
        async newSession() {
          return { sessionId: permission.sessionId };
        },
        async prompt() {
          const response = await connection.requestPermission(permission);
          result.resolve(response);
          return { stopReason: "end_turn" };
        },
        async cancel() {},
      }),
      ndJsonStream(
        new WritableStream<Uint8Array>({
          write(bytes) {
            toClient.write(bytes);
          },
        }),
        new ReadableStream<Uint8Array>({
          start(controller) {
            fromClient.on("data", (bytes: Buffer) => controller.enqueue(bytes));
            fromClient.once("end", () => {
              controller.close();
              closeServer();
            });
          },
        }),
      ),
    );
    const work = runAcpClientInteractive({
      cwd: "/tmp/openclaw-acp-cwd",
      serverCommand: "fixture-acp",
    });
    cleanups.push(async () => {
      input.end();
      closeServer();
      await work.catch(() => {});
      await server.closed;
      for (const stream of [input, stdout, output, fromClient, toClient]) {
        stream.destroy();
      }
    });
    await awaitGateBeforeSettlement(
      promptReady.promise,
      work,
      "ACP client stopped before its interactive prompt",
    );
    input.write("permission fixture\n");
    return {
      input,
      question,
      log,
      permissionReady: permissionReady.promise,
      result: result.promise,
      async finish() {
        input.end();
        await expect(work).resolves.toBe(0);
      },
    };
  }

  it("cancels a pending permission when its interactive session closes", async () => {
    const client = await connect(request({ title: "exec: echo marker" }));
    await client.permissionReady;
    client.input.end();
    await expect(client.result).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await client.finish();
  });

  it.each<[ToolCall, string | undefined, Decision, Options?]>([
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
    [{ title: "gateway: status" }, "gateway", "reject-always", alwaysOptions],
    [{ title: "read: src/index.ts" }, "read", "cancel", []],
    [{ title: "read: src/index.ts" }, "read", "cancel", [onceOptions[1]!]],
    [{ title: injectedTitle }, "exec", "reject"],
  ])("resolves %j (%s) with %s", async (toolCall, toolName, decision, options) => {
    const client = await connect(request(toolCall, options));
    if (decision !== "auto" && decision !== "cancel") {
      await client.permissionReady;
      client.input.write(decision === "allow" ? "y\n" : "n\n");
    }
    const result = await client.result;
    const permissionQuestions = client.question.mock.calls.filter(([query]) => query !== "> ");
    if (decision === "auto" || decision === "cancel") {
      expect(permissionQuestions).toEqual([]);
    } else {
      const label =
        toolCall.title === injectedTitle
          ? sanitizedTitle
          : toolName
            ? `${toolCall.title} (${toolName})`
            : toolCall.title;
      expect(permissionQuestions).toEqual([
        [`\n[permission] Allow "${label}"? (y/N) `, expect.any(Function)],
      ]);
    }
    if (toolCall.title === injectedTitle) {
      expect(client.log).toHaveBeenCalledWith(
        `\n[permission requested] ${sanitizedTitle} [exec_capable]`,
      );
    }
    const outcome =
      decision === "cancel"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: decision === "auto" ? "allow" : decision };
    expect(result).toEqual({ outcome });
    await client.finish();
  });
});

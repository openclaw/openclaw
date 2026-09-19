/** Real-process lifecycle tests for the interactive ACP client. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { runAcpClientInteractive } from "./client.js";

const fixture = createFixtureLifetime();
const node = resolveTestNodeExecPath();
type ServerMode =
  | "handshake-failure"
  | "SIGTERM"
  | "SIGKILL"
  | "exit-0"
  | "exit-7"
  | "quit"
  | "quit-7"
  | "eof"
  | "eof-pending";

afterEach(async () => {
  await fixture.cleanup();
});

async function createServerFixture(mode: ServerMode) {
  const dir = fixture.createTempDir("openclaw-acp-client-process-test-");
  const pidFile = path.join(dir, "server.pid");
  const termFile = path.join(dir, "server.term");
  const promptFile = path.join(dir, "server.prompt");
  await writeFile(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
  // The client prepends "acp" to server args, so this becomes `node acp`.
  await writeFile(
    path.join(dir, "acp"),
    `
const fs = require("node:fs");
const readline = require("node:readline");
const mode = ${JSON.stringify(mode)};
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let pendingPromptReply;
if (mode === "handshake-failure" || mode === "quit-7" || mode === "eof-pending") {
  process.on("SIGTERM", () => {
    fs.writeFileSync(${JSON.stringify(termFile)}, "SIGTERM");
    if (mode === "quit-7") process.exit(7);
    pendingPromptReply?.();
    pendingPromptReply = undefined;
  });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (payload) => process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: request.id, ...payload,
  }) + "\\n");
  if (request.method === "initialize") {
    reply({ result: {
      protocolVersion: request.params.protocolVersion,
      agentCapabilities: { loadSession: false },
    } });
  } else if (request.method === "session/new") {
    reply(mode === "handshake-failure" ? { error: {
        code: -32000,
        message: "fixture newSession failure",
        data: { stage: "newSession" },
    } } : { result: { sessionId: "process-status-fixture" } });
  } else if (request.method === "session/prompt") {
    fs.writeFileSync(${JSON.stringify(promptFile)}, request.params.prompt[0].text);
    if (mode === "SIGTERM" || mode === "SIGKILL") process.kill(process.pid, mode);
    else if (mode === "exit-0" || mode === "exit-7") process.exit(mode === "exit-7" ? 7 : 0);
    else if (mode === "eof-pending") {
      pendingPromptReply = () => reply({ result: { stopReason: "end_turn" } });
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "process-status-fixture",
          update: { sessionUpdate: "agent_message_chunk", content: {
            type: "text", text: "fixture awaiting terminal EOF",
          } },
        },
      }) + "\\n");
    } else reply({ result: { stopReason: "end_turn" } });
  }
});
setInterval(() => {}, 60_000);
`,
  );
  return { dir, pidFile, termFile, promptFile };
}

describe("runAcpClientInteractive process lifecycle", () => {
  it(
    "force-kills the spawned ACP server when the handshake fails",
    async () =>
      fixture.run(async () => {
        const { dir, pidFile, termFile } = await createServerFixture("handshake-failure");
        let serverPid: number | undefined;
        try {
          const error = await runAcpClientInteractive({
            serverCommand: process.execPath,
            cwd: dir,
          }).catch((caught: unknown) => caught);
          serverPid = Number(await readFile(pidFile, "utf8"));

          expect(error).toMatchObject({
            name: "RequestError",
            code: -32000,
            message: "fixture newSession failure",
            data: { stage: "newSession" },
          });
          if (process.platform !== "win32") {
            expect(await readFile(termFile, "utf8")).toBe("SIGTERM");
          }
          expect(() => process.kill(serverPid as number, 0)).toThrow();
        } finally {
          if (serverPid !== undefined) {
            try {
              process.kill(serverPid, "SIGKILL");
            } catch {
              // Already reaped.
            }
          }
        }
      }),
    20_000,
  );

  it.skipIf(process.platform === "win32").each([
    { mode: "SIGTERM", code: 1, diagnostic: "signal SIGTERM" },
    { mode: "SIGKILL", code: 1, diagnostic: "signal SIGKILL" },
    { mode: "exit-0", code: 0, diagnostic: "code 0" },
    { mode: "exit-7", code: 7, diagnostic: "code 7" },
    { mode: "quit", code: 0, diagnostic: "" },
    { mode: "quit-7", code: 7, diagnostic: "code 7" },
    { mode: "eof", code: 0, diagnostic: "signal SIGTERM" },
    { mode: "eof-pending", code: 0, diagnostic: "signal SIGKILL" },
  ] as const)("preserves the client outcome for $mode", async ({ mode, code, diagnostic }) =>
    fixture.run(async () => {
      const { dir, pidFile, termFile, promptFile } = await createServerFixture(mode);
      const stdout = createBoundedChildOutput();
      const stderr = createBoundedChildOutput();
      const cancellation = new AbortController();
      let prompted = false;
      let quitSent = false;
      let stdinFinished = false;
      let native: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const result = await runManagedCommand({
        bin: node,
        args: [
          "--import",
          fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
          "--input-type=module",
          "--eval",
          `import { runAcpClientInteractive } from ${JSON.stringify(new URL("./client.ts", import.meta.url).href)};
         await runAcpClientInteractive({ serverCommand: process.execPath, cwd: process.argv[1] });`,
          dir,
        ],
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          USERPROFILE: dir,
          OPENCLAW_STATE_DIR: path.join(dir, "state"),
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        requireProcessTreeExit: true,
        // Leave the shared test deadline enough time to join cancellation and output.
        timeoutMs: DEFAULT_VITEST_TEST_TIMEOUT_MS - 20_000,
        signal: cancellation.signal,
        onReady(child) {
          child.once("exit", (childCode, signal) => {
            native = { code: childCode, signal };
          });
          child.stderr!.on("data", stderr.append);
          child.stdin!.on("error", (error) => cancellation.abort(error));
          child.stdin!.once("finish", () => {
            stdinFinished = true;
          });
          child.stdout!.on("data", (chunk) => {
            stdout.append(chunk);
            const output = stdout.text();
            if (
              !prompted &&
              output.includes("Session: process-status-fixture") &&
              output.includes("> ")
            ) {
              prompted = true;
              child.stdin!.write("status marker\n");
            } else if (
              (mode.startsWith("quit") || mode.startsWith("eof")) &&
              !quitSent &&
              (mode === "eof-pending"
                ? output.includes("fixture awaiting terminal EOF")
                : /\[end_turn\][\s\S]*> /.test(output))
            ) {
              quitSent = true;
              if (mode.startsWith("eof")) {
                child.stdin!.end();
              } else {
                child.stdin!.write("quit\n");
              }
            }
          });
        },
      }).catch((error: unknown) => {
        throw new Error(
          `ACP client process failed: ${JSON.stringify({
            prompted,
            quitSent,
            stdinFinished,
            pendingPromptObserved: stdout.text().includes("fixture awaiting terminal EOF"),
            responseObserved: stdout.text().includes("[end_turn]"),
            native,
          })}\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`,
          { cause: error },
        );
      });
      expect(prompted, stderr.text()).toBe(true);
      expect(await readFile(promptFile, "utf8")).toBe("status marker");
      expect(result, `${stderr.text()}\n${stdout.text()}`).toBe(code);
      expect(native).toEqual({ code, signal: null });
      expect(stdout.text()).toContain(`Agent exited with ${diagnostic}`);
      if (mode.startsWith("quit") || mode.startsWith("eof")) {
        expect(quitSent).toBe(true);
      }
      if (mode === "quit-7" || mode === "eof-pending") {
        expect(await readFile(termFile, "utf8")).toBe("SIGTERM");
      }
      if (mode === "eof-pending") {
        expect(stdout.text()).toContain("[end_turn]");
        expect(stdout.text().match(/> /g)).toHaveLength(1);
      }
      const serverPid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(serverPid, 0)).toThrow();
    }),
  );
});

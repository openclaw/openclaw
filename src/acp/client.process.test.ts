/** Real-process lifecycle tests for the interactive ACP client. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const fixture = createFixtureLifetime();
const node = resolveTestNodeExecPath();
const handshakeError = {
  code: -32000,
  message: "fixture newSession failure",
  data: { stage: "newSession" },
};
type ServerMode = "handshake-failure" | "SIGTERM" | "exit-0" | "quit-7" | "eof-pending";

afterEach(() => fixture.cleanup());

function runCase(mode: ServerMode, code = 0, diagnostic?: string) {
  return fixture.run(async () => {
    const handshake = mode === "handshake-failure";
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
const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\\n");
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
  const { id, method, params } = JSON.parse(line);
  const reply = (payload) => send({ id, ...payload });
  const endTurn = () => reply({ result: { stopReason: "end_turn" } });
  if (method === "initialize") {
    reply({ result: {
      protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: false },
    } });
  } else if (method === "session/new") {
    reply(mode === "handshake-failure" ? { error: ${JSON.stringify(handshakeError)} }
      : { result: { sessionId: "process-status-fixture" } });
  } else if (method === "session/prompt") {
    fs.writeFileSync(${JSON.stringify(promptFile)}, params.prompt[0].text);
    if (mode === "SIGTERM") process.kill(process.pid, mode);
    else if (mode === "exit-0") process.exit(0);
    else if (mode === "eof-pending") {
      pendingPromptReply = endTurn;
      const content = { type: "text", text: "fixture awaiting terminal EOF" };
      send({ method: "session/update", params: {
          sessionId: "process-status-fixture",
          update: { sessionUpdate: "agent_message_chunk", content },
        } });
    } else endTurn();
  }
});
setInterval(() => {}, 60_000);
`,
    );
    const stdout = createBoundedChildOutput();
    const stderr = createBoundedChildOutput();
    const cancellation = new AbortController();
    const eof = mode === "eof-pending";
    const clientQuits = mode === "quit-7" || eof;
    let prompted = false;
    let quitSent = false;
    let native: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const result = await runManagedCommand({
      bin: node,
      args: [
        "--import",
        fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
        "--input-type=module",
        "--eval",
        `import { runAcpClientInteractive } from ${JSON.stringify(new URL("./client.ts", import.meta.url).href)};
         import { readFileSync } from "node:fs";
         process.exitCode = await runAcpClientInteractive({ serverCommand: process.execPath, cwd: process.argv[1] }).catch(error => {
           if (${JSON.stringify(mode)} !== "handshake-failure") throw error;
           const serverPid = Number(readFileSync(process.argv[2], "utf8"));
           let serverAlive = true;
           try { process.kill(serverPid, 0); } catch { serverAlive = false; }
           const { name, code, message, data } = error;
           console.log("ACP_CLIENT_ERROR:" + JSON.stringify({ name, code, message, data, serverAlive }));
           return 0;
         });
         console.log("ACP_CLIENT_RETURNED");`,
        dir,
        pidFile,
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
      timeoutMs: handshake ? 18_000 : DEFAULT_VITEST_TEST_TIMEOUT_MS - 20_000,
      signal: cancellation.signal,
      onReady(child) {
        child.once("exit", (childCode, signal) => {
          native = { code: childCode, signal };
        });
        child.stderr!.on("data", stderr.append);
        child.stdin!.on("error", (error) => cancellation.abort(error));
        child.stdout!.on("data", (chunk) => {
          stdout.append(chunk);
          const output = stdout.text();
          const sessionReady =
            output.includes("Session: process-status-fixture") && output.includes("> ");
          const turnFinished = eof
            ? output.includes("fixture awaiting terminal EOF")
            : /\[end_turn\][\s\S]*> /.test(output);
          if (!prompted && sessionReady) {
            prompted = true;
            child.stdin!.write("status marker\n");
          } else if (clientQuits && !quitSent && turnFinished) {
            quitSent = true;
            if (eof) {
              child.stdin!.end();
            } else {
              child.stdin!.write("quit\n");
            }
          }
        });
      },
    }).catch((error: unknown) => {
      throw new Error(
        `ACP client process failed: ${JSON.stringify({ prompted, quitSent, native })}\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`,
        { cause: error },
      );
    });
    expect(result, `${stderr.text()}\n${stdout.text()}`).toBe(code);
    expect(native).toEqual({ code, signal: null });
    expect(stdout.text()).toContain("ACP_CLIENT_RETURNED");
    if (handshake) {
      const error = JSON.parse(stdout.text().match(/ACP_CLIENT_ERROR:(.*)/)?.[1] ?? "null");
      expect(error).toMatchObject({ name: "RequestError", ...handshakeError, serverAlive: false });
    } else {
      expect(prompted, stderr.text()).toBe(true);
      expect(await readFile(promptFile, "utf8")).toBe("status marker");
      expect(stdout.text()).toContain(`Agent exited with ${diagnostic}`);
    }
    if (clientQuits || (handshake && process.platform !== "win32")) {
      if (clientQuits) {
        expect(quitSent).toBe(true);
      }
      expect(await readFile(termFile, "utf8")).toBe("SIGTERM");
    }
    if (eof) {
      expect(stdout.text()).toContain("[end_turn]");
      expect(stdout.text().match(/> /g)).toHaveLength(1);
    }
    const serverPid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(serverPid, 0)).toThrow();
  });
}

it(
  "force-kills the spawned ACP server when the handshake fails",
  () => runCase("handshake-failure"),
  20_000,
);

it.skipIf(process.platform === "win32").each([
  { mode: "SIGTERM", code: 1, diagnostic: "signal SIGTERM" },
  { mode: "exit-0", code: 0, diagnostic: "code 0" },
  { mode: "quit-7", code: 7, diagnostic: "code 7" },
  { mode: "eof-pending", code: 0, diagnostic: "signal SIGKILL" },
] as const)("preserves the client outcome for $mode", ({ mode, code, diagnostic }) =>
  runCase(mode, code, diagnostic),
);

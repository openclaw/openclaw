import { Value } from "typebox/value";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { addSession, appendOutput, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { createLazyProcessTool } from "./lazy-process-tool.js";

afterEach(() => {
  resetCodeModeTestState();
  resetProcessRegistryForTests();
});

it.each([createProcessTool, createLazyProcessTool])(
  "declares process results across listing, input, completion, logs, and failures (%#)",
  async (createTool) => {
    const tool = createTool();
    const session = createProcessSessionFixture({ id: "contract-process", backgrounded: true });
    session.stdin = { write: vi.fn((_data, done) => done?.(null)), end: vi.fn(), destroyed: false };
    addSession(session);
    appendOutput(session, "stdout", "first\nsecond\n");
    const invoke = async (action: string, extra: Record<string, unknown> = {}) => {
      const result = await tool.execute(action, { action, sessionId: session.id, ...extra });
      expect(tool.outputSchema).toBeDefined();
      expect(Value.Check(tool.outputSchema!, result.details), JSON.stringify(result.details)).toBe(
        true,
      );
      return result;
    };
    await invoke("list");
    await invoke("poll");
    await invoke("log", { offset: 1, limit: 1 });
    await invoke("write", { data: "hello" });
    await invoke("send-keys", { literal: "world" });
    await invoke("submit");
    await invoke("paste", { text: "paste" });
    await invoke("paste");
    await invoke("kill");
    markExited(session, null, "SIGTERM", "killed", "manual-cancel");
    await invoke("list");
    await invoke("poll");
    await invoke("log");
    await invoke("clear");
    await invoke("poll");
    const completed = createProcessSessionFixture({ id: "contract-completed", backgrounded: true });
    addSession(completed);
    markExited(completed, 0, null, "completed", "exit");
    await invoke("remove", { sessionId: completed.id });
    await invoke("invalid");
    expect(Value.Check(tool.outputSchema!, { status: "failed" })).toBe(false);
    expect(
      Value.Check(tool.outputSchema!, { status: "completed", sessions: [{ sessionId: 42 }] }),
    ).toBe(false);
  },
);

it("composes lazy process actions through generated declarations and a typechecked cell", async () => {
  const session = createProcessSessionFixture({ id: "typed-process", backgrounded: true });
  addSession(session);
  appendOutput(session, "stdout", "first\nsecond");
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createLazyProcessTool()] });
  const composition = `
    async function consume() {
      const listed = await process({ action: "list" });
      if (listed.status === "failed") throw new Error(listed.error);
      const running = listed.sessions.filter(session => session.status === "running");
      const logs = await Promise.all(running.map(async session => {
        const log = await process({ action: "log", sessionId: session.sessionId });
        if ("error" in log) throw new Error(log.error);
        return { id: session.sessionId, lines: log.totalLines, output: log.output.toUpperCase() };
      }));
      return logs;
    }
  `;
  const declaration = await runUntilCompleted({
    execTool: h.tools[0]!,
    waitTool: h.tools[1]!,
    code: 'return await API.read("tools/process.d.ts");',
  });
  expect(declaration).toMatchObject({ status: "completed" });
  const file = declaration.value as { content: string };
  const fileName = "/process-consumer.ts";
  const source = ts.createSourceFile(
    fileName,
    file.content +
      composition +
      `
async function checkContracts(action: "list" | "poll", input: Parameters<typeof process>[0]) {
  const poll = await process({ action: "poll", sessionId: "typed-process" });
  if (!("error" in poll)) {
    const text: string = poll.aggregated;
    if (poll.status === "running") {
      const writable: boolean = poll.stdinWritable;
    } else {
      const exitCode: number | undefined = poll.exitCode;
    }
  }
  const log = await process({ action: "log", sessionId: "typed-process" });
  if (!("error" in log)) {
    const lines: number = log.totalLines;
    // @ts-expect-error Log returns a page, not the full poll aggregate.
    log.aggregated;
  }
  const write = await process({ action: "write", sessionId: "typed-process", data: "hello" });
  if (write.status !== "failed") {
    const id: string = write.sessionId;
    // @ts-expect-error Input acknowledgement does not contain poll output.
    write.aggregated;
  }
  const removed = await process({ action: "remove", sessionId: "typed-process" });
  if (removed.status !== "failed") {
    const complete: "completed" = removed.status;
    // @ts-expect-error Removal does not return a process inventory.
    removed.sessions;
  }
  const selected = await process({ action });
  // @ts-expect-error A union action cannot promise an inventory.
  selected.sessions.map(session => session.sessionId);
  const dynamic = await process(input);
  // @ts-expect-error Broad inputs preserve all possible output branches.
  dynamic.aggregated.toUpperCase();
}
`,
    ts.ScriptTarget.ESNext,
    true,
  );
  const options = { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => (name === fileName ? source : original(name, ...args));
  const program = ts.createProgram([fileName], options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
  const result = await waitUntilCompleted({
    details: resultDetails(
      await h.tools[0]!.execute("typed-process", {
        language: "typescript",
        typecheck: true,
        code: `${composition}\nreturn await consume();`,
      }),
    ),
    waitTool: h.tools[1]!,
  });
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    value: [{ id: "typed-process", lines: 2, output: "FIRST\nSECOND" }],
  });
});

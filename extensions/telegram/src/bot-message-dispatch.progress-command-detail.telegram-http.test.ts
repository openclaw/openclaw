import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";

describe("Telegram progress command detail through the shared dispatcher and Telegram HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const {
    calls,
    visibleMessages,
    acceptedCalls,
    emitToolStart,
    dispatchProgressTurn,
    waitForBotApiCall,
  } = http;

  it.each(["progress", "off"] as const)(
    "reports tool-result acceptance without duplicate notices (%s)",
    async (mode) => {
      await dispatchProgressTurn(
        async (options, channelOptions) => {
          const beforeEmpty = calls.length;
          expect(await channelOptions?.onToolResult?.({ text: " \n " })).toBe(false);
          expect(calls.slice(beforeEmpty).filter((call) => call.method === "sendMessage")).toEqual(
            [],
          );
          if (mode === "progress") {
            // A preamble replaces reasoning rows, so verify token updates before it arrives.
            await options?.onReasoningProgress?.({ progressTokens: 50 });
            await options?.onReasoningProgress?.({ progressTokens: 200 });
            await waitForBotApiCall((call) => String(call.fields.text).includes("200 tokens"));
            const card = [...visibleMessages.values()][0] ?? "";
            expect(card).toContain("200 tokens");
            expect(card).not.toContain("50 tokens");
            expect(card.match(/tokens/gu)).toHaveLength(1);
            await options?.onItemEvent?.({
              kind: "preamble",
              itemId: "callback-preamble",
              phase: "end",
              progressText: "Checking the queued work",
            });
            expect(
              await channelOptions?.onToolResult?.({
                text: "Agents summary",
                channelData: { openclawToolProgressId: "tool:dynamic-1" },
              }),
            ).toBe(true);
            await emitToolStart(options, {
              name: "agents_list",
              phase: "start",
              toolCallId: "dynamic-1",
            });
          }
          expect(
            await channelOptions?.onToolResult?.({
              text: "Fast mode enabled",
              channelData: { openclawProgressKind: "fast-mode-auto" },
            }),
          ).toBe(true);
          await waitForBotApiCall((call) => String(call.fields.text).includes("Fast mode enabled"));
          expect(
            [...visibleMessages.values()].join("\n").match(/Fast mode enabled/gu),
          ).toHaveLength(1);
          if (mode === "progress") {
            expect([...visibleMessages.values()][0]).toContain("Checking the queued work");
            expect([...visibleMessages.values()][0]?.match(/Agents/gu)).toHaveLength(1);
            expect([...visibleMessages.values()][0]).not.toContain("Agents summary");
            expect([...visibleMessages.values()][0]).not.toContain("tokens");
          }
        },
        { mode, toolProgress: true, finalReply: { text: "The queued work is complete." } },
      );
      if (mode === "off") {
        expect([...visibleMessages.values()]).toEqual([
          "Fast mode enabled",
          "The queued work is complete.",
        ]);
      }
    },
  );

  it.each([
    { mode: "off", toolProgress: true, verbose: "full", visibleTool: false },
    { mode: "partial", toolProgress: false, verbose: "full", visibleTool: false },
    { mode: "progress", toolProgress: false, verbose: "full", visibleTool: false },
    { mode: "progress", toolProgress: true, verbose: "full", visibleTool: true },
    { mode: "progress", toolProgress: true, verbose: "off", visibleTool: false },
  ] as const)(
    "keeps verbose output owned by delivery ($mode, tool progress $toolProgress, $verbose)",
    async ({ mode, toolProgress, verbose, visibleTool }) => {
      await dispatchProgressTurn(
        async (options) => {
          await options?.onItemEvent?.({
            kind: "preamble",
            itemId: "verbose-commentary",
            phase: "end",
            progressText: "Inspecting the requested files",
          });
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "stdout" });
          await options?.onToolResult?.({
            text: "fixture stdout line one\nfixture stdout line two",
          });
        },
        {
          mode,
          toolProgress,
          cfg: { agents: { defaults: { verboseDefault: verbose } } },
          finalReply: { text: "Inspection complete." },
        },
      );
      const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(
        sends.filter((call) => String(call.fields.text).includes("fixture stdout")),
      ).toHaveLength(visibleTool ? 1 : 0);
      expect(sends.filter((call) => call.fields.text === "Inspecting the requested files")).toEqual(
        [],
      );
      expect([...visibleMessages.values()]).toContain("Inspection complete.");
    },
  );

  it.each(["raw", "status"] as const)(
    "preserves structured command detail against summaries with %s privacy",
    async (commandText) => {
      await dispatchProgressTurn(
        async (options, channelOptions) => {
          await emitToolStart(options, {
            name: "exec",
            phase: "start",
            toolCallId: "exec-1",
            args: { command: "echo fixture-private-token" },
          });
          await waitForBotApiCall(
            (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
          );
          expect(
            await channelOptions?.onToolResult?.({
              text: "Formatted summary must not replace the command",
              channelData: { openclawToolProgressId: "tool:exec-1" },
            }),
          ).toBe(true);
          await options?.onCommandOutput?.({
            phase: "end",
            title: "command echo fixture-private-token",
            name: "exec",
            toolCallId: "exec-1",
            output: "fixture-private-output",
            exitCode: 2,
          });
          await options?.onItemEvent?.(
            projectAgentToolActivity({
              toolCallId: "exec-1",
              name: "exec",
              phase: "result",
              args: { command: "echo fixture-private-token" },
              isError: true,
            }),
          );
          await waitForBotApiCall(
            (call) =>
              call.method === "editMessageText" && String(call.fields.text).includes("failed"),
          );
          const card = [...visibleMessages.values()][0] ?? "";
          expect(card.match(/Exec/gu)).toHaveLength(1);
          expect(card).toContain("failed");
          if (commandText === "raw") {
            expect(card).toContain("echo fixture-private-token");
          }
        },
        {
          mode: "progress",
          toolProgress: true,
          telegramCfg: {
            streaming: { mode: "progress", progress: { toolProgress: true, commandText } },
          },
          finalReply: { text: "The command failed." },
        },
      );
      const writes = JSON.stringify(calls.map((call) => call.fields.text));
      expect(writes).not.toContain("Formatted summary");
      expect(writes).not.toContain("fixture-private-output");
      expect(writes).not.toContain("command echo");
      if (commandText === "status") {
        expect(writes).not.toContain("fixture-private-token");
      }
    },
  );

  it("keeps the command text through the embedded producer's terminal command item", async () => {
    // The embedded exec producer's event order for one failing command: the
    // tool start, the tool and command items opening, a status-only output
    // projected from the tool result, the tool and command items ending with a
    // terminal status, then the command_output event titled "command false".
    const revisions = await dispatchProgressTurn(async (options) => {
      await emitToolStart(options, {
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await waitForBotApiCall(
        (call) => call.method === "sendMessage" && String(call.fields.text).includes("Exec"),
      );
      await options?.onItemEvent?.({
        itemId: "tool:exec-1",
        kind: "tool",
        title: "exec false",
        phase: "start",
        status: "running",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
        commandBearing: true,
      });
      await options?.onItemEvent?.({
        itemId: "command:exec-1",
        kind: "command",
        suppressChannelProgress: true,
        title: "command false",
        phase: "start",
        status: "running",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
      });
      await options?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        status: "failed",
        exitCode: 2,
      });
      await options?.onItemEvent?.({
        itemId: "tool:exec-1",
        kind: "tool",
        title: "exec false",
        phase: "end",
        status: "failed",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
        commandBearing: true,
      });
      await options?.onItemEvent?.({
        itemId: "command:exec-1",
        kind: "command",
        suppressChannelProgress: true,
        title: "command false",
        phase: "end",
        status: "failed",
        name: "exec",
        meta: "false",
        toolCallId: "exec-1",
        summary: "No such file or directory",
      });
      await options?.onCommandOutput?.({
        itemId: "command:exec-1",
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        status: "failed",
        exitCode: 2,
      });
    });

    // Intermediate item revisions may coalesce under the edit throttle, so the
    // sequence is checked by shape: the progress message opens with the running
    // command line, every edit targets that message and keeps the command text,
    // the last edit carries the exit status, and the final answer is separate.
    expect(revisions[0]).toEqual([
      "sendMessage",
      null,
      "<b>Working</b>\n<b>🛠️ Exec</b> false <i>running</i>",
    ]);
    expect(revisions.at(-1)).toEqual(["sendMessage", null, "The command failed."]);
    const edits = revisions.filter(([method]) => method === "editMessageText");
    expect(edits.length).toBeGreaterThan(0);
    for (const [, messageId, text] of edits) {
      expect(messageId).toBe(1);
      expect(text).toContain("<b>🛠️ Exec</b> false");
    }
    expect(edits.at(-1)?.[2]).toBe("<b>Working</b>\n<b>🛠️ Exec</b> false <i>failed</i>");
    for (const call of calls) {
      expect(call.fields.text ?? "").not.toContain("command false");
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { setHandoverRuntime } from "./iris-handover-runtime.js";
import irisHandoverExtension, { __testing } from "./iris-handover.js";

type HandoverHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createHandoverHandler(): HandoverHandler {
  let handler: HandoverHandler | undefined;
  const api = {
    on: (name: string, fn: unknown) => {
      if (name === "session_before_compact") {
        handler = fn as HandoverHandler;
      }
    },
    appendEntry: (_type: string, _data?: unknown) => {},
  } as unknown as ExtensionAPI;

  irisHandoverExtension(api);
  if (!handler) {
    throw new Error("missing session_before_compact handler");
  }
  return handler;
}

describe("iris-handover", () => {
  it("skips generation when there is no new conversation content", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "iris-handover-empty-"));
    const outputFile = path.resolve(workspace, "memory", "handover.md");
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, "# Previous Handover\n\n- [ ] item antigo", "utf-8");

    const sessionManager = {};
    setHandoverRuntime(sessionManager, {
      workspace,
      handoverConfig: {
        outputFile: "memory/handover.md",
      },
    });

    const handler = createHandoverHandler();
    const event = {
      preparation: {
        fileOps: { read: [], edited: [], written: [] },
        messagesToSummarize: [],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 150,
        settings: { reserveTokens: 1000 },
        previousSummary: "summary already present",
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const ctx = {
      model: { contextWindow: 200_000, maxTokens: 8_192 },
      modelRegistry: {
        getApiKey: async () => "test-api-key",
      },
      sessionManager,
    } as unknown as ExtensionContext;

    const result = await handler(event, ctx);
    const compaction = (result as { compaction: { summary: string } }).compaction;
    expect(compaction.summary).toContain("summary already present");
    expect(compaction.summary).toContain(__testing.EMPTY_CONVERSATION_SKIP_NOTICE);
    expect(fs.readFileSync(outputFile, "utf-8")).toContain("item antigo");
  });

  it("adds reconciliation and daily log guidance to the prompt", () => {
    const prompt = __testing.buildHandoverUserPrompt({
      ownerName: "Lucas",
      aiName: "Iris",
      dateTime: "quarta-feira, 18 de fevereiro de 2026 12:00",
      contactsJson: "{}",
      previousHandover: "- [ ] Tarefa pendente antiga",
      soulContext: "Trecho de personalidade",
      dailyLogContext: "Entradas do dia atual",
      conversation: "Usuario: atualizar status da tarefa",
      maxLines: 150,
      language: "pt-BR",
    });

    expect(prompt).toContain("Daily log excerpt (same-day context)");
    expect(prompt).toContain(
      'If a previous pending item was completed/cancelled/resolved this session, REMOVE it from "Pendências Ativas"',
    );
    expect(prompt).toContain(
      "Never carry old pending items blindly without evidence in this session",
    );
  });

  it("resolves daily log path with timezone-aware date stamp", () => {
    const resolved = __testing.resolveDailyLogPath(
      "/tmp/workspace",
      new Date("2026-02-18T12:00:00.000Z"),
      "UTC",
    );
    expect(resolved).toBe(path.resolve("/tmp/workspace", "memory", "2026-02-18.md"));
  });
});

import { expect, it, vi } from "vitest";
import type { CodexThreadItem } from "./app-server/protocol.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import {
  CODEX_LOCAL_SESSION_HOST_ID,
  catalogThreadItem,
  createEligibleControl,
  createRuntime,
  idleThread,
  readCodexSessionTranscript,
} from "./session-catalog.test-helpers.js";

const textItems = (...ids: string[]) => ids.map((id) => catalogThreadItem(id, { text: id }));
const commandItem = (id: string, aggregatedOutput: string) =>
  catalogThreadItem(id, { type: "commandExecution", aggregatedOutput });
const turnPage = (items: CodexThreadItem[], backwardsCursor?: string, nextCursor?: string) => ({
  data: [{ id: "turn-1", items: [...items] }],
  backwardsCursor,
  nextCursor,
});

function nativeItemControl(source: CodexThreadItem[]) {
  const listItemPage = vi.fn<CodexSessionCatalogControl["listItemPage"]>(
    async ({ cursor, limit }) => {
      const newestFirst = source.toReversed();
      const anchor = cursor ? newestFirst.findIndex((item) => cursor === `native:${item.id}`) : -1;
      expect(cursor === undefined || anchor >= 0).toBe(true);
      const selected = newestFirst.slice(anchor + 1, anchor + 1 + limit);
      const last = selected.at(-1);
      return {
        data: selected.map((item) => ({ turnId: "turn-1", item })),
        ...(last && anchor + 1 + selected.length < source.length
          ? { nextCursor: `native:${last.id}` }
          : {}),
      };
    },
  );
  return {
    listItemPage,
    control: createEligibleControl({
      requireEligibleThread: vi.fn(async () => idleThread({ historyMode: "paginated" })),
      listItemPage,
    }),
  };
}

function readTranscript(control: CodexSessionCatalogControl, limit: number, cursor?: string) {
  return readCodexSessionTranscript({
    runtime: createRuntime().runtime,
    control,
    hostId: CODEX_LOCAL_SESSION_HOST_ID,
    threadId: "thread-1",
    limit,
    ...(cursor ? { cursor } : {}),
  });
}

it.each(["inProgress", "in_progress", "running"])(
  "keeps %s items with partial output as calls",
  async (status) => {
    const { control } = nativeItemControl([
      catalogThreadItem("active", {
        type: "commandExecution",
        command: "check",
        status,
        aggregatedOutput: "Partial output",
      }),
    ]);
    const page = await readTranscript(control, 1);
    expect(page.items[0]).toMatchObject({ type: "toolCall", toolInput: { command: "check" } });
  },
);

it("preserves completed invocations, unknown outcomes, and reasoning without expanding native pages", async () => {
  const patch = "@@ -1 +1 @@\n-" + "old ".repeat(150) + "\n+" + "new ".repeat(150) + "\n";
  const source = [
    catalogThreadItem("failed", {
      type: "commandExecution",
      command: "false",
      cwd: "/repo",
      aggregatedOutput: "",
      status: "failed",
      exitCode: 1,
    }),
    catalogThreadItem("quiet", {
      type: "mcpToolCall",
      server: "docs",
      tool: "lookup",
      arguments: { query: "guide" },
      result: null,
      status: "completed",
    }),
    catalogThreadItem("dynamic", {
      type: "dynamicToolCall",
      tool: "custom",
      arguments: ["guide"],
      contentItems: [{ type: "inputText", text: "found" }],
      success: false,
      status: "failed",
    }),
    catalogThreadItem("unknown", {
      type: "commandExecution",
      command: "native-command",
      aggregatedOutput: "recorded output",
      status: "new-native-status",
    }),
    catalogThreadItem("declined", {
      type: "commandExecution",
      command: "publish",
      status: "declined",
    }),
    catalogThreadItem("commentary", { phase: "commentary", text: "Checking." }),
    catalogThreadItem("patch", {
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "/repo/example.ts", kind: { type: "update", move_path: null }, diff: patch },
      ],
    }),
    catalogThreadItem("reasoning", {
      type: "reasoning",
      summary: ["Summary"],
      content: ["Details"],
    }),
  ];
  const { control } = nativeItemControl(source);
  const first = await readTranscript(control, 2);
  const second = await readTranscript(control, 2, first.nextCursor);
  const third = await readTranscript(control, 2, second.nextCursor);
  const pages = [first, second, third];
  while (pages.at(-1)?.nextCursor) {
    pages.push(await readTranscript(control, 2, pages.at(-1)?.nextCursor));
  }
  const items = pages.flatMap((page) => page.items).toReversed();

  expect(items.map((item) => item.id)).toEqual(source.map((item) => item.id));
  expect(items[0]).toMatchObject({
    type: "toolResult",
    text: "",
    toolName: "bash",
    toolCallId: "failed",
    toolInput: { command: "false", cwd: "/repo" },
    isError: true,
    exitCode: 1,
    activity: { status: "failed" },
    toolDetails: { status: "failed", exitCode: 1 },
  });
  expect(items[1]).toMatchObject({
    type: "toolResult",
    text: "",
    toolName: "docs.lookup",
    toolCallId: "quiet",
    toolInput: { query: "guide" },
    isError: false,
  });
  expect(items[2]).toMatchObject({
    type: "toolResult",
    text: "found",
    toolName: "custom",
    toolCallId: "dynamic",
    toolInput: ["guide"],
    isError: true,
  });
  expect(items[3]).toMatchObject({ type: "toolResult", text: "recorded output" });
  expect(items[3]?.isError).toBeUndefined();
  expect(items[4]).toMatchObject({ activity: { status: "blocked" } });
  expect(items[5]).toMatchObject({ phase: "commentary" });
  expect(items[6]).toMatchObject({
    toolInput: {
      changes: [{ path: "/repo/example.ts", diff: patch, stat: { added: 1, removed: 1 } }],
    },
    toolDetails: { status: "completed" },
    activity: { name: "apply_patch", status: "completed" },
  });
  expect(items[7]).toMatchObject({ type: "reasoning", text: "Summary\n\nDetails" });
  expect(pages.at(-1)?.nextCursor).toBeUndefined();
});

it("cuts native pages by wire bytes without losing raw output or advancing past omitted items", async () => {
  const output = "海🌱\n".repeat(80_000);
  const source = Array.from({ length: 36 }, (_, index) =>
    catalogThreadItem(`tool-${index}`, {
      type: "commandExecution",
      command: output,
      aggregatedOutput: output,
    }),
  );
  const { control, listItemPage } = nativeItemControl(source);
  const first = await readTranscript(control, 50);
  const second = await readTranscript(control, 7, first.nextCursor);
  const third = await readTranscript(control, 50, second.nextCursor);
  const pages = [first, second, third];
  while (pages.at(-1)?.nextCursor && pages.length < source.length) {
    pages.push(await readTranscript(control, 50, pages.at(-1)?.nextCursor));
  }
  const delivered = pages.flatMap((page) => page.items);

  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.length).toBeLessThan(source.length);
  expect(first.nextCursor).toBe(`native:${first.items.at(-1)?.id}`);
  expect(listItemPage.mock.calls[1]?.[0].limit).toBeLessThan(50);
  expect(delivered.map((item) => item.id)).toEqual(source.toReversed().map((item) => item.id));
  expect(pages.at(-1)?.nextCursor).toBeUndefined();
  for (const page of pages) {
    expect(
      Buffer.byteLength(JSON.stringify({ payloadJSON: JSON.stringify(page) }), "utf8"),
    ).toBeLessThanOrEqual(20 * 1024 * 1024);
  }
  for (const item of delivered) {
    expect(item).toMatchObject({ raw: { aggregatedOutput: output }, truncated: true });
    expect(Buffer.byteLength(item.text ?? "", "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(item.text).toMatch(/…$/u);
  }
  expect(source.every((item) => item.aggregatedOutput === output)).toBe(true);
});

it("fails visibly when one complete raw item cannot fit the wire budget", async () => {
  const { control } = nativeItemControl([commandItem("oversized", "x".repeat(20 * 1024 * 1024))]);

  await expect(readTranscript(control, 1)).rejects.toThrow(
    "Codex transcript item exceeds the safe response size",
  );
});

it("resumes within a legacy turn after an append, then advances to the next native turn", async () => {
  const source = textItems(...Array.from({ length: 7 }, (_, index) => `item-${index}`));
  const listTurnPage = vi.fn<CodexSessionCatalogControl["listTurnPage"]>(async ({ cursor }) => {
    expect([undefined, "turn-anchor", "older-turns"]).toContain(cursor);
    if (cursor === "older-turns") {
      return {
        data: [{ id: "older", items: textItems("oldest") }],
        backwardsCursor: "older-anchor",
      };
    }
    return turnPage(source, "turn-anchor", "older-turns");
  });
  const control = createEligibleControl({ listTurnPage });

  const first = await readTranscript(control, 3);
  source.push(catalogThreadItem("appended", { text: "newer message" }));
  const second = await readTranscript(control, 2, first.nextCursor);
  const third = await readTranscript(control, 4, second.nextCursor);
  const fourth = await readTranscript(control, 4, third.nextCursor);

  expect(
    [first, second, third, fourth].flatMap((page) => page.items.map((item) => item.id)),
  ).toEqual(["item-6", "item-5", "item-4", "item-3", "item-2", "item-1", "item-0", "oldest"]);
  expect([third.nextCursor, fourth.nextCursor]).toEqual(["older-turns", undefined]);
  expect(listTurnPage.mock.calls.map(([request]) => request.limit)).toEqual([1, 1, 1, 1]);
  expect(listTurnPage.mock.calls[1]?.[0].cursor).toBe("turn-anchor");
});

it.each([
  [
    "removed item",
    "turn-anchor",
    "Codex transcript changed; refresh the session before loading older items",
  ],
  ["absent turn", undefined, "Codex app-server did not provide a transcript continuation anchor"],
] as const)("reports a %s anchor instead of losing the remainder", async (_kind, anchor, error) => {
  const source = textItems("oldest", "middle", "newest");
  const control = createEligibleControl({
    listTurnPage: vi.fn(async () => turnPage(source, anchor)),
  });
  let cursor: string | undefined;
  if (anchor) {
    cursor = (await readTranscript(control, 1)).nextCursor;
    source.pop();
  }
  await expect(readTranscript(control, anchor ? 2 : 1, cursor)).rejects.toThrow(error);
});

/* @vitest-environment jsdom */

import type { MemorySearchResponse } from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoriesView } from "./memories.tsx";
import {
  contextForTest,
  deferred,
  disposers,
  disposeTestViews,
  expectText,
  findButton,
  mountSettingsView,
  snapshot,
  waitForSolid,
} from "./memory.test-support.ts";
afterEach(disposeTestViews);

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const request = vi.fn<Request>();
const formatError = vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e)));
let element: HTMLElement;
let update: ReturnType<typeof mountSettingsView>["update"];
let lifetime: AbortController;
beforeEach(() => {
  request.mockReset();
  formatError.mockClear();
  lifetime = new AbortController();
  const context = contextForTest(
    snapshot({ advertisedMethods: ["memory.search"], routeIntent: "memories" }),
    {
      signal: lifetime.signal,
      request: <T,>(method: string, params?: unknown) =>
        request(method, params as Record<string, unknown>) as Promise<T>,
      formatError,
    },
  );
  ({ container: element, update } = mountSettingsView(memoriesView, context));
  disposers.push(lifetime.abort.bind(lifetime));
});
const input = () => element.querySelector<HTMLInputElement>("#memory-search-input")!;
const submitButton = () => element.querySelector<HTMLButtonElement>('button[type="submit"]');
function search(query = "Ada", submit = true) {
  input().value = query;
  input().dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  if (submit) {
    element
      .querySelector("form")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  }
}

const result = {
  path: "memory/people/ada.md",
  startLine: 2,
  endLine: 3,
  score: 0.876,
  snippet: "Ada prefers careful reviews.",
  source: "memory" as const,
};

function searchResponse(
  results: MemorySearchResponse["results"],
  overrides: Partial<MemorySearchResponse> = {},
): MemorySearchResponse {
  return { agentId: "main", provider: "local", searchMode: "hybrid", results, ...overrides };
}
const fileReads = () => request.mock.calls.filter(([method]) => method === "agents.workspace.get");
const matchedContent = "first\nmatched two\nmatched three";
const memoryFileResponse = (content: string) => ({ file: { encoding: "utf8", content } });
const rows = () => element.querySelectorAll<HTMLButtonElement>("article > button");
const match = () => element.querySelector('[data-memory-match="true"]')?.textContent;
const retry = () => findButton(element, /^Retry$/);
const waitText = (text: string) => waitForSolid(() => expect(element.textContent).toContain(text));
function clickRow(index = 0) {
  rows()[index]?.click();
  flush();
}
async function openResult() {
  await waitForSolid(() => expect(rows().length).toBeGreaterThan(0));
  clickRow();
}
const waitMatch = (text: string) => waitForSolid(() => expect(match()).toBe(text));

it("loads changed locales without replacing the search input or its draft", async () => {
  const originalInput = input();
  expect(originalInput.placeholder).toBe("Search this agent's memories");
  search("Ada", false);
  update({ locale: "fr" });
  await waitForSolid(() =>
    expect(originalInput.placeholder).toBe("Rechercher dans les souvenirs de cet agent"),
  );
  expect(input()).toBe(originalInput);
  expect(originalInput.value).toBe("Ada");
  expect(request).not.toHaveBeenCalled();
});

it.each(["search", "detail", "resolve", "reject"])(
  "ignores retired/replaced %s completions",
  async (kind) => {
    const previous = deferred<unknown>();
    const current = deferred<unknown>();
    const replaced = kind === "resolve" || kind === "reject";
    let reads = 0;
    request.mockImplementation((method) =>
      kind !== "search" && method === "memory.search"
        ? Promise.resolve(searchResponse([result]))
        : (reads++ === 0 ? previous : current).promise,
    );
    search();
    if (kind !== "search") {
      await openResult();
    }
    if (replaced) {
      search("Ada again");
      await openResult();
      await waitText("Loading the full memory file");
    } else {
      lifetime.abort();
    }
    if (kind === "resolve") {
      previous.resolve(memoryFileResponse("Retired content"));
    } else {
      previous.reject(new Error("Retired failure"));
    }
    await previous.promise.catch(() => undefined);
    flush();
    expect(formatError).not.toHaveBeenCalled();
    expectText(element, replaced ? ["Loading the full memory file"] : [], ["Retired"]);
    if (replaced) {
      current.resolve(memoryFileResponse("first\nFresh matched content\nthird"));
      await waitMatch("Fresh matched content\nthird");
    }
  },
);

it("hides search when the method is not advertised", () => {
  update({ advertisedMethods: [] });
  expect(element.textContent).toContain("Update the gateway to search memories");
  expect(element.querySelector("form")).toBeNull();
});

it("keeps search disabled when no agent is available", () => {
  update({ agentId: null });
  search();
  expect(submitButton()?.disabled).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("blocks offline retries and retries the search after reconnecting", async () => {
  const retried = deferred<MemorySearchResponse>();
  request
    .mockRejectedValueOnce(new Error("index unavailable"))
    .mockReturnValueOnce(retried.promise);
  search("missing");
  const originalInput = input();
  const originalSubmit = submitButton();
  await waitText("index unavailable");
  update({ connected: false, connectionEpoch: 2 });
  expect(retry()?.disabled).toBe(true);
  retry()?.click();
  expect(request).toHaveBeenCalledTimes(1);
  update({ connected: true, connectionEpoch: 3 });
  expect(retry()?.disabled).toBe(false);
  retry()?.click();
  await waitText("Searching");
  expect(element.textContent).not.toContain("index unavailable");
  expect(input()).toBe(originalInput);
  expect(submitButton()).toBe(originalSubmit);
  expect(originalSubmit?.disabled).toBe(true);
  retried.resolve(searchResponse([], { provider: "none", searchMode: "fts-only" }));
  await waitText("No memories matched");
  expect(element.textContent).toContain("keyword search");
  expect(originalSubmit?.disabled).toBe(false);
});

it("shares pending and loaded files across matches while keeping each row's highlight", async () => {
  const second = { ...result, startLine: 1, endLine: 1 };
  const third = { ...second, path: "memory/projects/Open Claw.md" };
  const pending = deferred<unknown>();
  request
    .mockResolvedValueOnce(searchResponse([result, second, third]))
    .mockImplementation((_method, params) =>
      params.path === result.path
        ? pending.promise
        : Promise.resolve(memoryFileResponse("Another memory file")),
    );
  search();
  await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(3));
  const expanded = () => [...rows()].map((button) => button.getAttribute("aria-expanded"));
  clickRow();
  await waitText("Loading the full memory file");
  clickRow(1);
  expect(expanded()).toEqual(["false", "true", "false"]);
  expect(fileReads()).toHaveLength(1);
  pending.resolve(memoryFileResponse(`${matchedContent}\nfourth`));
  await waitMatch("first");
  clickRow();
  expect(match()).toBe("matched two\nmatched three");
  clickRow();
  clickRow();
  expect(fileReads()).toHaveLength(1);
  const fileParams = { agentId: "main", path: result.path };
  expect(request).toHaveBeenCalledWith("agents.workspace.get", fileParams);
  clickRow(2);
  expect(expanded()).toEqual(["false", "false", "true"]);
  expect(rows()[2]?.getAttribute("aria-controls")).toBe("memory-detail-2");
  expect(element.querySelector("#memory-detail-2")).not.toBeNull();
  expect(fileReads()).toHaveLength(2);
});

it("keeps session, absolute, and escaping paths non-expandable", async () => {
  const nonExpandable = [
    { ...result, path: "sessions/main/session-1.jsonl", source: "sessions" as const },
    { ...result, path: "sessions/main/mislabeled.jsonl" },
    { ...result, path: "/external/MEMORY.md" },
    { ...result, path: "C:\\external\\MEMORY.md" },
    { ...result, path: "memory/../outside.md" },
  ];
  request.mockResolvedValue(searchResponse([{ ...result, path: "MEMORY.md" }, ...nonExpandable]));
  search("memory");
  await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(6));
  expect(element.querySelectorAll("article > button")).toHaveLength(1);
  expect(element.querySelectorAll("article > div.settings-row")).toHaveLength(5);
  expect(fileReads()).toHaveLength(0);
});

it("keeps results and the query through a same-identity reconnect and retries interrupted reads", async () => {
  request
    .mockResolvedValueOnce(searchResponse([result]))
    .mockRejectedValueOnce(new Error("gateway closed"))
    .mockResolvedValueOnce(memoryFileResponse(matchedContent));
  search();
  await openResult();
  await waitText("Could not load this memory file: gateway closed");
  expectText(element, [result.snippet], ["Memory search failed"]);
  update({ connected: false, connectionEpoch: 2 });
  expect(submitButton()?.disabled).toBe(true);
  update({ connected: true, connectionEpoch: 3 });
  expect(input().value).toBe("Ada");
  expect(element.textContent).toContain(result.snippet);
  expect(request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(1);

  clickRow();
  clickRow();
  await waitMatch("matched two\nmatched three");
  expect(fileReads()).toHaveLength(2);
});

it("shows stale guidance alongside empty results and clears it after a fresh search", async () => {
  const warning =
    "Memory index is stale: index scope changed (owner: configuration, code: scope). Search results may be incomplete.";
  const action =
    "Run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.";
  const fresh = { ...result, snippet: "Freshly indexed Ada prefers careful reviews." };
  request
    .mockResolvedValueOnce(
      searchResponse([], {
        provider: "none",
        searchMode: "fts-only",
        stale: true,
        warning,
        action,
      }),
    )
    .mockResolvedValueOnce(searchResponse([fresh], { provider: "none", searchMode: "fts-only" }));
  search();
  await waitText("No memories matched");
  const readText = () => (element.textContent ?? "").replace(/\s+/gu, " ").trim();
  expect(element.querySelectorAll("article")).toHaveLength(0);
  expect.soft(readText(), "stale result warning").toContain(warning);
  expect.soft(readText(), "agent-scoped recovery guidance").toContain(action);
  search("Ada fresh");
  await waitForSolid(() => expect(readText()).toContain(fresh.snippet));
  expect(readText()).not.toContain(warning);
  expect(readText()).not.toContain(action);
});

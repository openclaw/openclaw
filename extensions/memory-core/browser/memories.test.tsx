/* @vitest-environment jsdom */

import type { MemorySearchResponse } from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function createElement(request: Request, advertised = true, agentId: string | null = "main") {
  const lifetime = new AbortController();
  const formatError = vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  const props = snapshot({
    agentId,
    advertisedMethods: advertised ? ["memory.search", "agents.workspace.get"] : [],
    routeIntent: "memories",
  });
  const context = contextForTest(props, {
    signal: lifetime.signal,
    request: <T,>(method: string, params?: unknown) =>
      request(method, params as Record<string, unknown>) as Promise<T>,
    formatError,
  });
  const { container, update } = mountSettingsView(memoriesView, context);
  disposers.push(() => lifetime.abort());
  return Object.assign(container, {
    retire: () => lifetime.abort(),
    update,
    formatError,
  });
}

function typeQuery(element: HTMLElement, query: string) {
  flush();
  const input = element.querySelector<HTMLInputElement>("#memory-search-input");
  if (!input) {
    throw new Error("missing memory search input");
  }
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
}

function submit(element: HTMLElement) {
  element
    .querySelector("form")
    ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

function search(element: HTMLElement, query = "Ada") {
  typeQuery(element, query);
  submit(element);
}
function searchElement(request: Request, query = "Ada") {
  const element = createElement(request);
  search(element, query);
  return element;
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

function fileReads(request: { mock: { calls: Array<[string, ...unknown[]]> } }) {
  return request.mock.calls.filter(([method]) => method === "agents.workspace.get");
}

const memoryFileResponse = (content: string) => ({ file: { encoding: "utf8", content } });
function requestFiles(read: Request, results = [result]) {
  return vi.fn<Request>((method, params) =>
    method === "memory.search" ? Promise.resolve(searchResponse(results)) : read(method, params),
  );
}
const row = (element: HTMLElement) => element.querySelector<HTMLButtonElement>("article > button");
const match = (element: HTMLElement) =>
  element.querySelector('[data-memory-match="true"]')?.textContent;
const retry = (element: HTMLElement) => findButton(element, /^Retry$/);
const waitText = (element: HTMLElement, text: string) =>
  waitForSolid(() => expect(element.textContent).toContain(text));
async function openResult(element: HTMLElement) {
  await waitForSolid(() => expect(row(element)).not.toBeNull());
  row(element)?.click();
}
const waitMatch = (element: HTMLElement, text: string) =>
  waitForSolid(() => expect(match(element)).toBe(text));

describe("Memory Core indexed-search presentation", () => {
  it.each(["search", "detail"])("ignores retired %s errors before formatting", async (stage) => {
    const pending = deferred<unknown>();
    const request = vi.fn<Request>((method) =>
      stage === "detail" && method === "memory.search"
        ? Promise.resolve(searchResponse([result]))
        : pending.promise,
    );
    const element = searchElement(request);
    if (stage === "detail") {
      await openResult(element);
    }
    element.retire();
    element.formatError.mockImplementation(() => {
      throw new Error("retired formatter must not run");
    });
    pending.reject(new Error("retired failure"));
    await pending.promise.catch(() => undefined);
    flush();
    expect(element.formatError).not.toHaveBeenCalled();
    expect(element.textContent).not.toContain("retired failure");
  });

  it.each([
    [true, "Search for a person, project, decision"],
    [false, "Update the gateway to search memories"],
  ] satisfies [boolean, string][])("advertised=%s", (advertised, message) => {
    const element = createElement(vi.fn<Request>().mockResolvedValue({}), advertised);
    expect(element.textContent).toContain(message);
    expect(element.querySelector("form") === null).toBe(!advertised);
  });

  it("keeps search disabled when no agent is available", () => {
    const request = vi.fn<Request>().mockResolvedValue({});
    const element = createElement(request, true, null);
    typeQuery(element, "Ada");
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    submit(element);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([true, false])("retries failed searches only when connected=%s", async (connected) => {
    const retried = deferred<MemorySearchResponse>();
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockReturnValueOnce(retried.promise);
    const element = searchElement(request, "missing");
    const input = element.querySelector("input");
    const submitButton = element.querySelector<HTMLButtonElement>('button[type="submit"]');
    await waitText(element, "index unavailable");
    if (!connected) {
      element.update({ connected: false, connectionEpoch: 2 });
    }
    expect(retry(element)?.disabled).toBe(!connected);
    retry(element)?.click();
    if (connected) {
      await waitText(element, "Searching");
      expect(element.textContent).not.toContain("index unavailable");
      expect(element.querySelector("input")).toBe(input);
      expect(element.querySelector('button[type="submit"]')).toBe(submitButton);
      expect(submitButton?.disabled).toBe(true);
      retried.resolve(searchResponse([], { provider: "none", searchMode: "fts-only" }));
      await waitText(element, "No memories matched");
      expect(element.textContent).toContain("keyword search");
      expect(submitButton?.disabled).toBe(false);
    }
    expect(request).toHaveBeenCalledTimes(connected ? 2 : 1);
  });

  it("shares pending and loaded files across matches while keeping each row's highlight", async () => {
    const second = { ...result, startLine: 1, endLine: 1 };
    const third = { ...second, path: "memory/projects/Open Claw.md" };
    const pending = deferred<unknown>();
    const request = requestFiles(
      (_method, params) =>
        params.path === result.path
          ? pending.promise
          : Promise.resolve(memoryFileResponse("Another memory file")),
      [result, second, third],
    );
    const element = searchElement(request);
    await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(3));

    const rows = element.querySelectorAll<HTMLButtonElement>("article > button");
    const expanded = () => [...rows].map((button) => button.getAttribute("aria-expanded"));
    rows[0]?.click();
    await waitText(element, "Loading the full memory file");
    rows[1]?.click();
    flush();
    expect(expanded()).toEqual(["false", "true", "false"]);
    expect(element.querySelectorAll(".memory-memories__detail")).toHaveLength(1);
    expect(fileReads(request)).toHaveLength(1);

    pending.resolve(memoryFileResponse("first\nmatched two\nmatched three\nfourth"));
    await waitMatch(element, "first");
    rows[0]?.click();
    flush();
    expect(match(element)).toBe("matched two\nmatched three");

    rows[0]?.click();
    rows[0]?.click();
    flush();
    expect(fileReads(request)).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("agents.workspace.get", {
      agentId: "main",
      path: result.path,
    });

    rows[2]?.click();
    flush();
    expect(expanded()).toEqual(["false", "false", "true"]);
    expect(rows[2]?.getAttribute("aria-controls")).toBe("memory-detail-2");
    expect(element.querySelector("#memory-detail-2")).not.toBeNull();
    expect(fileReads(request)).toHaveLength(2);
  });

  it("keeps session, absolute, and escaping paths non-expandable", async () => {
    const nonExpandable = [
      { ...result, path: "sessions/main/session-1.jsonl", source: "sessions" as const },
      { ...result, path: "sessions/main/mislabeled.jsonl" },
      { ...result, path: "/external/MEMORY.md" },
      { ...result, path: "C:\\external\\MEMORY.md" },
      { ...result, path: "memory/../outside.md" },
    ];
    const request = vi.fn<Request>(() =>
      Promise.resolve(searchResponse([{ ...result, path: "MEMORY.md" }, ...nonExpandable])),
    );
    const element = searchElement(request, "memory");
    await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(6));

    expect(element.querySelectorAll("article > button")).toHaveLength(1);
    expect(element.querySelectorAll("article > div.settings-row")).toHaveLength(5);
    expect(fileReads(request)).toHaveLength(0);
  });

  it("keeps workspace read failures on the expanded row", async () => {
    const request = requestFiles(() => Promise.reject(new Error("workspace file not found")));
    const element = searchElement(request);
    await openResult(element);
    await waitText(element, "Could not load this memory file: workspace file not found");
    expectText(element, [result.snippet], ["Memory search failed"]);
  });

  it.each(["resolves", "rejects"] as const)("ignores stale %s reads", async (outcome) => {
    const previous = deferred<unknown>();
    const current = deferred<unknown>();
    let readCount = 0;
    const request = requestFiles(() => (readCount++ === 0 ? previous.promise : current.promise));
    const element = createElement(request);
    for (const query of ["Ada", "Ada again"]) {
      search(element, query);
      flush();
      await openResult(element);
      await waitText(element, "Loading the full memory file");
    }
    expect(readCount).toBe(2);

    if (outcome === "resolves") {
      previous.resolve(memoryFileResponse("Retired content"));
    } else {
      previous.reject(new Error("Retired read failure"));
    }
    await previous.promise.catch(() => undefined);
    flush();
    expectText(element, ["Loading the full memory file"], ["Retired"]);

    current.resolve(memoryFileResponse("first\nFresh matched content\nthird"));
    await waitMatch(element, "Fresh matched content\nthird");
  });

  it("keeps results and the query through a same-identity reconnect and retries interrupted reads", async () => {
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(searchResponse([result]))
      .mockRejectedValueOnce(new Error("gateway closed"))
      .mockResolvedValueOnce(memoryFileResponse("first\nmatched two\nmatched three"));
    const element = searchElement(request);
    await openResult(element);
    await waitText(element, "gateway closed");

    element.update({ connected: false, connectionEpoch: 2 });
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    element.update({ connected: true, connectionEpoch: 3 });
    expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("Ada");
    expect(element.textContent).toContain(result.snippet);
    expect(request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(1);

    row(element)?.click();
    flush();
    row(element)?.click();
    await waitMatch(element, "matched two\nmatched three");
    expect(fileReads(request)).toHaveLength(2);
  });

  it("shows stale guidance alongside empty results and clears it after a fresh search", async () => {
    const warning =
      "Memory index is stale: index scope changed (owner: configuration, code: scope). Search results may be incomplete.";
    const action =
      "Run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.";
    const fresh = { ...result, snippet: "Freshly indexed Ada prefers careful reviews." };
    const request = vi
      .fn<Request>()
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
    const element = searchElement(request);
    const readText = () => (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    await waitText(element, "No memories matched");
    expect(element.querySelectorAll("article")).toHaveLength(0);
    expect.soft(readText(), "stale result warning").toContain(warning);
    expect.soft(readText(), "agent-scoped recovery guidance").toContain(action);

    search(element, "Ada fresh");
    await waitForSolid(() => expect(readText()).toContain(fresh.snippet));
    expect(readText()).not.toContain(warning);
    expect(readText()).not.toContain(action);
  });
});

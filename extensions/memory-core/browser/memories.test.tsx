/* @vitest-environment jsdom */

import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  ControlUiSettingsView,
  MemorySearchResponse,
} from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoriesView } from "./memories.tsx";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});
const waitForSolid = (assertion: () => void) =>
  vi.waitFor(() => {
    flush();
    assertion();
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
function createElement(
  request: Request,
  advertised = true,
  initialAgentId: string | null = "main",
) {
  const container = document.createElement("div");
  document.body.append(container);
  let lifetime: AbortController;
  let view: ReturnType<ControlUiSettingsView["mount"]>;
  const formatError = vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  function mount(agentId: string | null) {
    lifetime?.abort();
    view?.dispose();
    lifetime = new AbortController();
    const snapshot: ControlUiSettingsSnapshot = {
      agentId,
      agentsLoading: false,
      agentsError: null,
      engine: { kind: "default", id: "memory-core", availability: "enabled" },
      connected: true,
      advertisedMethods: advertised ? ["memory.search", "agents.workspace.get"] : [],
      connectionEpoch: 1,
      routeIntent: "memories",
      locale: "en",
    };
    const context: ControlUiSettingsContext = {
      props: snapshot,
      signal: lifetime.signal,
      // This view uses semantic controls; shared visual primitives are exercised in the browser.
      components: {
        mountSection: vi.fn(),
        mountRow: vi.fn(),
        mountStatus: vi.fn(),
        mountValue: vi.fn(),
        mountNavigation: vi.fn(),
        mountLobster: vi.fn(),
      },
      request: <T,>(method: string, params?: unknown) =>
        request(method, params as Record<string, unknown>) as Promise<T>,
      formatError,
      formatRelativeTimestamp: String,
      navigate: vi.fn(),
      refreshAgents: vi.fn(),
    };
    view = memoriesView.mount(container, context);
    flush();
  }
  mount(initialAgentId);
  disposers.push(() => {
    lifetime.abort();
    view.dispose();
    container.remove();
  });
  return Object.assign(container, {
    retire: () => lifetime.abort(),
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
) {
  return { agentId: "main", provider: "local", searchMode: "hybrid", results, ...overrides };
}

function fileReads(request: { mock: { calls: Array<[string, ...unknown[]]> } }) {
  return request.mock.calls.filter(([method]) => method === "agents.workspace.get");
}

function memoryFileResponse(content: string) {
  return { file: { encoding: "utf8", content } };
}

describe("Memory Core indexed-search presentation", () => {
  it.each(["search", "detail"])(
    "discards a retired %s failure before using lifetime-bound error formatting",
    async (stage) => {
      const pending = deferred<unknown>();
      const request = vi.fn<Request>((method) =>
        stage === "detail" && method === "memory.search"
          ? Promise.resolve(searchResponse([result]))
          : pending.promise,
      );
      const element = createElement(request);
      search(element);
      if (stage === "detail") {
        await waitForSolid(() => expect(element.querySelector("article > button")).not.toBeNull());
        element.querySelector<HTMLButtonElement>("article > button")?.click();
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
    },
  );

  it.each([
    [true, "Search for a person, project, decision"],
    [false, "Update the gateway to search memories"],
  ] satisfies [boolean, string][])(
    "renders the advertised=%s search state",
    (advertised, message) => {
      const element = createElement(
        vi.fn(() => Promise.resolve({})),
        advertised,
      );
      expect(element.textContent).toContain(message);
      expect(element.querySelector("form") === null).toBe(!advertised);
    },
  );

  it("keeps search disabled when no agent is available", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const element = createElement(request, true, null);
    typeQuery(element, "Ada");
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    submit(element);
    expect(request).not.toHaveBeenCalled();
  });

  it("renders empty and retryable error states", async () => {
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce(searchResponse([], { provider: "none", searchMode: "fts-only" }));
    const element = createElement(request);
    search(element, "missing");
    await waitForSolid(() => expect(element.textContent).toContain("index unavailable"));

    const retry = [...element.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    retry?.click();
    await waitForSolid(() => expect(element.textContent).toContain("No memories matched"));
    expect(element.textContent).toContain("keyword search");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares pending and loaded files across matches while keeping each row's highlight", async () => {
    const second = { ...result, startLine: 1, endLine: 1 };
    const third = { ...second, path: "memory/projects/Open Claw.md" };
    const pending = deferred<unknown>();
    const fileResponse = memoryFileResponse("first\nmatched two\nmatched three\nfourth");
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "memory.search") {
        return Promise.resolve(searchResponse([result, second, third]));
      }
      return params.path === result.path
        ? pending.promise
        : Promise.resolve(memoryFileResponse("Another memory file"));
    });
    const element = createElement(request);
    search(element);
    await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(3));

    const rows = element.querySelectorAll<HTMLButtonElement>("article > button");
    rows[0]?.click();
    await waitForSolid(() => expect(element.textContent).toContain("Loading the full memory file"));
    rows[1]?.click();
    flush();
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(rows[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(element.querySelectorAll(".memory-memories__detail")).toHaveLength(1);
    expect(fileReads(request)).toHaveLength(1);

    pending.resolve(fileResponse);
    await waitForSolid(() =>
      expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe("first"),
    );
    rows[0]?.click();
    flush();
    expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe(
      "matched two\nmatched three",
    );

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
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(rows[2]?.getAttribute("aria-expanded")).toBe("true");
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
    const element = createElement(request);
    search(element, "memory");
    await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(6));

    expect(element.querySelectorAll("article > button")).toHaveLength(1);
    expect(element.querySelectorAll("article > div.settings-row")).toHaveLength(5);
    expect(fileReads(request)).toHaveLength(0);
  });

  it("keeps workspace read failures on the expanded row", async () => {
    const request = vi.fn((method: string) =>
      method === "memory.search"
        ? Promise.resolve(searchResponse([result]))
        : Promise.reject(new Error("workspace file not found")),
    );
    const element = createElement(request);
    search(element);
    await waitForSolid(() => expect(element.querySelector("article > button")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("article > button")?.click();

    await waitForSolid(() =>
      expect(element.textContent).toContain(
        "Could not load this memory file: workspace file not found",
      ),
    );
    expect(element.textContent).toContain(result.snippet);
    expect(element.textContent).not.toContain("Memory search failed");
  });

  it.each(["resolves", "rejects"] as const)(
    "keeps the current file read when an earlier search's read %s",
    async (outcome) => {
      const previous = deferred<unknown>();
      const current = deferred<unknown>();
      let readCount = 0;
      const request = vi.fn((method: string) => {
        if (method === "memory.search") {
          return Promise.resolve(searchResponse([result]));
        }
        return readCount++ === 0 ? previous.promise : current.promise;
      });
      const element = createElement(request);
      for (const query of ["Ada", "Ada again"]) {
        search(element, query);
        flush();
        await waitForSolid(() => expect(element.querySelector("article > button")).not.toBeNull());
        element.querySelector<HTMLButtonElement>("article > button")?.click();
        await waitForSolid(() =>
          expect(element.textContent).toContain("Loading the full memory file"),
        );
      }
      expect(readCount).toBe(2);

      if (outcome === "resolves") {
        previous.resolve(memoryFileResponse("Retired content"));
      } else {
        previous.reject(new Error("Retired read failure"));
      }
      await previous.promise.catch(() => undefined);
      flush();
      expect(element.textContent).toContain("Loading the full memory file");
      expect(element.textContent).not.toContain("Retired");

      current.resolve(memoryFileResponse("first\nFresh matched content\nthird"));
      await waitForSolid(() =>
        expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe(
          "Fresh matched content\nthird",
        ),
      );
    },
  );

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
    const element = createElement(request);
    const readText = () => (element.textContent ?? "").replace(/\s+/gu, " ").trim();
    search(element);
    await waitForSolid(() =>
      expect(element.querySelector(".memory-memories__results-heading")).not.toBeNull(),
    );
    expect(element.querySelectorAll("article")).toHaveLength(0);
    expect.soft(readText(), "stale result warning").toContain(warning);
    expect.soft(readText(), "agent-scoped recovery guidance").toContain(action);

    search(element, "Ada fresh");
    await waitForSolid(() => expect(readText()).toContain(fresh.snippet));
    expect(readText()).not.toContain(warning);
    expect(readText()).not.toContain(action);
  });
});

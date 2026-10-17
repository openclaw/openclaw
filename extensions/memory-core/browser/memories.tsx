/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type {
  AgentsWorkspaceGetResult,
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  ControlUiSettingsView,
  MemorySearchResponse,
} from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { createTranslator } from "./i18n/index.ts";
import "./memories.css";

type SearchResult = MemorySearchResponse["results"][number];
type SearchState =
  | { kind: "idle" | "loading" }
  | ({ kind: "ready"; query: string } & MemorySearchResponse)
  | { kind: "error"; query: string; message: string };
type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "error"; message: string };

type MemoryMemoriesProps = {
  context: ControlUiSettingsContext;
  snapshot: ControlUiSettingsSnapshot;
};

function resultKey(result: SearchResult, index: number): string {
  return `${index}:${result.path}:${result.startLine}:${result.endLine}`;
}

function isExpandableWorkspaceResult(result: SearchResult): boolean {
  const normalizedPath = result.path.replaceAll("\\", "/");
  const safeRelativePath =
    !normalizedPath.startsWith("/") &&
    !normalizedPath.startsWith("sessions/") &&
    !/^[a-zA-Z]:\//.test(normalizedPath) &&
    normalizedPath.split("/").every((segment) => segment && segment !== "." && segment !== "..");
  const workspaceMemoryPath =
    normalizedPath === "MEMORY.md" || normalizedPath.startsWith("memory/");
  // workspace.get is workspace-contained; sessions/* are logical manager paths.
  return result.source === "memory" && safeRelativePath && workspaceMemoryPath;
}

function FileContent(props: { content: string; result: SearchResult }) {
  const lines = createMemo(() => props.content.split(/\r?\n/));
  const start = () => Math.max(0, props.result.startLine - 1);
  const end = () => Math.min(lines().length, props.result.endLine);
  return (
    <pre class="memory-memories__file" tabindex={0}>
      <span>
        {lines().slice(0, start()).join("\n")}
        {start() ? "\n" : ""}
      </span>
      <mark data-memory-match="true">{lines().slice(start(), end()).join("\n")}</mark>
      <span>{end() < lines().length ? `\n${lines().slice(end()).join("\n")}` : ""}</span>
    </pre>
  );
}

function MemoryMemories(props: MemoryMemoriesProps) {
  const t = createTranslator(() => props.snapshot.locale);
  const methodAdvertised = () =>
    props.snapshot.advertisedMethods?.includes("memory.search") === true;
  const [query, setQuery] = createSignal("");
  const [searchState, setSearchState] = createSignal<SearchState>({ kind: "idle" });
  const [openResultKey, setOpenResultKey] = createSignal<string | null>(null);
  const [details, setDetails] = createSignal(new Map<string, DetailState>());
  let searchRequest: object | null = null;
  const detailRequests = new Map<string, object>();

  onSettled(() => () => {
    searchRequest = null;
    detailRequests.clear();
  });

  async function search(value: string) {
    const normalizedQuery = value.trim();
    const agentId = props.snapshot.agentId;
    if (
      !normalizedQuery ||
      !props.snapshot.connected ||
      !agentId ||
      !methodAdvertised() ||
      props.context.signal.aborted
    ) {
      return;
    }
    const request = {};
    searchRequest = request;
    detailRequests.clear();
    setQuery(normalizedQuery);
    setSearchState({ kind: "loading" });
    setOpenResultKey(null);
    setDetails(new Map());
    try {
      const result = await props.context.request<MemorySearchResponse>("memory.search", {
        query: normalizedQuery,
        agentId,
      });
      if (searchRequest !== request || props.context.signal.aborted) {
        return;
      }
      setSearchState({ kind: "ready", query: normalizedQuery, ...result });
    } catch (error) {
      if (searchRequest !== request || props.context.signal.aborted) {
        return;
      }
      setSearchState({
        kind: "error",
        query: normalizedQuery,
        message: props.context.formatError(error),
      });
    }
  }

  function toggleResult(result: SearchResult, index: number) {
    const key = resultKey(result, index);
    setOpenResultKey((current) => (current === key ? null : key));
    if (!detailRequests.has(result.path)) {
      void loadDetail(result.path);
    }
  }

  async function loadDetail(path: string) {
    const agentId = props.snapshot.agentId;
    if (
      !props.snapshot.connected ||
      !agentId ||
      !methodAdvertised() ||
      props.context.signal.aborted
    ) {
      return;
    }
    const request = {};
    detailRequests.set(path, request);
    setDetails((current) => new Map(current).set(path, { kind: "loading" }));
    try {
      const response = await props.context.request<AgentsWorkspaceGetResult>(
        "agents.workspace.get",
        {
          agentId,
          path,
        },
      );
      if (detailRequests.get(path) !== request || props.context.signal.aborted) {
        return;
      }
      const detail: DetailState =
        response.file.encoding === "utf8"
          ? { kind: "ready", content: response.file.content }
          : { kind: "error", message: t("memoryPage.memories.fileUnsupported") };
      setDetails((current) => new Map(current).set(path, detail));
    } catch (error) {
      if (detailRequests.get(path) !== request || props.context.signal.aborted) {
        return;
      }
      setDetails((current) =>
        new Map(current).set(path, { kind: "error", message: props.context.formatError(error) }),
      );
    }
  }

  function Detail(detailProps: { result: SearchResult; panelId: string }) {
    const detail = () => details().get(detailProps.result.path);
    const failure = () => {
      const current = detail();
      return current?.kind === "error" ? current : undefined;
    };
    const loaded = () => {
      const current = detail();
      return current?.kind === "ready" ? current : undefined;
    };
    return (
      <div id={detailProps.panelId} class="memory-memories__detail">
        {(!detail() || detail()?.kind === "loading") && (
          <p role="status">{t("memoryPage.memories.fileLoading")}</p>
        )}
        <Show when={failure()} keyed>
          {(error) => (
            <p class="memory-memories__detail-error" role="alert">
              {t("memoryPage.memories.fileError", { message: error.message })}
            </p>
          )}
        </Show>
        <Show when={loaded()} keyed>
          {(ready) => <FileContent content={ready.content} result={detailProps.result} />}
        </Show>
      </div>
    );
  }

  function ResultRow(rowProps: { result: SearchResult; index: number }) {
    const key = () => resultKey(rowProps.result, rowProps.index);
    const expandable = () => isExpandableWorkspaceResult(rowProps.result);
    const panelId = () => `memory-detail-${rowProps.index}`;
    function Summary() {
      return (
        <>
          <span class="settings-row__text">
            <span class="settings-row__title">{rowProps.result.snippet}</span>
            <span class="settings-row__desc memory-memories__path">
              {rowProps.result.path} ·{" "}
              {t("memoryPage.memories.lineRange", {
                start: String(rowProps.result.startLine),
                end: String(rowProps.result.endLine),
              })}
            </span>
          </span>
          <span class="settings-row__control memory-memories__meta">
            <span class="memory-memories__source">
              {t(
                rowProps.result.source === "sessions"
                  ? "memoryPage.memories.sourceSessions"
                  : "memoryPage.memories.sourceMemory",
              )}
            </span>
            <span>
              {t("memoryPage.memories.score", { score: rowProps.result.score.toFixed(2) })}
            </span>
          </span>
        </>
      );
    }
    return (
      <article class="memory-memories__result">
        {expandable() ? (
          <button
            type="button"
            class="settings-row settings-row--nav"
            aria-expanded={openResultKey() === key() ? "true" : "false"}
            aria-controls={panelId()}
            onClick={() => toggleResult(rowProps.result, rowProps.index)}
          >
            <Summary />
          </button>
        ) : (
          <div class="settings-row">
            <Summary />
          </div>
        )}
        {expandable() && openResultKey() === key() && (
          <Detail result={rowProps.result} panelId={panelId()} />
        )}
      </article>
    );
  }

  function Results(resultsProps: { ready: Extract<SearchState, { kind: "ready" }> }) {
    return (
      <>
        {resultsProps.ready.stale && (
          <div class="callout warn" role="status">
            {resultsProps.ready.warning && <p>{resultsProps.ready.warning}</p>}
            {resultsProps.ready.action && <p>{resultsProps.ready.action}</p>}
          </div>
        )}
        <div class="memory-memories__results-heading">
          <span>
            {t("memoryPage.memories.results", { count: String(resultsProps.ready.results.length) })}
          </span>
          <span class="memory-memories__mode">
            {t(
              resultsProps.ready.searchMode === "hybrid"
                ? "memoryPage.memories.hybridSearch"
                : "memoryPage.memories.keywordSearch",
            )}
          </span>
        </div>
        {resultsProps.ready.results.length === 0 ? (
          <p class="memory-memories__state">
            {t("memoryPage.memories.empty", { query: resultsProps.ready.query })}
          </p>
        ) : (
          <div class="settings-group memory-memories__results">
            <For each={resultsProps.ready.results} keyed={(result) => result}>
              {(result, index) => <ResultRow result={result()} index={index()} />}
            </For>
          </div>
        )}
      </>
    );
  }

  function SearchStatus() {
    const failure = () => {
      const current = searchState();
      return current.kind === "error" ? current : undefined;
    };
    const ready = () => {
      const current = searchState();
      return current.kind === "ready" ? current : undefined;
    };
    return (
      <>
        {searchState().kind === "loading" && (
          <p class="memory-memories__state" role="status">
            {t("memoryPage.memories.searching")}
          </p>
        )}
        <Show when={failure()} keyed>
          {(error) => (
            <div class="memory-memories__state" role="alert">
              <p>{t("memoryPage.memories.error", { message: error.message })}</p>
              <button class="btn btn--sm" onClick={() => void search(error.query)}>
                {t("memoryPage.memories.retry")}
              </button>
            </div>
          )}
        </Show>
        <Show when={ready()} keyed>
          {(result) => <Results ready={result} />}
        </Show>
        {searchState().kind === "idle" && (
          <p class="memory-memories__state">{t("memoryPage.memories.idle")}</p>
        )}
      </>
    );
  }

  return (
    <openclaw-memory-memories>
      <div class="settings-page memory-memories">
        {!methodAdvertised() ? (
          <p class="memory-memories__unavailable">
            {t("memoryPage.memories.gatewayUpdateRequired")}
          </p>
        ) : (
          <>
            <form
              class="memory-memories__search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                void search(query());
              }}
            >
              <label class="settings-control__sr-label" for="memory-search-input">
                {t("memoryPage.memories.searchLabel")}
              </label>
              <input
                id="memory-search-input"
                type="search"
                class="settings-input"
                value={query()}
                placeholder={t("memoryPage.memories.searchPlaceholder")}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <button
                class="btn btn--sm primary"
                type="submit"
                disabled={
                  !props.snapshot.connected ||
                  !props.snapshot.agentId ||
                  !query().trim() ||
                  searchState().kind === "loading"
                }
              >
                {t("memoryPage.memories.searchButton")}
              </button>
            </form>
            <SearchStatus />
          </>
        )}
      </div>
    </openclaw-memory-memories>
  );
}

export const memoriesView: ControlUiSettingsView = {
  placement: { section: "memory", panel: "memories" },
  mount(container, context) {
    // Only the host's imperative lifetime writes this presentation projection.
    const [snapshot, setSnapshot] = createSignal(context.props, { ownedWrite: true });
    const dispose = render(
      () => <MemoryMemories context={context} snapshot={snapshot()} />,
      container,
    );
    return { update: setSnapshot, dispose };
  },
};

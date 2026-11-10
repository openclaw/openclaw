/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type {
  AgentsWorkspaceGetResult,
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  ControlUiSettingsView,
  MemorySearchResponse,
} from "openclaw/plugin-sdk/control-ui";
import type { MemorySearchHit } from "openclaw/plugin-sdk/memory-host-search";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { createTranslator } from "./i18n/index.ts";
import { loadMessages } from "./i18n/locales.ts";
import "./memories.css";

type SearchResult = MemorySearchResponse["results"][number];
type ProviderSearchResponse = {
  version: 2;
  hits: MemorySearchHit[];
  warning?: string;
};
type ProviderRecordResponse =
  | { status: "ok"; text: string; truncated?: boolean }
  | { status: "not_found" };
type SearchResultPage = (MemorySearchResponse | ProviderSearchResponse) & { query: string };

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

function Empty(props: { children: string; status?: boolean }) {
  return (
    <div class="settings-group">
      <p class="settings-empty" role={props.status ? "status" : undefined}>
        {props.children}
      </p>
    </div>
  );
}

function FileContent(props: { content: string; result: SearchResult }) {
  let file!: HTMLPreElement;
  let match!: HTMLElement;
  // Open on the match itself; the file can be much longer than its window.
  onSettled(() => {
    file.scrollTop = Math.max(0, match.offsetTop - file.offsetTop - 24);
  });
  const lines = createMemo(() => props.content.split(/\r?\n/));
  const start = () => Math.max(0, props.result.startLine - 1);
  const end = () => Math.min(lines().length, props.result.endLine);
  return (
    <pre ref={(element) => (file = element)} class="memory-memories__file" tabindex={0}>
      <span>
        {lines().slice(0, start()).join("\n")}
        {start() ? "\n" : ""}
      </span>
      <mark ref={(element) => (match = element)} data-memory-match="true">
        {lines().slice(start(), end()).join("\n")}
      </mark>
      <span>{end() < lines().length ? `\n${lines().slice(end()).join("\n")}` : ""}</span>
    </pre>
  );
}

function MemoryMemories(props: MemoryMemoriesProps) {
  const t = createTranslator(() => props.snapshot.locale);
  const methodAdvertised = () =>
    props.snapshot.advertisedMethods?.includes("memory.search") === true;
  const [query, setQuery] = createSignal("");
  const [searchRead, setSearchRead] = createSignal<{
    query: string;
    result: Promise<SearchResultPage | undefined>;
  }>();
  const searchResult = createMemo(() => searchRead()?.result);
  const [openResultKey, setOpenResultKey] = createSignal<string | null>(null);
  let searchRequest: object | null = null;
  const detailRequests = new Map<string, string | Promise<string | undefined>>();

  onSettled(() => () => {
    searchRequest = null;
    detailRequests.clear();
  });

  function search(value: string) {
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
    setOpenResultKey(null);
    const providerRuntime = props.snapshot.engine.id && props.snapshot.engine.id !== "memory-core";
    const result = props.context
      .request<MemorySearchResponse | ProviderSearchResponse>("memory.search", {
        query: normalizedQuery,
        agentId,
        ...(providerRuntime ? { version: 2 } : {}),
      })
      .then((response) => {
        if (searchRequest !== request || props.context.signal.aborted) {
          return undefined;
        }
        return { ...response, query: normalizedQuery };
      })
      .catch((error: unknown) => {
        if (searchRequest !== request || props.context.signal.aborted) {
          return undefined;
        }
        throw error;
      });
    setSearchRead({ query: normalizedQuery, result });
    void result.catch(() => undefined);
  }

  function toggleResult(result: SearchResult, index: number) {
    const key = resultKey(result, index);
    const opening = openResultKey() !== key;
    setOpenResultKey(opening ? key : null);
    // Reopening retries a failed read, such as one interrupted by a reconnect.
    if (opening && !detailRequests.has(result.path)) {
      loadDetail(result.path);
    }
  }

  function loadDetail(path: string) {
    const agentId = props.snapshot.agentId;
    if (
      !props.snapshot.connected ||
      !agentId ||
      !methodAdvertised() ||
      props.context.signal.aborted
    ) {
      return;
    }
    const request = props.context
      .request<AgentsWorkspaceGetResult>("agents.workspace.get", { agentId, path })
      .then((response) => {
        if (detailRequests.get(path) !== request || props.context.signal.aborted) {
          return undefined;
        }
        if (response.file.encoding !== "utf8") {
          throw new Error(t("memoryPage.memories.fileUnsupported"));
        }
        detailRequests.set(path, response.file.content);
        return response.file.content;
      })
      .catch((error: unknown) => {
        if (detailRequests.get(path) !== request || props.context.signal.aborted) {
          return undefined;
        }
        // Failed reads are retried on reopen; pending and successful reads stay shared.
        detailRequests.delete(path);
        throw error;
      });
    detailRequests.set(path, request);
    // The row can close before the request settles, leaving no mounted async reader.
    void request.catch(() => undefined);
  }

  function providerKey(hit: MemorySearchHit): string {
    return `provider:${JSON.stringify(hit.reference)}`;
  }

  function toggleProviderResult(hit: MemorySearchHit) {
    const key = providerKey(hit);
    const opening = openResultKey() !== key;
    setOpenResultKey(opening ? key : null);
    if (
      !opening ||
      detailRequests.has(key) ||
      !props.snapshot.connected ||
      props.context.signal.aborted
    ) {
      return;
    }
    const request = props.context
      .request<ProviderRecordResponse>("memory.get", {
        version: 2,
        agentId: props.snapshot.agentId,
        reference: hit.reference,
      })
      .then((response) => {
        if (detailRequests.get(key) !== request || props.context.signal.aborted) {
          return undefined;
        }
        if (response.status !== "ok") {
          throw new Error(t("memoryPage.memories.recordMissing"));
        }
        const text =
          response.text +
          (response.truncated ? `\n\n${t("memoryPage.memories.recordPartial")}` : "");
        detailRequests.set(key, text);
        return text;
      })
      .catch((error: unknown) => {
        if (detailRequests.get(key) !== request || props.context.signal.aborted) {
          return undefined;
        }
        detailRequests.delete(key);
        throw error;
      });
    detailRequests.set(key, request);
    void request.catch(() => undefined);
  }

  function ProviderDetail(detailProps: { hit: MemorySearchHit; panelId: string }) {
    const detail = createMemo(() => detailRequests.get(providerKey(detailProps.hit)));
    return (
      <div id={detailProps.panelId} class="memory-memories__detail">
        <Loading fallback={<p role="status">{t("memoryPage.memories.recordLoading")}</p>}>
          <Errored
            fallback={(error) => (
              <p class="memory-memories__detail-error" role="alert">
                {t("memoryPage.memories.recordError", {
                  message: props.context.formatError(error()),
                })}
              </p>
            )}
          >
            <pre class="memory-memories__file" tabindex={0}>
              {detail() ?? ""}
            </pre>
          </Errored>
        </Loading>
      </div>
    );
  }

  function Detail(detailProps: { result: SearchResult; panelId: string }) {
    const detail = createMemo(() => detailRequests.get(detailProps.result.path));
    const loading = () => <p role="status">{t("memoryPage.memories.fileLoading")}</p>;
    return (
      <div id={detailProps.panelId} class="memory-memories__detail">
        <Loading fallback={loading()}>
          <Errored
            fallback={(error) => (
              <p class="memory-memories__detail-error" role="alert">
                {t("memoryPage.memories.fileError", {
                  message: props.context.formatError(error()),
                })}
              </p>
            )}
          >
            <Show when={detail() !== undefined} fallback={loading()}>
              <FileContent content={detail() ?? ""} result={detailProps.result} />
            </Show>
          </Errored>
        </Loading>
      </div>
    );
  }

  function ResultRow(rowProps: { result: SearchResult; index: number }) {
    const key = () => resultKey(rowProps.result, rowProps.index);
    const expandable = () => isExpandableWorkspaceResult(rowProps.result);
    const panelId = () => `memory-detail-${rowProps.index}`;
    // Each label stays with its number when the line wraps.
    const details = () =>
      [
        t("memoryPage.memories.lineRange", {
          start: String(rowProps.result.startLine),
          end: String(rowProps.result.endLine),
        }),
        t(
          rowProps.result.source === "sessions"
            ? "memoryPage.memories.sourceSessions"
            : "memoryPage.memories.sourceMemory",
        ),
        t("memoryPage.memories.score", { score: rowProps.result.score.toFixed(2) }),
      ]
        .map((part) => part.replaceAll(" ", "\u00a0"))
        .join(" · ");
    function Summary() {
      return (
        <>
          <span class="settings-row__text">
            <span class="memory-memories__snippet">{rowProps.result.snippet}</span>
            <span class="settings-row__desc memory-memories__meta">
              <code>{rowProps.result.path}</code> · {details()}
            </span>
          </span>
          {expandable() ? (
            <span class="settings-row__control">
              <span class="settings-row__chevron memory-memories__chevron">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </span>
            </span>
          ) : undefined}
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

  function Results(resultsProps: { ready: SearchResultPage }) {
    const providerPage = () => {
      const ready = resultsProps.ready;
      return "hits" in ready ? ready : undefined;
    };
    const workspacePage = () => {
      const ready = resultsProps.ready;
      return "results" in ready ? ready : undefined;
    };
    return (
      <>
        <Show when={providerPage()} keyed>
          {(ready) => <ProviderResults ready={ready} />}
        </Show>
        <Show when={workspacePage()} keyed>
          {(ready) => <WorkspaceResults ready={ready} />}
        </Show>
      </>
    );
  }

  function ProviderResults(resultsProps: { ready: ProviderSearchResponse & { query: string } }) {
    const ready = () => resultsProps.ready;
    return (
      <>
        {ready().warning && (
          <div class="callout warn" role="status">
            <p>{ready().warning}</p>
          </div>
        )}
        {ready().hits.length === 0 ? (
          <Empty>{t("memoryPage.memories.empty", { query: ready().query })}</Empty>
        ) : (
          <section class="settings-section">
            <p class="memory-memories__summary">
              {t(
                ready().hits.length === 1
                  ? "memoryPage.memories.resultOne"
                  : "memoryPage.memories.results",
                { count: String(ready().hits.length) },
              )}
            </p>
            <div class="settings-group memory-memories__results">
              <For each={ready().hits} keyed={(hit) => providerKey(hit)}>
                {(hit, index) => (
                  <article class="memory-memories__result">
                    <button
                      type="button"
                      class="settings-row settings-row--nav"
                      disabled={
                        !props.snapshot.connected ||
                        !props.snapshot.advertisedMethods?.includes("memory.get")
                      }
                      aria-expanded={openResultKey() === providerKey(hit()) ? "true" : "false"}
                      aria-controls={`provider-detail-${index()}`}
                      onClick={() => toggleProviderResult(hit())}
                    >
                      <span class="settings-row__text">
                        <span class="memory-memories__snippet">{hit().excerpt}</span>
                        <span class="settings-row__desc memory-memories__meta">
                          <code>
                            {hit()
                              .citations?.map((citation) => citation.label)
                              .join(" · ") || hit().reference.id}
                          </code>
                          {hit().score !== undefined &&
                            ` · ${t("memoryPage.memories.score", { score: hit().score?.toFixed(2) ?? "" })}`}
                        </span>
                      </span>
                    </button>
                    {openResultKey() === providerKey(hit()) && (
                      <ProviderDetail hit={hit()} panelId={`provider-detail-${index()}`} />
                    )}
                  </article>
                )}
              </For>
            </div>
          </section>
        )}
      </>
    );
  }

  function WorkspaceResults(resultsProps: { ready: MemorySearchResponse & { query: string } }) {
    return (
      <>
        {resultsProps.ready.stale && (
          <div class="callout warn" role="status">
            {resultsProps.ready.warning && <p>{resultsProps.ready.warning}</p>}
            {resultsProps.ready.action && <p>{resultsProps.ready.action}</p>}
          </div>
        )}
        {resultsProps.ready.results.length === 0 ? (
          <Empty>{t("memoryPage.memories.empty", { query: resultsProps.ready.query })}</Empty>
        ) : (
          <section class="settings-section">
            <p class="memory-memories__summary">
              {t(
                resultsProps.ready.results.length === 1
                  ? "memoryPage.memories.resultOne"
                  : "memoryPage.memories.results",
                { count: String(resultsProps.ready.results.length) },
              )}{" "}
              ·{" "}
              {t(
                resultsProps.ready.searchMode === "hybrid"
                  ? "memoryPage.memories.hybridSearch"
                  : "memoryPage.memories.keywordSearch",
              )}
            </p>
            <div class="settings-group memory-memories__results">
              <For each={resultsProps.ready.results} keyed={(result) => result}>
                {(result, index) => <ResultRow result={result()} index={index()} />}
              </For>
            </div>
          </section>
        )}
      </>
    );
  }

  function SearchStatus() {
    return (
      <Loading
        on={searchRead()}
        fallback={<Empty status>{t("memoryPage.memories.searching")}</Empty>}
      >
        <Errored
          fallback={(error, reset) => (
            <div class="settings-group">
              <div class="settings-row memory-memories__error" role="alert">
                <p>
                  {t("memoryPage.memories.error", {
                    message: props.context.formatError(error()),
                  })}
                </p>
                <button
                  class="btn btn--sm"
                  disabled={!props.snapshot.connected || !props.snapshot.agentId}
                  onClick={() => {
                    search(searchRead()?.query ?? "");
                    reset();
                  }}
                >
                  {t("memoryPage.memories.retry")}
                </button>
              </div>
            </div>
          )}
        >
          <Show
            when={searchResult()}
            fallback={<Empty>{t("memoryPage.memories.idle")}</Empty>}
            keyed
          >
            {(result) => <Results ready={result} />}
          </Show>
        </Errored>
      </Loading>
    );
  }

  return (
    <openclaw-memory-memories>
      <div class="settings-page memory-memories">
        {!methodAdvertised() ? (
          <Empty>{t("memoryPage.memories.gatewayUpdateRequired")}</Empty>
        ) : (
          <>
            <form
              class="memory-memories__search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                search(query());
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
              <Loading>
                <button
                  class="btn btn--sm primary"
                  type="submit"
                  disabled={
                    !props.snapshot.connected ||
                    !props.snapshot.agentId ||
                    !query().trim() ||
                    isPending(searchResult)
                  }
                >
                  {t("memoryPage.memories.searchButton")}
                </button>
              </Loading>
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
    void loadMessages(context.props.locale);
    // Only the host's imperative lifetime writes this presentation projection.
    const [snapshot, setSnapshot] = createSignal(context.props, { ownedWrite: true });
    const dispose = render(
      () => <MemoryMemories context={context} snapshot={snapshot()} />,
      container,
    );
    return {
      update(next) {
        void loadMessages(next.locale);
        setSnapshot(next);
      },
      dispose,
    };
  },
};

/** @jsxImportSource @solidjs/web */
import { Dynamic } from "@solidjs/web";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { ResearchView, ResearchViewSource } from "../src/view-contract.js";
import type { createResearchClient, Snapshot } from "./client.js";
import { reportBlocks, safeSourceUrl, sourceDomain } from "./report.js";

const labels = {
  "provider-cited": "Provider-cited",
  "retrieved-text": "Retrieved text",
  "supplied-document": "Supplied document",
};
export function ResearchPane(props: { client: ReturnType<typeof createResearchClient> }) {
  const [snapshot, setSnapshot] = createSignal<Snapshot>(props.client.read());
  const [tab, setTab] = createSignal("Progress");
  const [question, setQuestion] = createSignal(props.client.pending()?.question ?? "");
  const [focusSource, setFocusSource] = createSignal<string>();
  const details = new Map<string, HTMLDetailsElement>();
  let citationFocus: HTMLButtonElement | undefined;
  let reportRegion: HTMLElement | undefined;
  onSettled(() => {
    let incarnation = props.client.read().incarnation;
    const stop = props.client.subscribe((value) => {
      if (
        (incarnation && incarnation !== value.incarnation) ||
        (!value.incarnation && value.error)
      ) {
        setQuestion("");
        details.clear();
        citationFocus = undefined;
        reportRegion = undefined;
        setFocusSource(undefined);
      }
      if (value.sessionId && props.client.pending()) {
        setQuestion(props.client.pending()!.question);
      }
      incarnation = value.incarnation;
      setSnapshot(value);
    });
    void props.client.refresh();
    return stop;
  });
  const job = () => snapshot().job;
  const canMutate = () =>
    snapshot().writable && !snapshot().offline && !snapshot().busy && Boolean(snapshot().sessionId);
  const citation = (sourceId: string, button: HTMLButtonElement) => {
    citationFocus = button;
    setFocusSource(sourceId);
    setTab("Sources");
    onSettled(() => {
      const entry = details.get(sourceId);
      if (entry) {
        entry.open = true;
        entry.querySelector("summary")?.focus();
      }
    });
  };
  const back = () => {
    setTab("Report");
    onSettled(() => {
      // Report tab is retained, so the originating citation remains a valid focus target.
      if (citationFocus?.isConnected) {
        citationFocus.focus();
      } else {
        reportRegion?.focus();
      }
    });
  };
  return (
    <section class="deep-research-pane" aria-label="Deep research">
      <header class="deep-research-heading">
        <div>
          <h2>Deep research</h2>
          <p>Progress, evidence and open questions</p>
        </div>
        <button
          type="button"
          onClick={() => void props.client.refresh()}
          disabled={snapshot().loading || snapshot().offline}
        >
          Refresh
        </button>
      </header>
      <Show when={snapshot().offline}>
        <p role="status" class="deep-research-notice">
          Offline · Last observed snapshot. Actions are disabled.
        </p>
      </Show>
      <Show when={snapshot().error}>
        <p role="alert" class="deep-research-notice">
          {snapshot().error}
        </p>
      </Show>
      <Show when={snapshot().actionError}>
        <p role="alert" class="deep-research-notice">
          {snapshot().actionError}
        </p>
      </Show>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void props.client.mutate("start", question());
        }}
      >
        <label class="deep-research-field">
          Research question
          <textarea
            rows={3}
            maxlength={8000}
            value={question()}
            onInput={(event) => setQuestion(event.currentTarget.value)}
            required
            disabled={snapshot().busy || Boolean(snapshot().pending)}
            placeholder="What would you like to investigate?"
          />
        </label>
        <button type="submit" disabled={!canMutate() || !question().trim()}>
          {snapshot().pending ? "Retry pending start" : "Start research"}
        </button>
      </form>
      <label class="deep-research-field">
        Retained research
        <select
          value={snapshot().selected ?? ""}
          onChange={(event) => void props.client.choose(event.currentTarget.value)}
          disabled={snapshot().busy || !snapshot().jobs.length}
        >
          <Show when={!snapshot().jobs.length}>
            <option value="">No research in this conversation</option>
          </Show>
          <For each={snapshot().jobs} keyed={(entry) => entry.jobId}>
            {(entry) => (
              <option value={entry().jobId}>
                {entry().title} · {entry().state}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show
        when={job()}
        fallback={
          <p>
            {snapshot().loading
              ? "Loading research…"
              : "Start a question to build an evidence-backed report."}
          </p>
        }
      >
        {(current) => (
          <>
            <div role="status" aria-live="polite" class="deep-research-status">
              <strong>{current().phase}</strong>
              <span>{current().summary}</span>
            </div>
            <div class="deep-research-actions">
              <Show when={current().cancelRequested}>
                <span>Cancellation requested · awaiting terminal observation</span>
              </Show>
              <For each={current().actions}>
                {(action) => (
                  <button
                    type="button"
                    disabled={!canMutate()}
                    onClick={() => void props.client.mutate(action)}
                  >
                    {action === "cancel" ? "Cancel research" : "Resume research"}
                  </button>
                )}
              </For>
            </div>
            <nav aria-label="Research sections" class="deep-research-tabs">
              <For each={["Progress", "Sources", "Report"]}>
                {(name) => (
                  <button
                    type="button"
                    aria-pressed={tab() === name ? "true" : "false"}
                    onClick={() => setTab(name)}
                  >
                    {name}
                    {name === "Sources" ? ` (${current().sources.length})` : ""}
                  </button>
                )}
              </For>
            </nav>
            <section hidden={tab() !== "Progress"} aria-label="Research progress">
              <h3>{current().title}</h3>
              <p>
                State: <strong>{current().state}</strong>
              </p>
              <Show when={current().state === "indeterminate"}>
                <p class="deep-research-notice">
                  An operation may have been submitted without a receipt. It will not be blindly
                  restarted.
                </p>
              </Show>
              <Show when={current().counts}>
                {(counts) => (
                  <dl class="deep-research-counts">
                    <div>
                      <dt>Sources retained</dt>
                      <dd>{counts().sources}</dd>
                    </div>
                    <div>
                      <dt>Searches</dt>
                      <dd>{counts().searches}</dd>
                    </div>
                    <div>
                      <dt>Fetches</dt>
                      <dd>{counts().fetches}</dd>
                    </div>
                    <div>
                      <dt>Model calls</dt>
                      <dd>{counts().modelCalls}</dd>
                    </div>
                  </dl>
                )}
              </Show>
              <p class="deep-research-muted">Observed counts, not estimated completion or cost.</p>
              <time datetime={new Date(current().updatedAt).toISOString()}>
                Last recorded: {new Date(current().updatedAt).toLocaleString()}
              </time>
              <Gaps job={current()} />
            </section>
            <section hidden={tab() !== "Sources"} aria-label="Research sources">
              <Show when={focusSource()}>
                <button type="button" onClick={back}>
                  Back to citation
                </button>
              </Show>
              <p class="deep-research-muted">
                Attribution and quote matching are not verification of truth.
              </p>
              <For
                each={current().sources}
                keyed={(source) => source.id}
                fallback={<p>No sources have been retained yet.</p>}
              >
                {(source) => (
                  <Source
                    source={source()}
                    job={current()}
                    register={(id, element) => details.set(id, element)}
                  />
                )}
              </For>
            </section>
            <section
              hidden={tab() !== "Report"}
              aria-label="Research report"
              tabindex={-1}
              ref={(element) => {
                reportRegion = element;
              }}
            >
              <Show
                when={current().report}
                fallback={
                  <p>The report will appear when evidence is ready. Sources may arrive earlier.</p>
                }
              >
                <p class="deep-research-muted">
                  {current().state === "completed"
                    ? "Completed report"
                    : "Available report · may be incomplete"}
                </p>
                <Report job={current()} onCitation={citation} />
                <Gaps job={current()} />
              </Show>
            </section>
          </>
        )}
      </Show>
    </section>
  );
}
function Gaps(props: { job: ResearchView }) {
  return (
    <>
      <Show when={props.job.gaps.length}>
        <h3>Open questions and gaps</h3>
        <ul>
          <For each={props.job.gaps}>{(gap) => <li>{gap}</li>}</For>
        </ul>
      </Show>
      <Show when={props.job.limitations.length}>
        <h3>Limitations</h3>
        <ul>
          <For each={props.job.limitations}>{(limit) => <li>{limit}</li>}</For>
        </ul>
      </Show>
    </>
  );
}
function Source(props: {
  source: ResearchViewSource;
  job: ResearchView;
  register: (id: string, element: HTMLDetailsElement) => void;
}) {
  const url = () => safeSourceUrl(props.source.url);
  return (
    <details
      class="deep-research-source"
      ref={(element) => props.register(props.source.id, element)}
    >
      <summary>
        <strong>{props.source.title}</strong>
        <span>
          {props.source.id} · {sourceDomain(props.source.url)}
        </span>
        <span class="deep-research-badge">{labels[props.source.provenance]}</span>
      </summary>
      <Show when={url()}>
        {(href) => (
          <p>
            <a href={href()} target="_blank" rel="noopener noreferrer">
              Open source in new tab ↗
            </a>
          </p>
        )}
      </Show>
      <p>
        {props.source.retrievalStatus === "not-fetched"
          ? "Provider attribution only. Text was not fetched."
          : "Retained text"}
        {props.source.retrievedAt ? ` · ${props.source.retrievedAt}` : ""}
      </p>
      <Show when={props.source.excerpt}>
        <h4>Available excerpt</h4>
        <blockquote>{props.source.excerpt}</blockquote>
      </Show>
      <For
        each={props.job.findings.filter((finding) =>
          finding.evidence.some((item) => item.sourceId === props.source.id),
        )}
      >
        {(finding) => (
          <div>
            <h4>{finding.statement}</h4>
            <span class="deep-research-badge">Quote matched (mechanical)</span>
            <Show when={finding.support === "model-supported"}>
              <span class="deep-research-badge">Model-supported (fallible)</span>
            </Show>
            <For each={finding.evidence.filter((item) => item.sourceId === props.source.id)}>
              {(item) => <blockquote>{item.quote}</blockquote>}
            </For>
          </div>
        )}
      </For>
    </details>
  );
}
function Report(props: {
  job: ResearchView;
  onCitation: (id: string, button: HTMLButtonElement) => void;
}) {
  const blocks = createMemo(() => reportBlocks(props.job));
  return (
    <div class="deep-research-report">
      <For each={blocks()}>
        {(block) => (
          <Dynamic component={block.heading === 1 ? "h3" : block.heading ? "h4" : "p"}>
            <For each={block.segments}>
              {(segment) =>
                segment.sourceId ? (
                  <button
                    type="button"
                    class="deep-research-citation"
                    aria-label={`Source ${segment.sourceId}`}
                    onClick={(event) => props.onCitation(segment.sourceId!, event.currentTarget)}
                  >
                    {segment.text}
                  </button>
                ) : (
                  <span>{segment.text}</span>
                )
              }
            </For>
          </Dynamic>
        )}
      </For>
    </div>
  );
}

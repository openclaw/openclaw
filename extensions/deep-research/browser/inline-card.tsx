/** @jsxImportSource @solidjs/web */
import { For, Show, createSignal, onSettled } from "solid-js";
import type { ResearchView } from "../api.js";
import type { createResearchClient, Snapshot } from "./client.js";

export type CardTone = "running" | "ready" | "attention" | "failed" | "idle";
export type CardTab = "Progress" | "Report";

const jobStatus: Record<ResearchView["state"], { label: string; tone: CardTone }> = {
  queued: { label: "Starting", tone: "running" },
  submitting: { label: "Starting", tone: "running" },
  running: { label: "Researching", tone: "running" },
  completed: { label: "Report ready", tone: "ready" },
  partial: { label: "Partial report", tone: "attention" },
  paused: { label: "Paused", tone: "attention" },
  indeterminate: { label: "Status unknown", tone: "attention" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "idle" },
};

/** Card status wording and tone; a pending cancellation outranks the running state. */
export function describeJob(job: Pick<ResearchView, "state" | "cancelRequested">): {
  label: string;
  tone: CardTone;
} {
  const status = jobStatus[job.state];
  return job.cancelRequested && status.tone === "running"
    ? { label: "Cancelling", tone: "attention" }
    : status;
}

function plural(count: number, noun: string): string {
  return count + " " + noun + (count === 1 ? "" : "s");
}

// Running jobs describe their current step; settled jobs name their outcome.
function details(job: ResearchView): string[] {
  const status = describeJob(job);
  const parts = [
    status.tone === "running" ? job.summary : status.label,
    plural(job.counts?.sources ?? job.sources.length, "source"),
  ];
  if (job.findings.length) {
    parts.push(plural(job.findings.length, "finding"));
  }
  if (job.gaps.length) {
    parts.push(plural(job.gaps.length, "open gap"));
  }
  return parts;
}

/** Transcript card for the research job started by one `deep_research` tool call. */
export function ResearchInlineCard(props: {
  client: ReturnType<typeof createResearchClient>;
  jobId: string;
  summary: string;
  open: (tab: CardTab) => void;
}) {
  const [snapshot, setSnapshot] = createSignal<Snapshot>(() => props.client.read());
  onSettled(() => {
    const stop = props.client.subscribe(setSnapshot);
    void props.client.refresh();
    return stop;
  });
  // The client falls back to another job when this one is not listed; never show that one.
  const job = () => (snapshot().job?.jobId === props.jobId ? snapshot().job : undefined);
  const canAct = () => snapshot().writable && !snapshot().offline && !snapshot().busy;
  // Read and action failures stay visible whether or not a job has loaded.
  const problem = () => snapshot().actionError ?? snapshot().error;
  return (
    <section
      class="deep-research-card"
      aria-label="Deep research"
      data-tone={job() ? describeJob(job()!).tone : undefined}
    >
      <div class="deep-research-card__row">
        <svg class="deep-research-card__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m20 20-4.6-4.6" />
        </svg>
        <Show
          when={job()}
          fallback={
            <p class="deep-research-card__detail" role="status">
              {snapshot().loading ? "Loading research…" : props.summary}
            </p>
          }
        >
          {(current) => (
            <>
              <div class="deep-research-card__text">
                <p class="deep-research-card__title" title={current().question}>
                  {current().title}
                </p>
                <p class="deep-research-card__detail">
                  <span class="deep-research-card__status" role="status">
                    {details(current())[0]}
                  </span>
                  <For each={details(current()).slice(1)}>
                    {(part) => (
                      <span>
                        <span class="deep-research-card__separator" aria-hidden="true">
                          ·
                        </span>
                        {part}
                      </span>
                    )}
                  </For>
                </p>
              </div>
              <div class="deep-research-card__actions">
                <For each={current().actions}>
                  {(action) => (
                    <button
                      type="button"
                      class="deep-research-card__quiet"
                      disabled={!canAct()}
                      onClick={() => void props.client.mutate(action)}
                    >
                      {action === "cancel" ? "Cancel" : "Resume"}
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="deep-research-card__button"
                  onClick={() => props.open(current().report ? "Report" : "Progress")}
                >
                  {current().report ? "Read report" : "View progress"}
                </button>
              </div>
            </>
          )}
        </Show>
      </div>
      <Show when={problem()}>
        {(message) => (
          <p class="deep-research-card__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </section>
  );
}

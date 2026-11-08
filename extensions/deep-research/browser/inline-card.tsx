/** @jsxImportSource @solidjs/web */
import { For, Show, createSignal, onSettled } from "solid-js";
import type { ResearchView } from "../api.js";
import type { createResearchClient, Snapshot } from "./client.js";

export type CardTone = "running" | "ready" | "attention" | "failed" | "idle";
export type CardTab = "Progress" | "Report";

const steps = [
  { phase: "planning", label: "Plan" },
  { phase: "gathering", label: "Gather" },
  { phase: "assessing", label: "Assess" },
  { phase: "auditing", label: "Audit" },
] as const;

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

type StepState = "done" | "active" | "pending";

// Running jobs pulse their current step; terminal jobs keep the furthest step they reached.
// Unknown phases (managed engines) show no stepper rather than an invented position.
function stepStates(job: ResearchView): StepState[] | undefined {
  if (job.state === "completed") {
    return steps.map(() => "done");
  }
  const reached = steps.findIndex((step) => step.phase === job.phase);
  const live = describeJob(job).tone === "running";
  if (reached < 0) {
    return live ? steps.map((_, index) => (index === 0 ? "active" : "pending")) : undefined;
  }
  return steps.map((_, index) => {
    if (index < reached) {
      return "done";
    }
    if (index === reached) {
      return live ? "active" : "done";
    }
    return "pending";
  });
}

function plural(count: number, noun: string): string {
  return count + " " + noun + (count === 1 ? "" : "s");
}

// Sources always; findings and gaps once the job has produced them.
function metaLine(job: ResearchView): string {
  const parts = [plural(job.counts?.sources ?? job.sources.length, "source")];
  if (job.findings.length) {
    parts.push(plural(job.findings.length, "finding"));
  }
  if (job.gaps.length) {
    parts.push(plural(job.gaps.length, "open gap"));
  }
  return parts.join(" · ");
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.6-4.6" />
    </svg>
  );
}

// Read and action failures stay visible whether or not a job has loaded.
function ProblemNotice(props: { message: string | undefined }) {
  return (
    <Show when={props.message}>
      {(message) => (
        <p class="deep-research-card__error" role="alert">
          {message()}
        </p>
      )}
    </Show>
  );
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
  const problem = () => snapshot().actionError ?? snapshot().error;
  return (
    <section
      class="deep-research-card"
      aria-label="Deep research"
      data-tone={job() ? describeJob(job()!).tone : "idle"}
    >
      <Show
        when={job()}
        fallback={
          <>
            <div class="deep-research-card__header">
              <span class="deep-research-card__glyph">
                <SearchGlyph />
              </span>
              <span class="deep-research-card__eyebrow">Deep research</span>
              <span class="deep-research-card__fallback" role="status">
                {snapshot().loading ? "Loading research…" : props.summary}
              </span>
            </div>
            <ProblemNotice message={problem()} />
          </>
        }
      >
        {(current) => {
          const status = () => describeJob(current());
          const findings = () => current().findings;
          return (
            <>
              <div class="deep-research-card__header">
                <span class="deep-research-card__glyph">
                  <SearchGlyph />
                </span>
                <span class="deep-research-card__eyebrow">Deep research</span>
                <span class="deep-research-card__pill" role="status">
                  <span class="deep-research-card__dot" aria-hidden="true" />
                  {status().label}
                  <Show when={snapshot().offline}> · Offline</Show>
                </span>
              </div>
              <h3 class="deep-research-card__title" title={current().question}>
                {current().title}
              </h3>
              <Show when={stepStates(current())}>
                {(states) => (
                  <ol class="deep-research-card__steps" aria-label="Research steps">
                    <For each={steps}>
                      {(step, index) => (
                        <li
                          data-state={states()[index()]}
                          aria-current={states()[index()] === "active" ? "step" : undefined}
                        >
                          <span class="deep-research-card__track" />
                          <span class="deep-research-card__step-label">{step.label}</span>
                        </li>
                      )}
                    </For>
                  </ol>
                )}
              </Show>
              <Show when={status().tone === "running" || !findings().length}>
                <p class="deep-research-card__summary">{current().summary}</p>
              </Show>
              <Show when={findings().length}>
                <ul class="deep-research-card__findings" aria-label="Top findings">
                  <For each={findings().slice(0, 2)}>
                    {(finding) => (
                      <li>
                        <span class="deep-research-card__finding-text">{finding.statement}</span>
                        <span class="deep-research-card__cites">
                          <For each={[...new Set(finding.evidence.map((item) => item.sourceId))]}>
                            {(sourceId) => <span class="deep-research-card__cite">{sourceId}</span>}
                          </For>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <ProblemNotice message={problem()} />
              <div class="deep-research-card__footer">
                <p class="deep-research-card__meta">{metaLine(current())}</p>
                <div class="deep-research-card__actions">
                  <For each={current().actions}>
                    {(action) => (
                      <button
                        type="button"
                        class="deep-research-card__button"
                        disabled={!canAct()}
                        onClick={() => void props.client.mutate(action)}
                      >
                        {action === "cancel" ? "Cancel" : "Resume"}
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    class="deep-research-card__button deep-research-card__button--primary"
                    onClick={() => props.open(current().report ? "Report" : "Progress")}
                  >
                    {current().report ? "Read report" : "View progress"}
                  </button>
                </div>
              </div>
            </>
          );
        }}
      </Show>
    </section>
  );
}

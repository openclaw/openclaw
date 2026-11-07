/** @jsxImportSource @solidjs/web */
import { For, Show, createSignal, onSettled } from "solid-js";
import type { ResearchView } from "../api.js";
import type { createResearchClient, Snapshot } from "./client.js";

type Tone = "running" | "ready" | "attention" | "failed" | "idle";

const phases = ["planning", "gathering", "assessing", "auditing"];

const jobStatus: Record<ResearchView["state"], { label: string; tone: Tone }> = {
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

/** Card status wording and tone for a retained job; running jobs also name their phase. */
export function describeJob(job: Pick<ResearchView, "state" | "phase">): {
  label: string;
  tone: Tone;
} {
  const status = jobStatus[job.state];
  return job.state === "running" ? { ...status, label: `${status.label} · ${job.phase}` } : status;
}

// Number of completed phase segments; terminal jobs fill the whole bar.
function phaseProgress(job: ResearchView): number {
  if (["completed", "partial", "failed", "cancelled"].includes(job.state)) {
    return phases.length;
  }
  return Math.max(phases.indexOf(job.phase) + 1, job.state === "running" ? 1 : 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Short counts line: sources always, findings and gaps once the job has produced them.
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

/** Transcript card for the research job started by one `deep_research` tool call. */
export function ResearchInlineCard(props: {
  client: ReturnType<typeof createResearchClient>;
  jobId: string;
  summary: string;
  open: () => void;
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
  return (
    <section class="deep-research-card" aria-label="Deep research">
      <Show
        when={job()}
        fallback={
          <p class="deep-research-card__status">
            <span class="deep-research-card__dot" aria-hidden="true" />
            {snapshot().loading ? "Loading research…" : props.summary}
          </p>
        }
      >
        {(current) => (
          <>
            <p class="deep-research-card__status" data-tone={describeJob(current()).tone}>
              <span class="deep-research-card__dot" aria-hidden="true" />
              Deep research · {describeJob(current()).label}
              <Show when={snapshot().offline}> · offline</Show>
            </p>
            <h3 class="deep-research-card__title">{current().title}</h3>
            <div class="deep-research-card__phases" aria-hidden="true">
              <For each={phases}>
                {(_, index) => (
                  <i data-done={index() < phaseProgress(current()) ? "" : undefined} />
                )}
              </For>
            </div>
            <p class="deep-research-card__meta">{metaLine(current())}</p>
            <Show when={current().findings.length}>
              <ul class="deep-research-card__findings">
                <For each={current().findings.slice(0, 3)}>
                  {(finding) => <li>{finding.statement}</li>}
                </For>
              </ul>
            </Show>
            <Show when={!current().findings.length && current().gaps[0]}>
              {(gap) => <p class="deep-research-card__gap">{gap()}</p>}
            </Show>
            <div class="deep-research-card__actions">
              <button type="button" class="primary" onClick={() => props.open()}>
                {current().report ? "Read report" : "Open details"}
              </button>
              <For each={current().actions}>
                {(action) => (
                  <button
                    type="button"
                    disabled={!canAct()}
                    onClick={() => void props.client.mutate(action)}
                  >
                    {action === "cancel" ? "Cancel" : "Resume"}
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}

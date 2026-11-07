/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
import { Show, createSignal, onSettled } from "solid-js";
import type { ResearchView } from "../api.js";
import { createResearchClient, type Snapshot } from "./client.js";
import { ResearchPane } from "./pane.js";
import "./styles.css";

export default defineControlUiPlugin({
  id: "deep-research",
  activate(host) {
    // Selection contains opaque locators only; every view owns its authorized data cache.
    const selected = new Map<string, string>();
    const mount =
      (accessory: boolean): ControlUiPanel["mount"] =>
      (container, initial) => {
        const key = JSON.stringify([initial.props.agentId, initial.props.sessionKey]);
        const client = createResearchClient(
          initial.host,
          initial.props,
          initial.signal,
          () => selected.get(key),
          (id) => {
            selected.set(key, id);
            host.ui.invalidate();
          },
          !accessory,
        );
        const dispose = render(
          () =>
            accessory ? (
              <ResearchAccessory
                client={client}
                open={() => initial.host.ui.openPanel("research", initial.props)}
              />
            ) : (
              <ResearchPane client={client} />
            ),
          container,
        );
        return {
          dispose: () => {
            client.dispose();
            dispose();
          },
          update: () => {
            if (selected.has(key) && selected.get(key) !== client.read().selected) {
              void client.refresh();
            }
          },
        };
      };
    const disposers = [
      host.ui.registerPanel({ id: "research", label: "Deep research", mount: mount(false) }),
      host.ui.registerAction({
        id: "research",
        label: "Deep research",
        placement: "session",
        run: (context) =>
          context.host.ui.openPanel("research", {
            sessionKey: context.sessionKey,
            agentId: context.agentId,
          }),
      }),
      host.ui.registerAccessory({
        id: "research-progress",
        placement: "session-header",
        mount: mount(true),
      }),
    ];
    return () => {
      disposers.forEach((dispose) => dispose());
      selected.clear();
    };
  },
});

type ChipTone = "running" | "ready" | "attention" | "failed" | "idle";

// Maps a retained job state to the chip's wording and tone.
function describeJob(job: Pick<ResearchView, "state" | "phase">): {
  label: string;
  tone: ChipTone;
} {
  switch (job.state) {
    case "queued":
    case "submitting":
    case "running":
      return { label: `Researching · ${job.phase}`, tone: "running" };
    case "completed":
      return { label: "Research report ready", tone: "ready" };
    case "partial":
      return { label: "Partial research report", tone: "attention" };
    case "paused":
      return { label: "Research paused", tone: "attention" };
    case "indeterminate":
      return { label: "Research status unknown", tone: "attention" };
    case "failed":
      return { label: "Research failed", tone: "failed" };
    case "cancelled":
      return { label: "Research cancelled", tone: "idle" };
  }
}

/** Session-header chip, shown only while this session has retained research. */
function ResearchAccessory(props: {
  client: ReturnType<typeof createResearchClient>;
  open: () => void;
}) {
  const [snapshot, setSnapshot] = createSignal<Snapshot>(() => props.client.read());
  onSettled(() => {
    const stop = props.client.subscribe(setSnapshot);
    void props.client.refresh();
    return stop;
  });
  // The full view may still be loading; the list entry already carries state and counts.
  const job = () =>
    snapshot().job ?? snapshot().jobs.find((entry) => entry.jobId === snapshot().selected);
  return (
    <Show when={job()}>
      {(current) => {
        const label = () => {
          const sources = current().counts?.sources;
          const count =
            sources === undefined ? "" : ` · ${sources} ${sources === 1 ? "source" : "sources"}`;
          return `${describeJob(current()).label}${count}${snapshot().offline ? " · offline" : ""}`;
        };
        return (
          <button
            class="deep-research-chip"
            data-tone={describeJob(current()).tone}
            data-offline={snapshot().offline ? "" : undefined}
            type="button"
            onClick={() => props.open()}
            aria-label={`Open deep research: ${label()}`}
          >
            <span class="deep-research-chip__dot" aria-hidden="true" />
            <span>{label()}</span>
          </button>
        );
      }}
    </Show>
  );
}

/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
import { Show, createSignal, onSettled } from "solid-js";
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
        placement: "header",
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
function ResearchAccessory(props: {
  client: ReturnType<typeof createResearchClient>;
  open: () => void;
}) {
  const [snapshot, setSnapshot] = createSignal<Snapshot>(props.client.read());
  onSettled(() => {
    const stop = props.client.subscribe(setSnapshot);
    void props.client.refresh();
    return stop;
  });
  return (
    <button
      class="deep-research-accessory"
      type="button"
      onClick={() => props.open()}
      aria-label="Open deep research progress"
    >
      {snapshot().offline
        ? "Research · offline"
        : snapshot().job
          ? `Research · ${snapshot().job!.phase}`
          : "Deep research"}
      <Show when={snapshot().job?.counts}>
        {(counts) => ` · ${counts().sources} ${counts().sources === 1 ? "source" : "sources"}`}
      </Show>
    </button>
  );
}

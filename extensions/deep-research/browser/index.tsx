/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createResearchClient } from "./client.js";
import { ResearchPane } from "./pane.js";
import "./styles.css";

export default defineControlUiPlugin({
  id: "deep-research",
  activate(host) {
    // Selection contains opaque locators only; every view owns its authorized data cache.
    const selected = new Map<string, string>();
    const dispose = host.ui.registerPanel({
      id: "research",
      label: "Deep research",
      mount: (container, initial) => {
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
        );
        const unmount = render(() => <ResearchPane client={client} />, container);
        return {
          dispose: () => {
            client.dispose();
            unmount();
          },
          update: () => {
            if (selected.has(key) && selected.get(key) !== client.read().selected) {
              void client.refresh();
            }
          },
        };
      },
    });
    return () => {
      dispose();
      selected.clear();
    };
  },
});

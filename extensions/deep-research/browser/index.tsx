/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import {
  defineControlUiPlugin,
  type ControlUiHost,
  type ControlUiPanel,
} from "openclaw/plugin-sdk/control-ui";
import { createSignal } from "solid-js";
import { RESEARCH_INLINE_VIEW } from "../api.js";
import { createResearchClient } from "./client.js";
import { ResearchInlineCard, type CardTab } from "./inline-card.js";
import { ResearchPane } from "./pane.js";
import "./styles.css";

type InlineMount = Parameters<ControlUiHost["ui"]["registerInlineView"]>[0]["mount"];

// Reads the job id from a saved tool-result payload; other shapes render the summary only.
function payloadJobId(payload: unknown): string {
  return payload &&
    typeof payload === "object" &&
    "jobId" in payload &&
    typeof payload.jobId === "string"
    ? payload.jobId
    : "";
}

export default defineControlUiPlugin({
  id: "deep-research",
  activate(host) {
    // Selection contains opaque locators only; every view owns its authorized data cache.
    const selected = new Map<string, string>();
    // A card's open request names the panel tab to show; the panel consumes it once.
    const tabRequests = new Map<string, CardTab>();
    const selectionKey = (scope: { agentId?: string; sessionKey: string }) =>
      JSON.stringify([scope.agentId, scope.sessionKey]);
    const takeTab = (key: string) => {
      const tab = tabRequests.get(key);
      tabRequests.delete(key);
      return tab;
    };
    const mountPanel: ControlUiPanel["mount"] = (container, initial) => {
      const key = selectionKey(initial.props);
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
      const [tabRequest, setTabRequest] = createSignal<{ tab: CardTab } | undefined>(
        (() => {
          const tab = takeTab(key);
          return tab ? { tab } : undefined;
        })(),
      );
      const unmount = render(
        () => <ResearchPane client={client} tabRequest={tabRequest} />,
        container,
      );
      return {
        dispose: () => {
          client.dispose();
          unmount();
        },
        update: () => {
          const tab = takeTab(key);
          if (tab) {
            setTabRequest({ tab });
          }
          if (selected.has(key) && selected.get(key) !== client.read().selected) {
            void client.refresh();
          }
        },
      };
    };
    // One card per tool call, pinned to the job that call started.
    const mountInline: InlineMount = (container, initial) => {
      const scope = { sessionKey: initial.props.sessionKey, agentId: initial.props.agentId };
      const jobId = payloadJobId(initial.props.payload);
      const client = createResearchClient(
        initial.host,
        scope,
        initial.signal,
        () => jobId,
        () => {},
        false,
      );
      const open = (tab: CardTab) => {
        const key = selectionKey(scope);
        selected.set(key, jobId);
        tabRequests.set(key, tab);
        host.ui.invalidate();
        initial.host.ui.openPanel("research", scope);
      };
      const unmount = render(
        () => (
          <ResearchInlineCard client={client} jobId={jobId} summary="Deep research" open={open} />
        ),
        container,
      );
      return {
        dispose: () => {
          client.dispose();
          unmount();
        },
      };
    };
    const disposers = [
      host.ui.registerPanel({ id: "research", label: "Deep research", mount: mountPanel }),
      host.ui.registerInlineView({ ...RESEARCH_INLINE_VIEW, mount: mountInline }),
    ];
    return () => {
      disposers.forEach((dispose) => dispose());
      selected.clear();
      tabRequests.clear();
    };
  },
});

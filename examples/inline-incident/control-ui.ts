import {
  defineControlUiPlugin,
  type ControlUiHost,
  type ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import "./control-ui.css";

type Incident = {
  incidentId: string;
  title: string;
  service: string;
  severity: string;
  status: string;
  acknowledged: boolean;
};
type Session = { sessionKey: string; agentId?: string };
// Shared module state connects the inline view and panel. Only the two demo IDs are retained.
const snapshots = new Map<string, Incident>();
let selection: (Session & { incidentId: string }) | undefined;

function mountIncident(
  container: HTMLElement,
  initial: ControlUiViewContext<Session>,
  incidentId: string,
  panel: boolean,
) {
  let context = initial;
  let disposed = false;
  const card = document.createElement("section");
  card.className = "incident-tools-card";
  const eyebrow = document.createElement("div");
  eyebrow.className = "incident-tools-eyebrow";
  const title = document.createElement("h3");
  const status = document.createElement("p");
  status.className = "incident-tools-status";
  const output = document.createElement("p");
  output.setAttribute("role", "status");
  const controls = document.createElement("div");
  controls.className = "incident-tools-controls";
  const acknowledge = document.createElement("button");
  acknowledge.type = "button";
  acknowledge.className = "btn btn--sm";
  const details = document.createElement("button");
  details.type = "button";
  details.className = "btn btn--sm";
  details.textContent = "Open incident panel";
  const render = () => {
    const incident = snapshots.get(incidentId);
    eyebrow.textContent = incident ? incident.severity + " · " + incident.incidentId : incidentId;
    title.textContent = incident?.title ?? "Loading incident…";
    status.textContent = incident
      ? incident.service + " · " + incident.status
      : "Fetching current status";
    acknowledge.textContent = incident?.acknowledged ? "Acknowledged" : "Acknowledge";
    acknowledge.disabled = !incident || incident.acknowledged || !context.host.connection.canWrite;
  };
  acknowledge.addEventListener("click", () => {
    acknowledge.disabled = true;
    void context.host
      .request<Incident>("incident-tools.acknowledge", { incidentId })
      .then((incident) => {
        if (disposed) {
          return;
        }
        context.signal.throwIfAborted();
        snapshots.set(incidentId, incident);
        context.host.ui.invalidate();
        render();
      })
      .catch((error: unknown) => {
        if (!disposed && !context.signal.aborted) {
          output.textContent = String(error);
          render();
        }
      });
  });
  details.addEventListener("click", () => {
    selection = {
      sessionKey: context.props.sessionKey,
      agentId: context.props.agentId,
      incidentId,
    };
    context.host.ui.invalidate();
    context.host.ui.openPanel("incident-details", {
      sessionKey: context.props.sessionKey,
      agentId: context.props.agentId,
    });
  });
  controls.append(acknowledge);
  if (!panel) {
    controls.append(details);
  }
  card.append(eyebrow, title, status, controls, output);
  container.append(card);
  render();
  // Mount is repeatable and read-only; acknowledgments happen only on explicit clicks.
  void context.host
    .request<Incident>("incident-tools.get", { incidentId })
    .then((incident) => {
      if (disposed) {
        return;
      }
      context.signal.throwIfAborted();
      snapshots.set(incidentId, incident);
      render();
    })
    .catch((error: unknown) => {
      if (!disposed && !context.signal.aborted) {
        context.reportError?.(error);
      }
    });
  return {
    update(next: ControlUiViewContext<Session>) {
      context = next;
      render();
    },
    dispose() {
      disposed = true;
      card.remove();
    },
  };
}

export default defineControlUiPlugin({
  id: "incident-tools",
  activate(host: ControlUiHost) {
    host.ui.registerInlineView({
      id: "incident-dashboard",
      version: 1,
      mount(container, context) {
        const payload = context.props.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          typeof payload.incidentId !== "string"
        ) {
          throw new Error("This incident payload is unsupported.");
        }
        return mountIncident(container, context, payload.incidentId, false);
      },
    });
    host.ui.registerPanel({
      id: "incident-details",
      label: "Incident details",
      mount(container, context) {
        let currentId: string | undefined;
        let mounted: ReturnType<typeof mountIncident> | undefined;
        const update = (next: typeof context) => {
          const selected = selection;
          const id =
            selected?.sessionKey === next.props.sessionKey &&
            selected.agentId === next.props.agentId
              ? selected.incidentId
              : undefined;
          if (id !== currentId) {
            mounted?.dispose();
            container.replaceChildren();
            currentId = id;
            mounted = id ? mountIncident(container, next, id, true) : undefined;
          } else {
            mounted?.update(next);
          }
          if (!id) {
            container.textContent = "Open an incident from its inline card.";
          }
        };
        update(context);
        return {
          update,
          dispose() {
            mounted?.dispose();
          },
        };
      },
    });
    return () => {
      snapshots.clear();
      selection = undefined;
    };
  },
});

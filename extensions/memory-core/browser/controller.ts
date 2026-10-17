import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";

export type MemoryOverviewStatus =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; payload: DoctorMemoryStatusPayload }
  | { kind: "error"; message: string };

export function createMemoryOverviewController(
  context: ControlUiSettingsContext,
  changed: () => void,
  offlineMessage: () => string,
) {
  let snapshot = context.props;
  let status: MemoryOverviewStatus = { kind: "idle" };
  let probingEmbeddings = false;
  let request: object | undefined;
  let active = true;
  const scope = (value: ControlUiSettingsSnapshot) =>
    JSON.stringify([
      value.agentId,
      value.engine,
      value.connected,
      value.connectionEpoch,
      value.routeIntent,
    ]);
  const invalidate = () => {
    request = undefined;
    probingEmbeddings = false;
    status = { kind: "idle" };
  };
  const dispose = () => {
    active = false;
    invalidate();
  };
  context.signal.addEventListener("abort", dispose, { once: true });
  const read = () => ({ snapshot, status, probingEmbeddings });
  const load = async (force = false, probe = false) => {
    if (!active || context.signal.aborted) {
      return;
    }
    if (snapshot.engine.kind === "off") {
      invalidate();
      changed();
      return;
    }
    if (!snapshot.connected) {
      invalidate();
      status = { kind: "error", message: offlineMessage() };
      changed();
      return;
    }
    if (!snapshot.agentId) {
      invalidate();
      status = { kind: "idle" };
      changed();
      return;
    }
    if (request && !force) {
      return;
    }
    const pending = {};
    request = pending;
    probingEmbeddings = probe;
    if (!probe) {
      status = { kind: "loading" };
    }
    changed();
    try {
      const payload = await context.request<DoctorMemoryStatusPayload>("doctor.memory.status", {
        agentId: snapshot.agentId,
        ...(probe ? { probe: true } : {}),
      });
      if (!active || request !== pending || context.signal.aborted) {
        return;
      }
      status = { kind: "ready", payload };
    } catch (error) {
      if (!active || request !== pending || context.signal.aborted) {
        return;
      }
      status = { kind: "error", message: context.formatError(error) };
    } finally {
      if (active && request === pending && !context.signal.aborted) {
        probingEmbeddings = false;
        changed();
      }
    }
  };
  return {
    read,
    update(next: ControlUiSettingsSnapshot) {
      if (!active || context.signal.aborted) {
        return;
      }
      const changedScope = scope(snapshot) !== scope(next);
      snapshot = next;
      if (changedScope) {
        invalidate();
      }
      changed();
      if (changedScope) {
        void load();
      }
    },
    load,
    refresh() {
      if (!active || context.signal.aborted) {
        return;
      }
      if (snapshot.agentId) {
        void load(true);
      } else {
        context.refreshAgents();
      }
    },
    probe() {
      void load(true, true);
    },
    dispose() {
      dispose();
      context.signal.removeEventListener("abort", dispose);
    },
  };
}

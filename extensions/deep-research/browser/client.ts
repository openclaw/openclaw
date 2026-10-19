import type { ControlUiHost, ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
import type { ResearchList, ResearchView } from "../src/view-contract.js";

export type Scope = Parameters<ControlUiPanel["mount"]>[1]["props"];
export type Snapshot = {
  jobs: ResearchList["jobs"];
  job?: ResearchView;
  sessionId?: string;
  incarnation?: string;
  pending?: PendingStart;
  actionError?: string;
  selected?: string;
  loading: boolean;
  busy: boolean;
  offline: boolean;
  writable: boolean;
  error?: string;
};
export type PendingStart = { key: string; question: string; incarnation: string };

/** This cache belongs to one view lifetime, never the global session roster. */
export function createResearchClient(
  host: ControlUiHost,
  scope: Scope,
  signal: AbortSignal,
  selected: () => string | undefined,
  select: (id: string) => void,
  retainStarts = true,
) {
  let snapshot: Snapshot = {
    jobs: [],
    loading: true,
    busy: false,
    writable: host.connection.canWrite,
    offline: !host.connection.connected,
  };
  let generation = 0;
  let authorityEpoch = 0;
  let disposed = false;
  let trailing = false;
  let reading: Promise<void> | undefined;
  const listeners = new Set<(value: Snapshot) => void>();
  const storageKey = `deep-research.pending:${scope.agentId ?? ""}:${scope.sessionKey}`;
  let pending: PendingStart | undefined;
  let retainedPending: PendingStart | undefined;
  try {
    const saved: unknown = retainStarts
      ? JSON.parse(sessionStorage.getItem(storageKey) ?? "null")
      : null;
    if (
      saved &&
      typeof saved === "object" &&
      "key" in saved &&
      typeof saved.key === "string" &&
      "question" in saved &&
      typeof saved.question === "string" &&
      "incarnation" in saved &&
      typeof saved.incarnation === "string"
    ) {
      retainedPending = {
        key: saved.key,
        question: saved.question,
        incarnation: saved.incarnation,
      };
    }
  } catch {
    /* Storage may be disabled. */
  }
  const savePending = (value?: PendingStart) => {
    pending = value;
    retainedPending = undefined;
    if (!retainStarts) {
      return;
    }
    try {
      if (value) {
        sessionStorage.setItem(storageKey, JSON.stringify(value));
      } else {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      /* The mounted view still retains the retry key. */
    }
  };
  const current = (epoch: number) => !disposed && !signal.aborted && epoch === generation;
  const publish = (next: Partial<Snapshot>) => {
    if (disposed || signal.aborted) {
      return;
    }
    snapshot = { ...snapshot, ...next, pending, writable: host.connection.canWrite };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const request = <T>(action: string, params: Record<string, unknown> = {}) =>
    host.request<T>(`deep-research.view.v1.${action}`, { ...scope, ...params });
  const clear = (error: string, retainRetry = false) => {
    generation++;
    authorityEpoch++;
    if (retainRetry) {
      retainedPending = pending ?? retainedPending;
      pending = undefined;
    } else {
      savePending();
    }
    publish({
      jobs: [],
      job: undefined,
      selected: undefined,
      sessionId: undefined,
      incarnation: undefined,
      loading: false,
      busy: false,
      error,
      actionError: undefined,
    });
  };
  async function refresh() {
    if (disposed || signal.aborted) {
      return;
    }
    if (!host.connection.connected) {
      generation++;
      authorityEpoch++;
      publish({ offline: true, loading: false });
      return;
    }
    if (!host.connection.canRead) {
      clear("Access unavailable. Private research has been cleared.");
      return;
    }
    if (reading) {
      trailing = true;
      return reading;
    }
    const epoch = ++generation;
    publish({ offline: false, loading: true });
    reading = (async () => {
      try {
        const list = await request<ResearchList>("list");
        if (!current(epoch)) {
          return;
        }
        if (retainedPending) {
          savePending(
            retainedPending.incarnation === list.incarnation ? retainedPending : undefined,
          );
        }
        if (pending && pending.incarnation !== list.incarnation) {
          savePending();
        }
        const reset = snapshot.incarnation && snapshot.incarnation !== list.incarnation;
        if (reset) {
          authorityEpoch++;
          publish({ jobs: [], job: undefined, selected: undefined, actionError: undefined });
        }
        const id =
          list.jobs.find((job) => job.jobId === selected())?.jobId ??
          list.jobs.find((job) => ["queued", "running", "paused", "submitting"].includes(job.state))
            ?.jobId ??
          list.jobs[0]?.jobId;
        publish({
          jobs: list.jobs,
          sessionId: list.sessionId,
          incarnation: list.incarnation,
          selected: id,
          error: undefined,
          ...(!id || reset || snapshot.job?.jobId !== id ? { job: undefined } : {}),
        });
        if (id) {
          const reply = await request<{
            sessionId: string;
            incarnation: string;
            job: ResearchView;
          }>("read", {
            jobId: id,
          });
          if (!current(epoch)) {
            return;
          }
          if (reply.incarnation !== list.incarnation) {
            clear("Conversation changed. Refresh research.");
            return;
          }
          publish({ job: reply.job });
        }
      } catch (error) {
        if (current(epoch)) {
          if (!host.connection.connected) {
            publish({ offline: true });
          } else {
            clear(
              error instanceof Error ? error.message : "Research access unavailable.",
              !(
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "FORBIDDEN"
              ),
            );
          }
        }
      } finally {
        if (current(epoch)) {
          publish({ loading: false });
        }
      }
    })();
    await reading;
    reading = undefined;
    if (trailing) {
      trailing = false;
      void refresh();
    }
  }
  const mutate = async (action: "start" | "cancel" | "resume", question?: string) => {
    if (
      snapshot.busy ||
      !snapshot.incarnation ||
      snapshot.offline ||
      !host.connection.canWrite ||
      !host.connection.connected
    ) {
      return;
    }
    const jobId = snapshot.job?.jobId;
    if (action !== "start" && !jobId) {
      return;
    }
    const epoch = authorityEpoch;
    generation++;
    const incarnation = snapshot.incarnation;
    if (action === "start") {
      if (!retainStarts) {
        return;
      }
      try {
        if (!pending) {
          savePending({
            key: Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
              value.toString(16).padStart(2, "0"),
            ).join(""),
            question: question!.trim(),
            incarnation,
          });
        }
      } catch {
        publish({ actionError: "Could not create a request key. No work was started." });
        return;
      }
      // An uncertain acceptance must be retried with the exact original request.
      if (pending!.question !== question!.trim()) {
        publish({ error: "Resolve the pending start before changing the question." });
        return;
      }
    }
    publish({ busy: true, actionError: undefined });
    try {
      const reply = await request<{ sessionId: string; incarnation: string; job: ResearchView }>(
        action,
        action === "start"
          ? { incarnation, idempotencyKey: pending!.key, request: { question: pending!.question } }
          : { incarnation, jobId },
      );
      if (disposed || signal.aborted || !host.connection.connected || epoch !== authorityEpoch) {
        return;
      }
      if (reply.incarnation !== incarnation || snapshot.incarnation !== incarnation) {
        clear("Conversation changed. Refresh research.");
        return;
      }
      if (action === "start") {
        savePending();
      }
      // An acknowledgement supersedes reads started before it settled.
      generation++;
      select(reply.job.jobId);
      publish({ selected: reply.job.jobId, job: reply.job });
    } catch (error) {
      if (!disposed && !signal.aborted && epoch === authorityEpoch) {
        const rejected =
          error &&
          typeof error === "object" &&
          "details" in error &&
          error.details &&
          typeof error.details === "object" &&
          "code" in error.details &&
          error.details.code === "RESEARCH_START_REJECTED";
        if (rejected && action === "start") {
          savePending();
        }
        publish({
          actionError:
            action === "start" && !rejected
              ? "Start outcome uncertain. Retry the same question with the retained request key."
              : error instanceof Error
                ? error.message
                : "Research action failed.",
        });
      }
    } finally {
      if (!disposed && !signal.aborted) {
        publish({ busy: false });
        await refresh();
      }
    }
  };
  let connected = host.connection.connected;
  const stopHost = host.subscribe(() => {
    if (!host.connection.connected) {
      if (connected) {
        connected = false;
        void refresh();
      }
      return;
    }
    if (!host.connection.canRead) {
      clear("Access unavailable. Private research has been cleared.");
      return;
    }
    if (snapshot.writable !== host.connection.canWrite) {
      publish({});
    }
    if (connected !== host.connection.connected) {
      connected = host.connection.connected;
      void refresh();
    }
  });
  const stopEvent = host.onEvent("plugin.deep-research.changed", () => {
    void refresh();
  });
  // Reset/access changes do not require a research write; reauthorize on native session invalidations.
  const stopSessions = host.onEvent("sessions.changed", () => {
    void refresh();
  });
  return {
    read: () => snapshot,
    pending: () => pending,
    subscribe(listener: (value: Snapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    async choose(id: string) {
      generation++;
      select(id);
      publish({ selected: id, job: undefined });
      await refresh();
    },
    mutate,
    dispose() {
      disposed = true;
      generation++;
      listeners.clear();
      stopHost();
      stopEvent();
      stopSessions();
    },
  };
}

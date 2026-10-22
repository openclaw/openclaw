import { vi } from "vitest";

export function createQaLabCaptureMock() {
  const sessions: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  const readMeta = (event: Record<string, unknown>) => {
    try {
      return typeof event.metaJson === "string"
        ? (JSON.parse(event.metaJson) as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const countValues = (values: Array<string | undefined>) =>
    Object.entries(
      values.reduce<Record<string, number>>((acc, value) => {
        if (value) {
          acc[value] = (acc[value] ?? 0) + 1;
        }
        return acc;
      }, {}),
    ).map(([value, count]) => ({ value, count }));
  const store = {
    upsertSession: (session: Record<string, unknown>) => {
      sessions.push({ ...session });
    },
    recordEvent: (event: Record<string, unknown>) => {
      events.push({ ...event });
    },
    async listSessions(limit: number) {
      return sessions.slice(0, limit).map((session) =>
        Object.assign({}, session, {
          eventCount: events.filter((event) => event.sessionId === session.id).length,
        }),
      );
    },
    async getSessionEvents(sessionId: string, limit: number) {
      return events.filter((event) => event.sessionId === sessionId).slice(0, limit);
    },
    async summarizeSessionCoverage(sessionId: string) {
      const selected = events.filter((event) => event.sessionId === sessionId);
      const metas = selected.map(readMeta);
      return {
        sessionId,
        totalEvents: selected.length,
        unlabeledEventCount: metas.filter((meta) => !meta.provider && !meta.model).length,
        providers: countValues(metas.map((meta) => meta.provider as string | undefined)),
        apis: countValues(metas.map((meta) => meta.api as string | undefined)),
        models: countValues(metas.map((meta) => meta.model as string | undefined)),
        hosts: countValues(selected.map((event) => event.host as string | undefined)),
        localPeers: countValues(
          selected
            .map((event) => event.host as string | undefined)
            .filter((host) => host?.startsWith("127.0.0.1:")),
        ),
      };
    },
    async queryPreset(preset: string, sessionId?: string) {
      if (preset !== "double-sends") {
        return [];
      }
      const selected = events.filter((event) => !sessionId || event.sessionId === sessionId);
      return countValues(
        selected.map((event) => (typeof event.host === "string" ? event.host : undefined)),
      )
        .filter(({ count }) => count > 1)
        .map(({ value: host, count: duplicateCount }) => ({ host, duplicateCount }));
    },
    readBlob: async () => null,
    close: vi.fn(async () => {}),
    async deleteSessions(sessionIds: string[]) {
      const ids = new Set(sessionIds);
      for (let index = sessions.length - 1; index >= 0; index -= 1) {
        if (ids.has(String(sessions[index]?.id))) {
          sessions.splice(index, 1);
        }
      }
      return { deleted: sessionIds.length };
    },
    async purgeAll() {
      sessions.splice(0);
      events.splice(0);
      return { deletedSessions: 0, deletedEvents: 0 };
    },
  };

  const acquire = vi.fn(async () => ({ store, release: store.close }));
  return {
    acquire,
    store,
    reset() {
      sessions.splice(0);
      events.splice(0);
      acquire.mockClear();
      store.close.mockClear();
    },
  };
}

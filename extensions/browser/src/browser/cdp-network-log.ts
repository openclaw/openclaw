import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Browser } from "playwright-core";
import { MAX_NETWORK_REQUESTS, type BrowserNetworkRequest } from "./pw-session-contracts.js";

function resourceType(type: string | undefined): string {
  switch (type) {
    case "Document":
    case "Stylesheet":
    case "Image":
    case "Media":
    case "Font":
    case "Script":
    case "TextTrack":
    case "XHR":
    case "Fetch":
    case "EventSource":
    case "WebSocket":
    case "Manifest":
    case "Ping":
      return type.toLowerCase();
    case "CSPViolationReport":
      return "cspreport";
    default:
      return "other";
  }
}

type NetworkLog = {
  targetId: string;
  sessionId: string;
  nextId: number;
  records: Map<string, { key: string; record: BrowserNetworkRequest }>;
  pending: Map<string, BrowserNetworkRequest>;
};

/** Observe the existing CDP stream without subscribing to Playwright's retained Request objects. */
export function createCdpNetworkLog() {
  const targets = new Map<string, NetworkLog>();
  const sessions = new Map<string, { log: NetworkLog; parent?: string }>();
  const detach = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    sessions.delete(sessionId);
    if (session.log.sessionId === sessionId) {
      targets.delete(session.log.targetId);
    }
    for (const [id, child] of sessions) {
      if (child.parent === sessionId) {
        detach(id);
      }
    }
  };
  const setResponse = (record: BrowserNetworkRequest | undefined, response: unknown) => {
    const status = asOptionalRecord(response)?.status;
    if (record && typeof status === "number") {
      record.status = status;
      record.ok = status === 0 || (status >= 200 && status < 300);
    }
  };
  return {
    receive(message: Record<string, unknown>): void {
      const method = readStringField(message, "method");
      if (
        method !== "Target.attachedToTarget" &&
        method !== "Target.detachedFromTarget" &&
        method !== "Network.requestWillBeSent" &&
        method !== "Network.responseReceived" &&
        method !== "Network.loadingFailed" &&
        method !== "Network.loadingFinished"
      ) {
        return;
      }
      const params = asOptionalRecord(message.params);
      if (!params) {
        return;
      }
      const sessionId = readStringField(message, "sessionId");
      if (method === "Target.attachedToTarget") {
        const attachedId = readStringField(params, "sessionId");
        const info = asOptionalRecord(params.targetInfo);
        const targetId = readStringField(info, "targetId");
        if (!attachedId || !targetId) {
          return;
        }
        if (info?.type === "page" && !targets.has(targetId)) {
          const log: NetworkLog = {
            targetId,
            sessionId: attachedId,
            nextId: 0,
            records: new Map(),
            pending: new Map(),
          };
          targets.set(targetId, log);
          sessions.set(attachedId, { log });
        } else if ((info?.type === "iframe" || info?.type === "worker") && sessionId) {
          const log = sessions.get(sessionId)?.log;
          if (log) {
            sessions.set(attachedId, { log, parent: sessionId });
          }
        }
        // Auxiliary sessions must not duplicate events or replace the page's log.
        return;
      }
      if (method === "Target.detachedFromTarget") {
        const detachedId = readStringField(params, "sessionId");
        if (detachedId) {
          detach(detachedId);
        }
        return;
      }
      const log = sessionId ? sessions.get(sessionId)?.log : undefined;
      const requestId = readStringField(params, "requestId");
      if (!sessionId || !log || !requestId) {
        return;
      }
      // Chromium keeps request IDs across OOPIF and worker session transitions.
      const key = requestId;
      const previous = log.pending.get(key);
      if (method === "Network.requestWillBeSent") {
        const request = asOptionalRecord(params.request);
        const url = readStringField(request, "url");
        const requestMethod = readStringField(request, "method");
        if (!url || !requestMethod || url.startsWith("data:")) {
          return;
        }
        setResponse(previous, params.redirectResponse);
        const record: BrowserNetworkRequest = {
          id: `r${++log.nextId}`,
          timestamp: new Date().toISOString(),
          method: requestMethod,
          url: truncateUtf16Safe(url, 2_048),
          resourceType: resourceType(readStringField(params, "type")),
        };
        log.records.set(record.id, { key, record });
        log.pending.set(key, record);
        if (log.records.size > MAX_NETWORK_REQUESTS) {
          const oldest = log.records.entries().next().value;
          if (oldest) {
            log.records.delete(oldest[0]);
            if (log.pending.get(oldest[1].key) === oldest[1].record) {
              log.pending.delete(oldest[1].key);
            }
          }
        }
      } else if (method === "Network.responseReceived") {
        setResponse(previous, params.response);
      } else if (method === "Network.loadingFailed") {
        // Chromium aborts successful no-content navigations; Playwright reports completion.
        if (previous && previous.status !== 204) {
          const failure =
            readStringField(params, "errorText") || readStringField(params, "blockedReason");
          previous.failureText = failure ? truncateUtf16Safe(failure, 2_048) : undefined;
          previous.ok = false;
        }
        log.pending.delete(key);
      } else if (method === "Network.loadingFinished") {
        log.pending.delete(key);
      }
    },
    read(targetId: string, clear = false): BrowserNetworkRequest[] {
      const log = targets.get(targetId);
      const records = log ? [...log.records.values()].map(({ record }) => record) : [];
      if (clear) {
        log?.records.clear();
        log?.pending.clear();
      }
      return records;
    },
    clear(): void {
      sessions.clear();
      targets.clear();
    },
  };
}

export const cdpNetworkLogs = new WeakMap<Browser, ReturnType<typeof createCdpNetworkLog>>();

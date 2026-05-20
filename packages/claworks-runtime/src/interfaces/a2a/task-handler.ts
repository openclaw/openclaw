import type { IncomingMessage, ServerResponse } from "node:http";
import { checkA2aPeerRbac, resolveA2aPeer } from "../../claworks/a2a-peer-auth.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { badRequest, notFound, parsePath, readJsonBody, sendJson } from "../rest/http-utils.js";
import { buildA2aAgentCard } from "./agent-card.js";
import { A2aTaskStore } from "./task-store.js";
import type { A2aMessage, A2aTaskSendRequest } from "./types.js";

function readA2aPeerHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-claworks-peer"];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw[0]?.trim()) {
    return raw[0].trim();
  }
  return undefined;
}

function extractText(message: A2aMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export type A2aHandlerDeps = {
  runtime: ClaworksRuntime;
  store?: A2aTaskStore;
  baseUrl?: string;
};

export function createA2aHttpHandler(deps: A2aHandlerDeps | (() => ClaworksRuntime | null)) {
  const store = "store" in deps ? (deps.store ?? new A2aTaskStore()) : new A2aTaskStore();

  const resolveRuntime = (): ClaworksRuntime | null => {
    if (typeof deps === "function") {
      return deps();
    }
    return deps.runtime;
  };

  const resolveBaseUrl = (runtime: ClaworksRuntime): string | undefined => {
    if (typeof deps === "function") {
      return undefined;
    }
    return deps.baseUrl ?? runtime.robot.endpoint;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const runtime = resolveRuntime();
    if (!runtime) {
      sendJson(res, 503, { error: "ClaWorks runtime not ready", code: "NOT_READY" });
      return true;
    }

    const method = req.method ?? "GET";
    const parts = parsePath(req.url ?? "/");

    if (parts[0] !== "a2a") {
      return false;
    }

    try {
      if (method === "GET" && parts[1] === "tasks" && !parts[2]) {
        sendJson(res, 200, { tasks: store.list() });
        return true;
      }

      if (method === "GET" && parts[1] === "tasks" && parts[2]) {
        const task = store.get(parts[2]);
        if (!task) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, task);
        return true;
      }

      if (method === "POST" && parts[1] === "tasks" && parts[2] === "send") {
        const body = (await readJsonBody(req)) as A2aTaskSendRequest;
        if (!body.message?.parts?.length) {
          badRequest(res, "message.parts is required");
          return true;
        }

        const task = store.create(body);
        store.setStatus(task.id, "working");

        const headerPeer = readA2aPeerHeader(req);
        const meta = {
          ...(body.metadata ?? {}),
          ...(headerPeer ? { peer_id: headerPeer } : {}),
        };
        void processA2aTask(runtime, store, task.id, { ...body, metadata: meta }).catch((err) => {
          store.update(task.id, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        });

        sendJson(res, 202, store.get(task.id));
        return true;
      }

      if (method === "GET" && parts[1] === "agent-card") {
        sendJson(res, 200, buildA2aAgentCard(runtime, resolveBaseUrl(runtime)));
        return true;
      }

      notFound(res);
      return true;
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
        code: "INTERNAL_ERROR",
      });
      return true;
    }
  };
}

async function processA2aTask(
  runtime: ClaworksRuntime,
  store: A2aTaskStore,
  taskId: string,
  req: A2aTaskSendRequest,
): Promise<void> {
  const meta = req.metadata ?? {};
  const text = extractText(req.message);
  const peers = runtime.config.a2a?.peers ?? [];
  const peerResolved = resolveA2aPeer(meta, peers);

  if ("error" in peerResolved) {
    store.update(taskId, {
      status: "failed",
      error: peerResolved.error,
    });
    return;
  }

  if (typeof meta.playbook_id === "string" && meta.playbook_id) {
    const rbac = checkA2aPeerRbac(
      runtime,
      peerResolved,
      "a2a.delegate",
      `playbook:${meta.playbook_id}`,
    );
    if (!rbac.allowed) {
      store.update(taskId, { status: "failed", error: rbac.reason });
      await runtime.kernel.publish("rbac.denied", "a2a", {
        action: "a2a.delegate",
        resource: `playbook:${meta.playbook_id}`,
        subject_type: "peer",
        subject_id: peerResolved.subjectId,
        reason: rbac.reason,
      });
      return;
    }
    const input =
      meta.input && typeof meta.input === "object" && !Array.isArray(meta.input)
        ? (meta.input as Record<string, unknown>)
        : { message: text, ...meta };
    const run = await runtime.playbookEngine.trigger(meta.playbook_id, input);
    store.update(taskId, {
      status: run.status === "failed" ? "failed" : "completed",
      result: { run_id: run.id, playbook_id: run.playbookId, status: run.status },
      error: run.error,
    });
    return;
  }

  const eventType =
    typeof meta.event_type === "string" && meta.event_type
      ? meta.event_type
      : "a2a.message.received";

  const payload =
    meta.payload && typeof meta.payload === "object" && !Array.isArray(meta.payload)
      ? { ...(meta.payload as Record<string, unknown>), message: text }
      : { message: text, ...meta };

  const source =
    typeof meta.source === "string" && meta.source ? meta.source : `a2a://${peerResolved.peerId}`;

  const rbac = checkA2aPeerRbac(runtime, peerResolved, "event.publish", eventType);
  if (!rbac.allowed) {
    store.update(taskId, { status: "failed", error: rbac.reason });
    await runtime.kernel.publish("rbac.denied", "a2a", {
      action: "event.publish",
      resource: eventType,
      subject_type: "peer",
      subject_id: peerResolved.subjectId,
      reason: rbac.reason,
    });
    return;
  }

  const matches = await runtime.kernel.publish(
    eventType,
    source,
    payload,
    typeof meta.correlation_id === "string" ? meta.correlation_id : undefined,
  );

  store.update(taskId, {
    status: "completed",
    result: {
      event_type: eventType,
      matched_playbooks: matches.map((m) => m.playbookId),
    },
  });
}

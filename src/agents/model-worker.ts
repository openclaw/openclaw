/**
 * Model Worker — Isolated fetch() executor for model API calls.
 *
 * Runs in a worker_threads context. Receives fetch requests from the main
 * thread via postMessage, executes them, and sends base64-encoded response
 * bodies back through MessagePort.
 *
 * This isolates LLM API HTTP calls from the main event loop, preventing
 * long-running streaming responses from starving gateway I/O processing.
 */

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("model-worker must run as a worker_thread");
}

type WorkerRequest = {
  id: number;
  url: string;
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: string;
};

parentPort.on("message", async (msg: WorkerRequest) => {
  try {
    const headers = new Headers(msg.init.headers ?? {});
    const body = msg.init.body ?? undefined;

    const response = await fetch(msg.url, {
      method: msg.init.method ?? "GET",
      headers,
      body,
    });

    // Read full response body
    const responseBuffer = Buffer.from(await response.arrayBuffer());
    const bodyBase64 = responseBuffer.toString("base64");

    // Serialize headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const workerResponse: WorkerResponse = {
      id: msg.id,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      bodyBase64,
    };

    parentPort!.postMessage(workerResponse);
  } catch (err) {
    const workerResponse: WorkerResponse = {
      id: msg.id,
      ok: false,
      status: 0,
      statusText: "Worker Error",
      headers: {},
      bodyBase64: "",
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort!.postMessage(workerResponse);
  }
});

// Signal readiness
parentPort.postMessage({ type: "ready" });

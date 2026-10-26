import type { CriticalPathCapture } from "./control-ui-critical-path.ts";

type InitiatorStack = {
  callFrames: Array<{ url: string; lineNumber: number; columnNumber: number }>;
  parent?: InitiatorStack;
};

/** CDP request metadata only: never retain headers, cookies, or request bodies. */
export type CriticalPathHttpRequest = {
  requestId: string;
  url: string;
  type?: string;
  timestamp: number;
  wallTime: number;
  initiator: {
    type: string;
    url?: string;
    lineNumber?: number;
    requestId?: string;
    stack?: InitiatorStack;
  };
};

type Row = {
  id: string;
  name: string;
  kind: string;
  start: number;
  end?: number;
  requestBytes?: number;
  responseBytes?: number;
  decodedBytes?: number;
  transferBytes?: number;
  request?: CriticalPathHttpRequest;
  stack?: string;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });

const milliseconds = (value: number | undefined) => (value === undefined ? "—" : value.toFixed(1));
const bytes = (value: number | undefined) =>
  value === undefined ? "—" : value.toLocaleString("en-US");

function firstInitiatorFrame(stack: InitiatorStack | undefined): string | undefined {
  for (let current = stack; current; current = current.parent) {
    const frame = current.callFrames.find((entry) => entry.url);
    if (frame) {
      return frame.url;
    }
  }
  return undefined;
}

/** Render after sampling; no browser calls, external assets, or payload contents. */
export function renderCriticalPathWaterfall(
  capture: CriticalPathCapture,
  requests: CriticalPathHttpRequest[],
): string {
  const startOf = (request: CriticalPathHttpRequest) =>
    request.wallTime * 1000 - capture.timeOrigin;
  const unmatched = new Set(requests.filter((request) => /^https?:/.test(request.url)));
  const rows: Row[] = capture.resources.map((resource, index) => {
    // CDP and Resource Timing have no shared request ID. Match repeated URLs by nearest start.
    const request = [...unmatched]
      .filter((entry) => entry.url === resource.name)
      .toSorted(
        (left, right) =>
          Math.abs(startOf(left) - resource.startTime) -
          Math.abs(startOf(right) - resource.startTime),
      )[0];
    if (request) {
      unmatched.delete(request);
    }
    return {
      id: `http-${index}`,
      name: resource.name,
      kind: `HTTP ${resource.initiatorType}`,
      start: resource.startTime - capture.startedMs,
      end: resource.startTime + resource.duration - capture.startedMs,
      responseBytes: resource.encodedBodySize,
      decodedBytes: resource.decodedBodySize,
      transferBytes: resource.transferSize,
      request,
    };
  });
  // Retain observed requests lacking a completed Resource Timing entry (for example, failures).
  const intervalStart = capture.intentStartedMs ?? capture.startedMs;
  for (const request of unmatched) {
    const started = startOf(request);
    if (started >= intervalStart && started <= capture.capturedMs) {
      rows.push({
        id: `http-${rows.length}`,
        name: request.url,
        kind: `HTTP ${request.type ?? "request"} (no resource timing)`,
        start: started - capture.startedMs,
        request,
      });
    }
  }
  rows.push(
    ...capture.rpcs.map((rpc, index) => ({
      id: `rpc-${index}`,
      name: rpc.method,
      kind: rpc.abandoned ? "RPC abandoned" : "RPC",
      start: rpc.requestMs - capture.startedMs,
      end: rpc.responseMs - capture.startedMs,
      requestBytes: rpc.requestBytes,
      responseBytes: rpc.responseBytes,
      stack: rpc.stack,
    })),
  );
  rows.sort((left, right) => left.start - right.start);
  const ready = capture.readyMs - capture.startedMs;
  const lower = Math.min(0, ...rows.map((row) => row.start));
  const upper = Math.max(ready, capture.capturedMs - capture.startedMs);
  const position = (value: number) => (((value - lower) / (upper - lower || 1)) * 100).toFixed(3);
  const initiator = (row: Row) => {
    if (row.stack) {
      return `<details><summary>Observed caller stack</summary><pre>${escapeHtml(row.stack)}</pre></details>`;
    }
    if (!row.request) {
      return "Not recorded";
    }
    const source = row.request.initiator;
    const url = source.url ?? firstInitiatorFrame(source.stack);
    const parent = source.requestId
      ? rows.find((candidate) => candidate.request?.requestId === source.requestId)
      : rows.find((candidate) => candidate.name === url);
    const label = escapeHtml(url ?? source.requestId ?? source.type);
    return `<details><summary>${escapeHtml(source.type)}: ${parent ? `<a href="#${parent.id}">${label}</a>` : label}</summary><pre>${escapeHtml(JSON.stringify(source, null, 2))}</pre></details>`;
  };
  const tableRows = rows
    .map((row) => {
      const phase = row.start < 0 ? "carry-in" : row.start >= ready ? "post-ready" : "before-ready";
      const crossesReady = row.start < ready && row.end !== undefined && row.end > ready;
      return `<tr id="${row.id}">
<th scope="row"><span class="kind">${escapeHtml(row.kind)}</span><code>${escapeHtml(row.name)}</code>${row.request ? `<small>requestId ${escapeHtml(row.request.requestId)}</small>` : ""}<small>${phase}${crossesReady ? ", spans ready" : ""}</small></th>
<td>${milliseconds(row.start)}</td><td>${milliseconds(row.end)}</td><td>${milliseconds(row.end === undefined ? undefined : row.end - row.start)}</td>
<td>${bytes(row.requestBytes)}</td><td>${bytes(row.responseBytes)}</td><td>${bytes(row.decodedBytes)}</td><td>${bytes(row.transferBytes)}</td>
<td>${initiator(row)}</td><td class="chart"><div class="timeline"><i class="activation" style="left:${position(0)}%"></i><i class="ready" style="left:${position(ready)}%"></i><b class="${row.kind.startsWith("RPC") ? "rpc" : "http"}" style="left:${position(row.start)}%;width:${row.end === undefined ? "0" : Number(position(row.end)) - Number(position(row.start))}%" title="${escapeHtml(row.name)}"></b></div></td></tr>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(capture.name)} readiness waterfall</title>
<style>
body{font:14px system-ui,sans-serif;color:#e4e7ec;background:#10151e;margin:24px}h1{font-size:24px}p{max-width:1100px;line-height:1.5}a{color:#9bc6ff}code,pre{font:12px ui-monospace,monospace}code{display:block;overflow-wrap:anywhere}small,.kind{display:block;color:#a9b4c5;margin:4px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:480px}summary{cursor:pointer;overflow-wrap:anywhere}.scroll{overflow:auto}table{border-collapse:collapse;min-width:1700px;width:100%}th,td{border-bottom:1px solid #354053;padding:10px 8px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:#1c2533}tbody th{width:310px;font-weight:400}td{font-variant-numeric:tabular-nums}td:nth-child(9){width:220px}.chart{min-width:420px}.timeline{position:relative;height:30px}.timeline i{position:absolute;top:-10px;height:50px;border-left:1px dashed #8c98aa}.timeline i.ready{border-color:#ffc86b}.timeline b{position:absolute;top:7px;height:15px;min-width:2px;background:#6ba9ef}.timeline b.rpc{background:#ad92ed}tr:target{background:#24344b}
</style><h1>${escapeHtml(capture.name)} readiness waterfall</h1>
<p>Activation = 0 ms; ready = <strong>${milliseconds(ready)} ms</strong> (gold line). Chart: ${milliseconds(lower)} to ${milliseconds(upper)} ms. ${rows.length} HTTP/RPC rows. Negative starts are carry-in; collection continues after readiness to show secondary work.</p>
<p>HTTP response bytes are encoded body, decoded body, and transfer (including headers) from Resource Timing; zero transfer can indicate cache reuse. HTTP request sizes are not recorded. RPC request/response bytes are UTF-8 JSON frame lengths, excluding WebSocket framing, headers, and compression. RPC durations include synthetic replay scheduling/network shaping; they are not measured Gateway service time.</p>
<p>Initiators and caller stacks are observed. HTTP timing entries are associated with CDP records by URL and nearest start; links identify a recorded initiating request or script, not a causal completion dependency. No wait edges are inferred. A missing end/size means no completed Resource Timing entry was captured. The per-route requests JSON retains the document's earlier initiators too. No RPC parameters, message contents, or HTTP headers are included here.</p>
<div class="scroll"><table><thead><tr><th>Resource / method</th><th>Start ms</th><th>End ms</th><th>Duration ms</th><th>Request B</th><th>Encoded / RPC response B</th><th>Decoded B</th><th>Transfer B</th><th>Observed initiator</th><th>Timeline · blue HTTP · purple RPC</th></tr></thead><tbody>${tableRows}</tbody></table></div></html>`;
}

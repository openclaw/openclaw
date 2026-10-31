import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";

const phaseNames = new Set(
  [
    "widget-geometry",
    "presentation-loading",
    "presentation-ready",
    "ui/notifications/sandbox-proxy-ready",
    "ui/notifications/sandbox-resource-loaded",
    "openclaw:widget-size",
    "warm-reload-proof:dashboard-content-ready",
  ].map((name) => `board-phase:${name}`),
);

function safeTraceArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number" || typeof field === "boolean") {
      result[key] = field;
    } else if (["data", "beginData", "endData"].includes(key)) {
      result[key] = safeTraceArguments(field);
    } else if (key === "frames" && Array.isArray(field)) {
      result[key] = field.map(safeTraceArguments);
    } else if (
      Array.isArray(field) &&
      field.length <= 64 &&
      field.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      result[key] = field;
    } else if (
      [
        "frame",
        "page",
        "parent",
        "frameId",
        "mainFrameId",
        "sessionId",
        "navigationId",
        "scriptId",
        "requestId",
      ].includes(key) &&
      typeof field === "string" &&
      /^[a-f0-9.:-]+$/iu.test(field)
    ) {
      result[key] = field;
    } else if (
      ["url", "scriptName", "documentLoaderURL", "documentURL"].includes(key) &&
      typeof field === "string"
    ) {
      const url = URL.parse(field);
      if (url) {
        const origin = `https://fixture-${url.port || "default"}.invalid`;
        const path =
          url.pathname.startsWith("/assets/") || url.pathname === "/mcp-app-sandbox"
            ? url.pathname
            : url.pathname.startsWith("/__openclaw__/board/")
              ? "/__openclaw__/board/widget"
              : "/document";
        result[key] = `${origin}${path}`;
      }
    }
  }
  return result;
}

/** Attribution only: Chromium traces include sandbox renderer processes. */
export async function startBoardSandboxTrace(page: Page, output: string) {
  // A page session supplies its frame tree; a browser session emits empty metadata.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Tracing.start", {
    categories:
      "devtools.timeline,loading,blink.user_timing,toplevel,v8,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame",
    transferMode: "ReturnAsStream",
  });
  return async () => {
    try {
      const completed = new Promise<string>((resolve, reject) => {
        cdp.once("Tracing.tracingComplete", ({ stream }) => {
          if (stream) {
            resolve(stream);
          } else {
            reject(new Error("Board attribution trace has no stream"));
          }
        });
      });
      await cdp.send("Tracing.end");
      const handle = await completed;
      const chunks: Buffer[] = [];
      try {
        for (;;) {
          const chunk = await cdp.send("IO.read", { handle });
          chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
          if (chunk.eof) {
            break;
          }
        }
      } finally {
        await cdp.send("IO.close", { handle });
      }
      const trace: {
        traceEvents: Array<{
          cat?: string;
          name: string;
          ph: string;
          ts: number;
          dur?: number;
          pid: number;
          tid: number;
          id?: string | number;
          id2?: { local?: string | number; global?: string | number };
          bind_id?: string | number;
          args?: unknown;
        }>;
      } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const ids = new Map<string | number, number>();
      const identity = (value: string | number | undefined) => {
        if (value === undefined) {
          return undefined;
        }
        if (!ids.has(value)) {
          ids.set(value, ids.size + 1);
        }
        return ids.get(value);
      };
      const traceEvents = trace.traceEvents
        .filter(
          (event) =>
            !event.cat?.includes("blink.user_timing") ||
            phaseNames.has(event.name) ||
            event.name === "navigationStart",
        )
        .map(({ cat, name, ph, ts, dur, pid, tid, args, id, id2, bind_id }) => {
          const safe = safeTraceArguments(args);
          const label = args && typeof args === "object" ? Reflect.get(args, "name") : undefined;
          if (
            ph === "M" &&
            ["thread_name", "process_name"].includes(name) &&
            typeof label === "string" &&
            /^(?:CrRendererMain|CrBrowserMain|CrGpuMain|Renderer|Browser|HeadlessBrowser|Gpu|GPU Process|Compositor|VizCompositorThread|Chrome_ChildIOThread|Chrome_IOThread|ThreadPoolForegroundWorker|ThreadPoolBackgroundWorker)$/u.test(
              label,
            )
          ) {
            safe.name = label;
          }
          return {
            cat,
            name,
            ph,
            ts,
            dur,
            pid,
            tid,
            id: identity(id),
            id2: id2 ? { local: identity(id2.local), global: identity(id2.global) } : undefined,
            bind_id: identity(bind_id),
            args: safe,
          };
        });
      await writeFile(output, JSON.stringify({ traceEvents }));
    } finally {
      await cdp.detach();
    }
  };
}

/** Serialized before navigation; records phase names and geometry, never content. */
export function installBoardSandboxPhaseProbe() {
  const phases: Array<{ phase: string; atMs: number; height?: number; width?: number }> = [];
  const record = (phase: string, width?: number, height?: number) => {
    if (phases.length < 100) {
      phases.push({ phase, atMs: performance.now(), width, height });
      performance.mark(`board-phase:${phase}`);
    }
  };
  const sizes = new WeakMap<Element, string>();
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const key = `${width}/${height}`;
      if (sizes.get(entry.target) !== key) {
        sizes.set(entry.target, key);
        record("widget-geometry", width, height);
      }
    }
  });
  new MutationObserver((records) => {
    for (const mutation of records) {
      if (mutation.type === "attributes" && mutation.target instanceof Element) {
        const board = mutation.target;
        record(
          board.hasAttribute("data-initial-loading")
            ? "presentation-loading"
            : "presentation-ready",
        );
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          for (const cell of [node, ...node.querySelectorAll(".board-widget")]) {
            if (cell.matches(".board-widget")) {
              resize.observe(cell);
            }
          }
        }
      }
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-initial-loading"],
  });
  window.addEventListener("message", (event) => {
    if (
      ![...document.querySelectorAll<HTMLIFrameElement>(".board-widget__frame")].some(
        (frame) => frame.contentWindow === event.source,
      )
    ) {
      return;
    }
    const phase = event.data?.method ?? event.data?.type;
    if (
      [
        "ui/notifications/sandbox-proxy-ready",
        "ui/notifications/sandbox-resource-loaded",
        "openclaw:widget-size",
        "warm-reload-proof:dashboard-content-ready",
      ].includes(phase)
    ) {
      record(phase);
    }
  });
  Reflect.set(window, "__readBoardSandboxPhases", () => phases);
}

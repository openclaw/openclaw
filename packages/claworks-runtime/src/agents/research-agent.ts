import type { ClaworksRuntime } from "../claworks/runtime-types.js";

export type ResearchFinding = {
  source: string;
  content: string;
  relevance: number;
  url?: string;
};

export type ResearchResult = {
  task_id: string;
  query: string;
  findings: ResearchFinding[];
  synthesis: string;
  confidence: number;
  duration_ms: number;
};

export type ResearchSource = "kb" | "web" | "events";

export interface ResearchAgent {
  research(opts: {
    id?: string;
    query: string;
    sources?: ResearchSource[];
    depth?: "quick" | "thorough";
    save_to_kb?: boolean;
  }): Promise<ResearchResult>;
  monitor(topic: string, intervalHours?: number): Promise<string>;
  stopMonitor(monitorId: string): void;
  getResult(taskId: string): ResearchResult | undefined;
}

export function createResearchAgent(runtime: ClaworksRuntime): ResearchAgent {
  const results = new Map<string, ResearchResult>();
  const monitors = new Map<string, ReturnType<typeof setInterval>>();

  async function doResearch(
    id: string,
    query: string,
    sources: ResearchSource[],
    depth: "quick" | "thorough",
    saveToKb: boolean,
  ): Promise<ResearchResult> {
    const startTime = Date.now();
    const findings: ResearchFinding[] = [];

    const tasks: Promise<void>[] = [];

    if (sources.includes("kb")) {
      tasks.push(
        runtime.kb
          .search(query, { limit: depth === "thorough" ? 10 : 5 })
          .then((items) => {
            for (const r of items) {
              findings.push({
                source: "kb",
                content: String(r.text ?? r.content ?? ""),
                relevance: Number(r.score ?? 0.5),
              });
            }
          })
          .catch(() => {}),
      );
    }

    if (sources.includes("web")) {
      const scanner = (runtime as Record<string, unknown>).environmentScanner as
        | {
            webSearch?: (
              q: string,
              n: number,
            ) => Promise<Array<{ title: string; snippet: string; url: string }>>;
          }
        | undefined;
      if (scanner?.webSearch) {
        tasks.push(
          scanner
            .webSearch(query, depth === "thorough" ? 8 : 3)
            .then((webResults) => {
              for (const r of webResults) {
                findings.push({
                  source: "web",
                  content: `${r.title}\n${r.snippet}`,
                  relevance: 0.6,
                  url: r.url,
                });
              }
            })
            .catch(() => {}),
        );
      }
    }

    if (sources.includes("events")) {
      tasks.push(
        Promise.resolve()
          .then(() => {
            const kernel = runtime.kernel as unknown as {
              getRecentEvents?: (n: number) => Array<{ type: string; payload?: unknown }>;
            };
            const events = kernel.getRecentEvents?.(50) ?? [];
            const queryPrefix = query.toLowerCase().slice(0, 15);
            for (const e of events
              .filter((ev) =>
                JSON.stringify(ev.payload ?? "")
                  .toLowerCase()
                  .includes(queryPrefix),
              )
              .slice(0, 5)) {
              findings.push({
                source: `event:${e.type}`,
                content: JSON.stringify(e.payload ?? ""),
                relevance: 0.7,
              });
            }
          })
          .catch(() => {}),
      );
    }

    await Promise.allSettled(tasks);
    findings.sort((a, b) => b.relevance - a.relevance);

    let synthesis = `关于「${query}」共找到 ${findings.length} 条相关信息。`;
    if (findings.length > 0) {
      const llm = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
      if (llm) {
        try {
          const prompt =
            `基于以下信息回答：${query}\n\n` +
            findings
              .slice(0, 5)
              .map((f) => `[${f.source}] ${f.content.slice(0, 300)}`)
              .join("\n\n");
          const res = await llm({ prompt });
          if (res.text) {
            synthesis = res.text;
          }
        } catch {
          // 降级到摘要
        }
      }
    }

    const confidence = findings.length > 3 ? 0.8 : findings.length > 0 ? 0.5 : 0.2;

    const result: ResearchResult = {
      task_id: id,
      query,
      findings,
      synthesis,
      confidence,
      duration_ms: Date.now() - startTime,
    };

    if (saveToKb && findings.length > 0 && runtime.kb.add) {
      await runtime.kb
        .add({
          id: `research:${id}`,
          content: `研究：${query}\n结论：${synthesis}`,
          source: "research_agent",
        })
        .catch(() => {});
    }

    return result;
  }

  function publishMonitorUpdate(monitorId: string, topic: string, result: ResearchResult): void {
    void runtime.kernel
      .publish("research.monitor_update", "research-agent", {
        monitor_id: monitorId,
        topic,
        ...result,
      })
      .catch(() => {});
  }

  return {
    async research({ id, query, sources = ["kb", "web"], depth = "quick", save_to_kb = false }) {
      const taskId = id ?? `rq-${Date.now()}`;
      const result = await doResearch(taskId, query, sources, depth, save_to_kb);
      results.set(taskId, result);
      return result;
    },

    async monitor(topic, intervalHours = 6) {
      const mId = `monitor-${Date.now()}`;
      void doResearch(mId, topic, ["kb", "web"], "quick", true)
        .then((r) => {
          results.set(mId, r);
          publishMonitorUpdate(mId, topic, r);
        })
        .catch(() => {});

      const timer = setInterval(() => {
        const tickId = `${mId}-${Date.now()}`;
        void doResearch(tickId, topic, ["kb", "web"], "quick", true)
          .then((r) => publishMonitorUpdate(mId, topic, r))
          .catch(() => {});
      }, intervalHours * 3_600_000);

      monitors.set(mId, timer);
      return mId;
    },

    stopMonitor(mId) {
      const t = monitors.get(mId);
      if (t) {
        clearInterval(t);
        monitors.delete(mId);
      }
    },

    getResult: (id) => results.get(id),
  };
}

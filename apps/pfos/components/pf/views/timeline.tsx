"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { TimelineEvent, TimelineEventType } from "../core/types";
import type { AuditEvent } from "../core/saas/audit";
import type { Workspace } from "../core/saas/types";

function fmt(ts: number) {
  return new Date(ts).toLocaleString();
}

const TYPES: TimelineEventType[] = ["system", "agent", "workflow", "cli", "alert", "security"];

export function TimelineView({
  events,
  audit,
  workspace,
}: {
  events: TimelineEvent[];
  audit: AuditEvent[];
  workspace: Workspace;
}) {
  const [filter, setFilter] = useState<TimelineEventType | "all">("all");

  const filtered = useMemo(() => {
    if (filter === "all") return events;
    return events.filter((e) => e.type === filter);
  }, [events, filter]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
      <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
        <CardHeader className="flex flex-row items-center justify-between border-b border-white/10 py-4">
          <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Fang Timeline</div>
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as TimelineEventType | "all")}
              className="h-10 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm text-slate-100 outline-none focus:border-yellow-300/30"
            >
              <option value="all">All</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <Badge variant="secondary" className="rounded-full border border-white/10 bg-slate-950/35">
              {filtered.length} events
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <div className="space-y-3">
            {filtered.map((e) => (
              <div key={e.id} className="rounded-3xl border border-white/10 bg-slate-950/25 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-extrabold tracking-[0.14em] uppercase">{e.title}</div>
                    <div className="mt-1 text-xs text-slate-200/60">{fmt(e.ts)}</div>
                  </div>
                  <Badge className="rounded-full border border-yellow-300/20 bg-yellow-300/10 text-yellow-100">
                    {e.type.toUpperCase()}
                  </Badge>
                </div>
                {e.detail ? <div className="mt-3 text-sm text-slate-200/75">{e.detail}</div> : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
        <CardHeader className="flex flex-row items-center justify-between border-b border-white/10 py-4">
          <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Audit Trail</div>
          <Badge className="rounded-full border border-emerald-300/20 bg-emerald-300/10 text-emerald-100">
            Workspace: {workspace.name}
          </Badge>
        </CardHeader>
        <CardContent className="p-4">
          <div className="text-sm text-slate-200/70">Immutable log (append-only). In SaaS this would be server-side.</div>
          <div className="mt-3 space-y-3">
            {audit.slice(0, 30).map((a) => (
              <div key={a.id} className="rounded-3xl border border-white/10 bg-slate-950/25 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-extrabold tracking-[0.14em] uppercase">{a.action}</div>
                    <div className="mt-1 text-xs text-slate-200/60">
                      {fmt(a.ts)} {a.actorName}
                    </div>
                  </div>
                  <Badge variant="secondary" className="rounded-full border border-white/10 bg-slate-950/35">
                    {a.workspaceId}
                  </Badge>
                </div>
                {a.detail ? <div className="mt-3 text-sm text-slate-200/75">{a.detail}</div> : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

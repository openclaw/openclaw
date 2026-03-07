"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { RuntimeMode, Workflow, TimelineEvent } from "../core/types";

export function OperatorBriefView({
  runtimeMode,
  events,
  workflows,
  onEmitBriefEvent,
}: {
  runtimeMode: RuntimeMode;
  events: TimelineEvent[];
  workflows: Workflow[];
  onEmitBriefEvent: (title: string, detail?: string) => void;
}) {
  return (
    <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
      <CardHeader className="border-b border-white/10 py-4">
        <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Operator Brief</div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 text-sm text-slate-200/70">
        <div>Runtime Mode: {runtimeMode}</div>
        <div>Total Workflows: {workflows.length}</div>
        <div>Recent Events: {events.length}</div>
        <button
          className="rounded-2xl border border-yellow-300/30 bg-yellow-300/10 px-3 py-2"
          onClick={() => onEmitBriefEvent("Operator Brief Generated", "Daily status snapshot created")}
        >
          Generate Brief
        </button>
      </CardContent>
    </Card>
  );
}

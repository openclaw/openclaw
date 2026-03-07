"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function TaskPipelineView() {
  const steps = ["Collect Data", "Analyze Signals", "Generate Report", "Send Output"];

  return (
    <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
      <CardHeader className="border-b border-white/10 py-4">
        <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Task Pipeline</div>
      </CardHeader>
      <CardContent className="space-y-3 p-4">
        {steps.map((s) => (
          <div key={s} className="rounded-2xl border border-white/10 bg-slate-950/25 p-3">
            {s}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

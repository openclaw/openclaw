"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function DataVisionView() {
  return (
    <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
      <CardHeader className="border-b border-white/10 py-4">
        <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Data Vision</div>
      </CardHeader>
      <CardContent className="p-4 text-sm text-slate-200/70">
        Visualization modules will render analytics dashboards here.
      </CardContent>
    </Card>
  );
}

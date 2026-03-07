"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { RuntimeMode } from "../core/types";

export function MissionControlView({
  uptime,
  agents,
  globalLogs,
  runtimeMode,
}: {
  uptime: string;
  agents: { name: string; desc: string; icon: string; status: string }[];
  globalLogs: string[];
  runtimeMode: RuntimeMode;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
      <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
        <CardHeader className="flex items-center justify-between border-b border-white/10 py-4">
          <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Mission Control</div>
          <Badge className="rounded-full border border-emerald-300/20 bg-emerald-300/10 text-emerald-100">
            {runtimeMode.toUpperCase()}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <div className="text-sm text-slate-200/70">{uptime}</div>
          <div className="grid gap-3 md:grid-cols-2">
            {agents.map((a) => (
              <div key={a.name} className="rounded-3xl border border-white/10 bg-slate-950/25 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span>{a.icon}</span>
                    <span className="font-semibold">{a.name}</span>
                  </div>
                  <Badge className="rounded-full border border-emerald-300/20 bg-emerald-300/10 text-emerald-100">
                    {a.status}
                  </Badge>
                </div>
                <div className="mt-2 text-sm text-slate-200/70">{a.desc}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
        <CardHeader className="border-b border-white/10 py-4">
          <div className="text-xs font-extrabold tracking-[0.20em] uppercase">System Logs</div>
        </CardHeader>
        <CardContent className="p-4">
          <pre className="rounded-2xl border border-white/10 bg-slate-950/40 p-3 font-mono text-xs">
            {globalLogs.join("\n")}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

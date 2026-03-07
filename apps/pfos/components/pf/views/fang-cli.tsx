"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { RuntimeMode, Workflow, TimelineEventType } from "../core/types";

export function FangCliView({
  runtimeMode,
  confirmDangerousActions,
  workflows,
  onMode,
  onRunWorkflow,
  onExportWorkflows,
  onLog,
  onEvent,
}: {
  runtimeMode: RuntimeMode;
  confirmDangerousActions: boolean;
  workflows: Workflow[];
  onMode: (m: RuntimeMode) => void;
  onRunWorkflow: (id: string) => void;
  onExportWorkflows: () => void;
  onLog: (line: string, level?: "low" | "med" | "high") => void;
  onEvent: (t: TimelineEventType, title: string, detail?: string) => void;
}) {
  const [cmd, setCmd] = useState("");

  const run = () => {
    const parts = cmd.trim().split(" ").filter(Boolean);
    if (!parts.length) return;

    if (parts[0] === "mode" && parts[1]) {
      onMode(parts[1] as RuntimeMode);
      onEvent("cli", "Mode changed", parts[1]);
    } else if (parts[0] === "run") {
      const wfName = parts.slice(1).join(" ");
      const wf = workflows.find((w) => w.name === wfName);
      if (wf) onRunWorkflow(wf.id);
    } else if (parts[0] === "export") {
      onExportWorkflows();
    }

    onLog(`[CLI] ${cmd} | mode=${runtimeMode} | guardrails=${confirmDangerousActions ? "on" : "off"}`, "med");
    setCmd("");
  };

  return (
    <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
      <CardHeader className="border-b border-white/10 py-4">
        <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Fang CLI</div>
      </CardHeader>
      <CardContent className="p-4">
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="type command..."
          className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
        />
        <button onClick={run} className="mt-3 w-full rounded-2xl border border-yellow-400/30 bg-yellow-400/10 py-2">
          Execute
        </button>
      </CardContent>
    </Card>
  );
}

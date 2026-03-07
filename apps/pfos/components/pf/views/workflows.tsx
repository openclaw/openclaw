"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RuntimeMode, Workflow, WorkflowStep, WorkflowOutput } from "../core/types";
import { validateWorkflow, readinessScore } from "../core/validators";
import type { WorkflowRun } from "../core/runner";
import type { PfTheme } from "../core/theme";
import type { ConnectorConfig } from "../core/connectors";
import { makeBundle, type PfBundle } from "../core/bundle";

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function stepTemplate(): WorkflowStep {
  return { id: makeId("step"), type: "Summarize", config: { prompt: "" } };
}

function workflowTemplate(): Workflow {
  return {
    id: makeId("wf"),
    name: "",
    tags: [],
    trigger: "Manual",
    steps: [stepTemplate()],
    output: "Save",
    updatedAt: Date.now(),
  };
}

export function WorkflowsView({
  runtimeMode,
  workflows,
  connectors,
  runHistory,
  theme,
  onSave,
  onRun,
  onSetConnectors,
  onExportBundle,
  onImportBundle,
}: {
  runtimeMode: RuntimeMode;
  workflows: Workflow[];
  connectors: ConnectorConfig[];
  runHistory: WorkflowRun[];
  theme: PfTheme;
  onSave: (wf: Workflow) => void;
  onRun: (workflowId: string) => void;
  onSetConnectors: (next: ConnectorConfig[]) => void;
  onExportBundle: () => PfBundle;
  onImportBundle: (raw: string) => void;
}) {
  const [draft, setDraft] = useState<Workflow>(() => workflows[0] ?? workflowTemplate());
  const [importRaw, setImportRaw] = useState("");

  const issues = useMemo(() => validateWorkflow(draft), [draft]);
  const score = readinessScore(issues);
  const outputs: WorkflowOutput[] = ["Save", "Email", "Slack", "Webhook"];

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
      <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
        <CardHeader className="flex flex-row items-center justify-between border-b border-white/10 py-4">
          <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Workflow Studio</div>
          <Badge variant="secondary">Mode: {runtimeMode.toUpperCase()}</Badge>
        </CardHeader>
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Workflow name"
              className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            />
            <select
              value={draft.trigger}
              onChange={(e) => setDraft((d) => ({ ...d, trigger: e.target.value as Workflow["trigger"] }))}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            >
              <option>Manual</option>
              <option>Schedule</option>
              <option>Webhook</option>
              <option>File Upload</option>
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-3">
            <div className="mb-2 text-xs font-bold tracking-[0.14em] uppercase">Steps</div>
            <div className="space-y-2">
              {draft.steps.map((step, idx) => (
                <div key={step.id} className="grid gap-2 md:grid-cols-[160px_1fr]">
                  <select
                    value={step.type}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s) =>
                          s.id === step.id ? { ...s, type: e.target.value as WorkflowStep["type"] } : s
                        ),
                      }))
                    }
                    className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2"
                  >
                    <option>Search</option>
                    <option>Summarize</option>
                    <option>Extract</option>
                    <option>Transform</option>
                    <option>Notify</option>
                  </select>
                  <input
                    value={step.config.prompt ?? ""}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s) =>
                          s.id === step.id ? { ...s, config: { ...s.config, prompt: e.target.value } } : s
                        ),
                      }))
                    }
                    placeholder={`Step ${idx + 1} prompt/config`}
                    className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2"
                  />
                </div>
              ))}
              <Button
                variant="secondary"
                onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, stepTemplate()] }))}
                className="w-full"
              >
                Add Step
              </Button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <select
              value={draft.output}
              onChange={(e) => setDraft((d) => ({ ...d, output: e.target.value as WorkflowOutput }))}
              className="rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            >
              {outputs.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <select
              value={draft.outputConnectorType ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, outputConnectorType: e.target.value as Workflow["outputConnectorType"] }))}
              className="rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            >
              <option value="">(connector type)</option>
              <option>Email</option>
              <option>Slack</option>
              <option>Webhook</option>
            </select>
            <input
              value={draft.outputConnectorTarget ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, outputConnectorTarget: e.target.value }))}
              placeholder="target: email / #channel / webhook"
              className="rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            />
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-3">
            <div className="text-xs font-bold tracking-[0.14em] uppercase">Readiness: {score}%</div>
            <div className="mt-2 space-y-1 text-xs">
              {issues.length ? (
                issues.map((issue, i) => (
                  <div key={`${issue.message}-${i}`} className={issue.severity === "error" ? "text-rose-300" : "text-amber-200"}>
                    [{issue.severity.toUpperCase()}] {issue.message}
                  </div>
                ))
              ) : (
                <div className="text-emerald-200">No validation issues.</div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onSave({ ...draft, updatedAt: Date.now() })}>Save Workflow</Button>
            <Button variant="secondary" onClick={() => draft.id && onRun(draft.id)}>
              Run Workflow
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const bundle = onExportBundle();
                const fallback = makeBundle({
                  workspace: { id: "ws_local", name: "Local Workspace" },
                  users: [{ id: "u_local", displayName: "Local User", role: "owner" }],
                  theme,
                  connectors,
                  workflows,
                });
                const payload = JSON.stringify(bundle ?? fallback, null, 2);
                navigator.clipboard.writeText(payload).catch(() => {});
              }}
            >
              Export Bundle
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
          <CardHeader className="border-b border-white/10 py-4">
            <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Connectors</div>
          </CardHeader>
          <CardContent className="space-y-2 p-4">
            {connectors.map((c) => (
              <div key={c.type} className="rounded-xl border border-white/10 bg-slate-950/30 p-3">
                <div className="grid gap-2">
                  <label className="text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) =>
                        onSetConnectors(connectors.map((x) => (x.type === c.type ? { ...x, enabled: e.target.checked } : x)))
                      }
                      className="mr-2"
                    />
                    {c.displayName}
                  </label>
                  <input
                    value={c.target ?? ""}
                    onChange={(e) => onSetConnectors(connectors.map((x) => (x.type === c.type ? { ...x, target: e.target.value } : x)))}
                    className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
          <CardHeader className="border-b border-white/10 py-4">
            <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Bundle Import</div>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <textarea
              value={importRaw}
              onChange={(e) => setImportRaw(e.target.value)}
              placeholder="Paste pf_bundle_v2 JSON here..."
              className="min-h-[140px] w-full rounded-2xl border border-white/10 bg-slate-950/40 p-3 font-mono text-xs"
            />
            <Button
              className="w-full"
              onClick={() => {
                if (importRaw.trim()) onImportBundle(importRaw);
              }}
            >
              Import Bundle
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
          <CardHeader className="border-b border-white/10 py-4">
            <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Run Console</div>
          </CardHeader>
          <CardContent className="space-y-2 p-4">
            {runHistory.slice(0, 5).map((run) => (
              <div key={run.runId} className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
                <div className="text-xs font-bold uppercase">{run.workflowName}</div>
                <div className="text-xs text-slate-300/80">Status: {run.status}</div>
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-slate-200/80">
                  {run.logs.slice(-6).join("\n")}
                </pre>
              </div>
            ))}
            {!runHistory.length ? <div className="text-xs text-slate-300/70">No runs yet.</div> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

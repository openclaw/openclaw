"use client";

import { useEffect, useState } from "react";
import { Sidebar, type PfView } from "./sidebar";
import { Topbar } from "./topbar";
import type { AgentKey } from "./mock-data";
import { DEFAULT_ACTIVE_AGENTS as DEFAULT_AGENTS } from "./mock-data";

import type { RuntimeMode, TimelineEvent, Workflow, WorkflowStep } from "./core/types";
import { logAllowed } from "./core/runtime";
import { ConfirmActionDialog, type PendingAction } from "./ui/confirm-action-dialog";

import { MissionControlView } from "./views/mission-control";
import { AgentForgeView } from "./views/agent-forge";
import { TaskPipelineView } from "./views/task-pipeline";
import { DataVisionView } from "./views/data-vision";
import { FangCliView } from "./views/fang-cli";
import { TimelineView } from "./views/timeline";
import { WorkflowsView } from "./views/workflows";
import { OperatorBriefView } from "./views/operator-brief";

import { getFangEventStream } from "./core/events";
import { executeWorkflowMock, type WorkflowRun } from "./core/runner";
import { DEFAULT_THEME, type PfTheme } from "./core/theme";
import { makeBundle, parseBundle } from "./core/bundle";
import { DEFAULT_CONNECTORS, type ConnectorConfig } from "./core/connectors";

import type { Workspace, PfUser, PfRole } from "./core/saas/types";
import { can } from "./core/saas/policies";
import { wsKey, safeRead, safeWrite } from "./core/saas/storage";
import { makeAudit, type AuditEvent } from "./core/saas/audit";

export type ActiveAgent = { name: string; desc: string; icon: string; status: string };

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function now() {
  return Date.now();
}

function seedWorkflow(): Workflow {
  const step: WorkflowStep = {
    id: uid("step"),
    type: "Summarize",
    config: { prompt: "Summarize key signals + actionable recommendations." },
  };
  return {
    id: uid("wf"),
    name: "Market Intel Report Email",
    tags: ["market", "report"],
    trigger: "Manual",
    steps: [step],
    output: "Email",
    outputConnectorType: "Email",
    outputConnectorTarget: "you@domain.com",
    updatedAt: now(),
  };
}

const DEFAULT_WORKSPACES: Workspace[] = [
  { id: "ws_main", name: "mNtLSpACE Main" },
  { id: "ws_demo", name: "Platinum Fang Demo" },
  { id: "ws_ops", name: "Ops Lab" },
];

const DEFAULT_USERS: PfUser[] = [{ id: "u_sterling", displayName: "Sterling", role: "owner" }];

export function AppShell() {
  const [view, setView] = useState<PfView>("mission");
  const [uptime, setUptime] = useState("SYSTEM 00:00");

  const [workspaces] = useState<Workspace[]>(DEFAULT_WORKSPACES);
  const [workspace, setWorkspace] = useState<Workspace>(DEFAULT_WORKSPACES[0]);
  const [users, setUsers] = useState<PfUser[]>(DEFAULT_USERS);
  const [user, setUser] = useState<PfUser>(DEFAULT_USERS[0]);

  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("operator");
  const [confirmDangerousActions, setConfirmDangerousActions] = useState(true);
  const [streamEnabled, setStreamEnabled] = useState(true);

  const [theme, setTheme] = useState<PfTheme>(DEFAULT_THEME);
  const [connectors, setConnectors] = useState<ConnectorConfig[]>(DEFAULT_CONNECTORS);
  const [activeAgents, setActiveAgents] = useState<ActiveAgent[]>(
    (DEFAULT_AGENTS as unknown as ActiveAgent[]).map((a) => ({ ...a }))
  );
  const [workflows, setWorkflows] = useState<Workflow[]>([seedWorkflow()]);
  const [runHistory, setRunHistory] = useState<WorkflowRun[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([
    { id: uid("evt"), ts: now(), type: "system", title: "Fang Core boot complete" },
    { id: uid("evt"), ts: now(), type: "agent", title: "Agents online", detail: "Default pack loaded" },
  ]);
  const [globalLogs, setGlobalLogs] = useState<string[]>([
    "[FANG CORE] Boot sequence complete.",
    "[FANG COMMANDER] Mission plan locked.",
    "[FANG ANALYST] Streaming market data",
  ]);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const canRun = can(user.role, "run_workflow");
  const canEdit = can(user.role, "edit_workflow");
  const canExport = can(user.role, "export_bundle");
  const canImport = can(user.role, "import_bundle");
  const canManageConnectors = can(user.role, "manage_connectors");
  const canDeploy = can(user.role, "deploy_agents");
  const canToggleGuardrails = can(user.role, "toggle_guardrails");

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      setUptime(`SYSTEM ${mm}:${ss}`);
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const wf = safeRead<Workflow[]>(wsKey(workspace, "workflows"), [seedWorkflow()]);
    const cn = safeRead<ConnectorConfig[]>(wsKey(workspace, "connectors"), DEFAULT_CONNECTORS);
    const th = safeRead<PfTheme>(wsKey(workspace, "theme"), DEFAULT_THEME);
    const ag = safeRead<ActiveAgent[]>(wsKey(workspace, "agents"), activeAgents);
    const rh = safeRead<WorkflowRun[]>(wsKey(workspace, "runHistory"), []);
    const au = safeRead<AuditEvent[]>(wsKey(workspace, "audit"), []);

    setWorkflows(wf);
    setConnectors(cn);
    setTheme(th);
    setActiveAgents(ag);
    setRunHistory(rh);
    setAudit(au);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  useEffect(() => {
    safeWrite(wsKey(workspace, "workflows"), workflows);
  }, [workspace, workflows]);
  useEffect(() => {
    safeWrite(wsKey(workspace, "connectors"), connectors);
  }, [workspace, connectors]);
  useEffect(() => {
    safeWrite(wsKey(workspace, "theme"), theme);
  }, [workspace, theme]);
  useEffect(() => {
    safeWrite(wsKey(workspace, "agents"), activeAgents);
  }, [workspace, activeAgents]);
  useEffect(() => {
    safeWrite(wsKey(workspace, "runHistory"), runHistory);
  }, [workspace, runHistory]);
  useEffect(() => {
    safeWrite(wsKey(workspace, "audit"), audit);
  }, [workspace, audit]);

  const pushEvent = (type: TimelineEvent["type"], title: string, detail?: string) => {
    const evt: TimelineEvent = { id: uid("evt"), ts: now(), type, title, detail };
    setTimeline((t) => [evt, ...t].slice(0, 400));
    const aud = makeAudit(workspace, user, `${type}:${title}`, detail);
    setAudit((a) => [aud, ...a].slice(0, 800));
  };

  const addLog = (line: string, level: "low" | "med" | "high" = "med") => {
    if (!logAllowed(runtimeMode, level)) return;
    setGlobalLogs((l) => [...l.slice(-120), line]);
  };

  const guarded = (action: Omit<PendingAction, "open">) => {
    if (!confirmDangerousActions || runtimeMode === "studio") {
      void action.onConfirm();
      return;
    }
    setPending({ ...action, open: true });
  };

  useEffect(() => {
    const stream = getFangEventStream();
    stream.configure({
      mode: runtimeMode,
      enabled: streamEnabled,
      log: (line, level) => addLog(line, level ?? "med"),
    });

    const unsub = stream.subscribe((evt) => {
      setTimeline((t) => [evt, ...t].slice(0, 400));
      const aud = makeAudit(workspace, user, `stream:${evt.type}:${evt.title}`, evt.detail);
      setAudit((a) => [aud, ...a].slice(0, 800));
    });
    stream.start();
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const stream = getFangEventStream();
    stream.setEnabled(streamEnabled);
    pushEvent("system", "Stream toggled", streamEnabled ? "ON" : "PAUSED");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEnabled]);

  useEffect(() => {
    const stream = getFangEventStream();
    stream.setMode(runtimeMode);
    pushEvent("system", "Runtime mode synced", runtimeMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const ctrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

      if (ctrlOrCmd && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setView("cli");
        pushEvent("cli", "Shortcut", "Opened Fang CLI");
        return;
      }
      if (ctrlOrCmd && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setView("timeline");
        pushEvent("system", "Shortcut", "Opened Timeline");
        return;
      }
      if (e.key === "Escape") setView("mission");
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCreateAgent = (name: string, role: string) => {
    setActiveAgents((prev) => [...prev, { name, desc: role, icon: "AG", status: "ONLINE" }]);
    pushEvent("agent", "Agent created", `${name} ${role}`);
    addLog(`[AGENT FORGE] Created: ${name} (${role})`, "med");
    setView("mission");
  };

  const onDeployAgent = (key: AgentKey) => {
    if (!canDeploy) {
      pushEvent("security", "Blocked deploy", "Role lacks deploy permission");
      addLog(`[SECURITY] Deploy blocked for role=${user.role}`, "high");
      return;
    }

    const map: Record<AgentKey, ActiveAgent> = {
      analyst: { name: "Fang Analyst", desc: "Research + insights generator", icon: "AN", status: "ONLINE" },
      builder: { name: "Fang Builder", desc: "Code + system construction", icon: "BL", status: "ONLINE" },
      automator: { name: "Fang Automator", desc: "Workflow execution + triggers", icon: "AU", status: "ONLINE" },
      commander: { name: "Fang Commander", desc: "Orchestration + mission planning", icon: "CM", status: "ONLINE" },
    };
    const agent = map[key];

    guarded({
      kind: "deploy_agent",
      title: `Deploy ${agent.name}`,
      detail: "This starts the agent runtime (mock in this UI build).",
      payloadPreview: JSON.stringify(agent, null, 2),
      confirmLabel: "Deploy",
      onConfirm: () => {
        setActiveAgents((prev) => (prev.some((a) => a.name === agent.name) ? prev : [...prev, agent]));
        pushEvent("agent", "Agent deployed", agent.name);
        addLog(`[DEPLOY] ${agent.name} deployed successfully.`, "high");
        setView("mission");
      },
    });
  };

  const onLaunchPlatform = () => {
    guarded({
      kind: "external_action",
      title: "Launch Platform",
      detail: "In production this would start your OpenClaw fork runtime.",
      payloadPreview: JSON.stringify({ ws: workspace.id, mode: runtimeMode, guardrails: confirmDangerousActions }, null, 2),
      confirmLabel: "Launch",
      onConfirm: () => {
        pushEvent("system", "Platform launched", `Workspace=${workspace.name} Mode=${runtimeMode}`);
        addLog("[FANG CORE] Platform launch executed (mock).", "high");
      },
    });
  };

  const onChangeMode = (m: RuntimeMode) => setRuntimeMode(m);

  const onToggleGuardrails = () => {
    if (!canToggleGuardrails) {
      pushEvent("security", "Blocked guardrails toggle", "Role lacks permission");
      return;
    }
    setConfirmDangerousActions((v) => !v);
    pushEvent("security", "Guardrails toggled", !confirmDangerousActions ? "ON" : "OFF");
    addLog(`[SECURITY] Guardrails ${!confirmDangerousActions ? "ON" : "OFF"}.`, "high");
  };

  const upsertWorkflow = (wf: Workflow) => {
    if (!canEdit) {
      pushEvent("security", "Blocked workflow save", "Role is read-only");
      return;
    }

    setWorkflows((prev) => {
      const exists = prev.some((x) => x.id === wf.id);
      const next = { ...wf, updatedAt: now() };
      const out = exists ? prev.map((x) => (x.id === wf.id ? next : x)) : [next, ...prev];
      return out.slice(0, 200);
    });
    pushEvent("workflow", "Workflow saved", wf.name);
    addLog(`[WORKFLOW] Saved: ${wf.name}`, "med");
  };

  const runWorkflow = async (workflowId: string) => {
    if (!canRun) {
      pushEvent("security", "Blocked workflow run", "Role lacks permission");
      return;
    }

    const wf = workflows.find((w) => w.id === workflowId);
    if (!wf) return;

    guarded({
      kind: "run_workflow",
      title: `Run Workflow: ${wf.name}`,
      detail: "Executes steps and writes logs to Run Console.",
      payloadPreview: JSON.stringify(wf, null, 2),
      confirmLabel: "Run",
      onConfirm: async () => {
        pushEvent("workflow", "Workflow run started", wf.name);
        addLog(`[WORKFLOW] Run started: ${wf.name}`, "high");

        const queued: WorkflowRun = {
          runId: `queued_${Date.now()}`,
          workflowId: wf.id,
          workflowName: wf.name,
          startedAt: Date.now(),
          status: "queued",
          logs: [`[RUN] queued: ${wf.name}`],
        };
        setRunHistory((h) => [queued, ...h].slice(0, 80));

        const run = await executeWorkflowMock(wf, { fast: false });

        setRunHistory((h) => {
          const filtered = h.filter((r) => !(r.status === "queued" && r.workflowId === wf.id));
          return [run, ...filtered].slice(0, 80);
        });

        pushEvent("workflow", "Workflow run complete", `${wf.name} ${run.status.toUpperCase()}`);
        addLog(`[WORKFLOW] Run complete: ${wf.name} (${run.status})`, "high");
      },
    });
  };

  const prepareBundle = () =>
    makeBundle({
      workspace,
      users,
      theme,
      connectors,
      workflows,
      agents: activeAgents,
      runHistory,
    });

  const importBundle = (raw: string) => {
    if (!canImport) {
      pushEvent("security", "Blocked bundle import", "Role lacks permission");
      return;
    }
    try {
      const bundle = parseBundle(raw);
      setWorkspace(bundle.workspace);
      setUsers(bundle.users);
      setTheme(bundle.theme);
      setConnectors(bundle.connectors);
      setWorkflows(bundle.workflows.map((w) => ({ ...w, updatedAt: w.updatedAt ?? Date.now() })));
      if (bundle.agents?.length) setActiveAgents(bundle.agents as ActiveAgent[]);
      if (bundle.runHistory?.length) setRunHistory(bundle.runHistory);

      pushEvent("system", "Bundle imported", `WS=${bundle.workspace.name} Workflows=${bundle.workflows.length}`);
      addLog("[BUNDLE] Imported PF bundle (v2).", "high");
    } catch (error) {
      const e = error as Error;
      pushEvent("alert", "Bundle import failed", e?.message ?? "Invalid bundle JSON");
      addLog(`[ERROR] Bundle import failed: ${e?.message ?? "Invalid bundle JSON"}`, "high");
    }
  };

  const onSwitchWorkspace = (wsId: string) => {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    setWorkspace(ws);
    pushEvent("system", "Workspace switched", ws.name);
  };

  const onSwitchRole = (role: PfRole) => {
    setUser((u) => ({ ...u, role }));
    pushEvent("security", "Role switched", role);
  };

  const Screen = (() => {
    switch (view) {
      case "mission":
        return <MissionControlView uptime={uptime} agents={activeAgents} globalLogs={globalLogs} runtimeMode={runtimeMode} />;
      case "workflows":
        return (
          <WorkflowsView
            runtimeMode={runtimeMode}
            workflows={workflows}
            connectors={connectors}
            runHistory={runHistory}
            theme={theme}
            onSave={upsertWorkflow}
            onRun={runWorkflow}
            onSetConnectors={(next) => {
              if (!canManageConnectors) {
                pushEvent("security", "Blocked connector change", "Role lacks permission");
                return;
              }
              setConnectors(next);
              pushEvent("system", "Connectors updated", `Count=${next.length}`);
            }}
            onExportBundle={() => {
              if (!canExport) {
                pushEvent("security", "Blocked bundle export", "Role lacks permission");
                return prepareBundle();
              }
              const b = prepareBundle();
              pushEvent("system", "Bundle prepared", `WS=${workspace.name}`);
              addLog("[BUNDLE] Bundle prepared for download.", "high");
              return b;
            }}
            onImportBundle={(raw) => {
              guarded({
                kind: "import_bundle",
                title: "Import Marketplace Bundle",
                detail: "This will overwrite current workspace config for workflows/connectors/theme.",
                payloadPreview: raw.slice(0, 2200) + (raw.length > 2200 ? "\n...\n(truncated preview)" : ""),
                confirmLabel: "Import",
                onConfirm: () => importBundle(raw),
              });
            }}
          />
        );
      case "timeline":
        return <TimelineView events={timeline} audit={audit} workspace={workspace} />;
      case "operator":
        return (
          <OperatorBriefView
            runtimeMode={runtimeMode}
            events={timeline}
            workflows={workflows}
            onEmitBriefEvent={(title, detail) => pushEvent("system", title, detail)}
          />
        );
      case "forge":
        return <AgentForgeView onCreateAgent={onCreateAgent} />;
      case "pipeline":
        return <TaskPipelineView />;
      case "vision":
        return <DataVisionView />;
      case "cli":
        return (
          <FangCliView
            runtimeMode={runtimeMode}
            confirmDangerousActions={confirmDangerousActions}
            workflows={workflows}
            onMode={onChangeMode}
            onRunWorkflow={runWorkflow}
            onExportWorkflows={() => {
              pushEvent("cli", "CLI export", `Workflows=${workflows.length}`);
              addLog("[CLI] export workflows (bundle export is recommended)", "high");
            }}
            onLog={(l, level) => addLog(l, level)}
            onEvent={(t, title, detail) => pushEvent(t, title, detail)}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[280px_1fr]">
      <Sidebar active={view} onChange={setView} />
      <main className="p-4 lg:p-5">
        <Topbar
          runtimeMode={runtimeMode}
          confirmDangerousActions={confirmDangerousActions}
          streamEnabled={streamEnabled}
          onChangeMode={onChangeMode}
          onToggleGuardrails={onToggleGuardrails}
          onToggleStream={() => setStreamEnabled((v) => !v)}
          onCreateAgent={onCreateAgent}
          onDeployAgent={onDeployAgent}
          onLaunchPlatform={onLaunchPlatform}
          workspace={workspace}
          workspaces={workspaces}
          user={user}
          onSwitchWorkspace={onSwitchWorkspace}
          onSwitchRole={onSwitchRole}
          canDeploy={canDeploy}
          canToggleGuardrails={canToggleGuardrails}
        />
        <div className="mt-4">{Screen}</div>
        <ConfirmActionDialog pending={pending} onClose={() => setPending(null)} />
      </main>
    </div>
  );
}

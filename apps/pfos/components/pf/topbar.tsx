"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

import { NotificationsSheet } from "./ui/notifications-sheet";
import { CreateAgentSheet } from "./ui/create-agent-sheet";
import { DeployAgentDialog } from "./ui/deploy-agent-dialog";

import type { AgentKey } from "./mock-data";
import type { RuntimeMode } from "./core/types";
import { modeLabel } from "./core/runtime";
import type { Workspace, PfUser, PfRole } from "./core/saas/types";
import { roleLabel } from "./core/saas/policies";

export function Topbar({
  runtimeMode,
  confirmDangerousActions,
  streamEnabled,
  onChangeMode,
  onToggleGuardrails,
  onToggleStream,
  onCreateAgent,
  onDeployAgent,
  onLaunchPlatform,
  workspace,
  workspaces,
  user,
  onSwitchWorkspace,
  onSwitchRole,
  canDeploy,
  canToggleGuardrails,
}: {
  runtimeMode: RuntimeMode;
  confirmDangerousActions: boolean;
  streamEnabled: boolean;
  onChangeMode: (m: RuntimeMode) => void;
  onToggleGuardrails: () => void;
  onToggleStream: () => void;
  onCreateAgent: (name: string, role: string) => void;
  onDeployAgent: (key: AgentKey) => void;
  onLaunchPlatform: () => void;
  workspace: Workspace;
  workspaces: Workspace[];
  user: PfUser;
  onSwitchWorkspace: (wsId: string) => void;
  onSwitchRole: (role: PfRole) => void;
  canDeploy: boolean;
  canToggleGuardrails: boolean;
}) {
  const [org, setOrg] = useState("mNtLSpACE Labs");

  return (
    <div className="sticky top-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-white/10 bg-black/30 p-4 backdrop-blur">
      <div>
        <div className="text-lg font-black tracking-[0.22em] uppercase">PLATINUM FANG OS</div>
        <div className="mt-1 text-[11px] font-semibold tracking-[0.22em] uppercase text-yellow-300/90">
          Command Autonomous Intelligence
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="rounded-full border border-white/10 bg-slate-950/35">
            Workspace: {workspace.name}
          </Badge>
          <Badge className="rounded-full border border-yellow-300/20 bg-yellow-300/10 text-yellow-100">
            Role: {roleLabel(user.role)}
          </Badge>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-2">
        <select
          value={workspace.id}
          onChange={(e) => onSwitchWorkspace(e.target.value)}
          className="h-10 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm text-slate-100 outline-none focus:border-yellow-300/30"
          title="Switch Workspace"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <select
          value={user.role}
          onChange={(e) => onSwitchRole(e.target.value as PfRole)}
          className="h-10 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm text-slate-100 outline-none focus:border-yellow-300/30"
          title="Switch Role"
        >
          <option value="owner">OWNER</option>
          <option value="operator">OPERATOR</option>
          <option value="viewer">VIEWER</option>
        </select>

        <select
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          className="h-10 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm text-slate-100 outline-none focus:border-yellow-300/30"
        >
          <option>mNtLSpACE Labs</option>
          <option>Platinum Fang Studio</option>
          <option>QuasarSeed Ops</option>
        </select>

        <Badge variant="secondary" className="rounded-full border border-emerald-300/20 bg-emerald-300/10 text-emerald-100">
          SYSTEM ONLINE
        </Badge>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="inline-flex h-10 items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm font-semibold hover:border-yellow-300/25">
              Mode: {modeLabel(runtimeMode)}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={() => onChangeMode("stealth")}>Stealth</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onChangeMode("operator")}>Operator</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onChangeMode("studio")}>Studio</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={onToggleStream}
          className="inline-flex h-10 items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm font-semibold hover:border-yellow-300/25"
          title="Toggle live event stream"
        >
          LIVE: {streamEnabled ? "ON" : "PAUSED"}
        </button>

        <button
          onClick={onToggleGuardrails}
          disabled={!canToggleGuardrails}
          className="inline-flex h-10 items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 px-3 text-sm font-semibold hover:border-yellow-300/25 disabled:opacity-50"
          title="Confirm dangerous actions"
        >
          Guardrails: {confirmDangerousActions ? "ON" : "OFF"}
        </button>

        <NotificationsSheet />
        <CreateAgentSheet onCreate={onCreateAgent} />
        <div className={canDeploy ? "" : "pointer-events-none opacity-50"} title={canDeploy ? "" : "Role cannot deploy agents"}>
          <DeployAgentDialog onDeploy={onDeployAgent} />
        </div>

        <Button
          onClick={onLaunchPlatform}
          className="pf-glow rounded-2xl border border-yellow-300/35 bg-gradient-to-b from-yellow-400/15 to-sky-900/30"
        >
          Launch Platform
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2 hover:border-yellow-300/25">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="bg-slate-900 text-xs">SG</AvatarFallback>
              </Avatar>
              <span className="text-sm font-semibold text-slate-100/90">{user.displayName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuItem>Settings</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Billing</DropdownMenuItem>
            <DropdownMenuItem className="text-red-300">Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AGENT_CATALOG, type AgentKey } from "../mock-data";

export function DeployAgentDialog({ onDeploy }: { onDeploy: (key: AgentKey) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} className="rounded-2xl">
        Deploy Agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy Agent</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            {AGENT_CATALOG.map((agent) => (
              <button
                key={agent.key}
                className="rounded-xl border border-white/10 bg-slate-950/35 p-3 text-left hover:border-yellow-300/30"
                onClick={() => {
                  onDeploy(agent.key);
                  setOpen(false);
                }}
              >
                <div className="text-sm font-semibold">{agent.name}</div>
                <div className="text-xs text-slate-300/70">{agent.desc}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

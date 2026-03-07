"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function CreateAgentSheet({ onCreate }: { onCreate: (name: string, role: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} className="rounded-2xl">
        Create Agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <input
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            />
            <input
              placeholder="Agent role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
            />
            <Button
              className="w-full"
              onClick={() => {
                onCreate(name, role);
                setName("");
                setRole("");
                setOpen(false);
              }}
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

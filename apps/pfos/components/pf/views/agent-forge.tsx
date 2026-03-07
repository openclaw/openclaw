"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function AgentForgeView({ onCreateAgent }: { onCreateAgent: (name: string, role: string) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");

  return (
    <Card className="rounded-3xl border-white/10 bg-black/25 shadow">
      <CardHeader className="border-b border-white/10 py-4">
        <div className="text-xs font-extrabold tracking-[0.20em] uppercase">Agent Forge</div>
      </CardHeader>
      <CardContent className="space-y-3 p-4">
        <input
          placeholder="Agent Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
        />
        <input
          placeholder="Agent Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="w-full rounded-2xl border border-white/10 bg-slate-950/40 px-3 py-2"
        />
        <Button className="w-full" onClick={() => onCreateAgent(name, role)}>
          Create Agent
        </Button>
      </CardContent>
    </Card>
  );
}

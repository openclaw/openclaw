"use client";

import { useState, useMemo } from "react";
import { Send, Bot, AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getPriorityStyle } from "@/lib/shared";
import type { Task, Agent } from "@/lib/hooks/use-tasks";
import { SPECIALIZED_AGENTS, suggestAgentForTask } from "@/lib/agent-registry";

interface DispatchModalProps {
  task: Task;
  agents: Agent[];
  onClose: () => void;
  onDispatch: (taskId: string, agentId: string) => Promise<unknown>;
}

export function DispatchModal({ 
  task, 
  agents, 
  onClose, 
  onDispatch 
}: DispatchModalProps) {
  // Try to match a specialist for this task
  const suggestedSpecialist = useMemo(() => {
    return suggestAgentForTask(`${task.title} ${task.description}`);
  }, [task.title, task.description]);

  // Default to suggested specialist if available, else first agent
  const defaultAgent = suggestedSpecialist?.id || agents[0]?.id || "";
  const [selectedAgent, setSelectedAgent] = useState(defaultAgent);
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleDispatch = async () => {
    if (!selectedAgent) {return;}
    setDispatching(true);
    try {
      const res = await onDispatch(task.id, selectedAgent);
      setResult((res as { ok: boolean }).ok ? "success" : "error");
    } catch {
      setResult("error");
    }
    setDispatching(false);
  };

  // Check if we have any agents or specialists available
  const hasAgents = agents.length > 0 || SPECIALIZED_AGENTS.length > 0;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5 text-primary" /> Dispatch Task to Agent
          </DialogTitle>
        </DialogHeader>

        {/* Task summary */}
        <div className="p-3 rounded-md bg-muted border border-border">
          <div className="font-medium text-sm">{task.title}</div>
          <div className="text-xs text-muted-foreground mt-1">
            {task.description || "No description"}
          </div>
          <div className="mt-2">
            <Badge variant="outline" className={getPriorityStyle(task.priority).className}>
              {task.priority}
            </Badge>
          </div>
        </div>

        {!hasAgents ? (
          <div className="flex items-center gap-2 text-sm text-yellow-500 p-3 bg-yellow-500/10 rounded-md border border-yellow-500/20">
            <AlertTriangle className="w-4 h-4" />
            No agents available. Go to Agents page to create one first.
          </div>
        ) : (
          <>
            {/* Suggestion banner */}
            {suggestedSpecialist && selectedAgent !== suggestedSpecialist.id && (
              <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded-md text-sm">
                <Sparkles className="w-4 h-4 text-primary shrink-0" />
                <span className="flex-1">
                  <span className="font-medium">Suggested:</span>{" "}
                  <span className="text-primary">{suggestedSpecialist.icon} {suggestedSpecialist.name}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-primary hover:text-primary hover:bg-primary/10"
                  onClick={() => setSelectedAgent(suggestedSpecialist.id)}
                >
                  Use
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">Select Agent</label>
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Gateway Agents */}
                  {agents.length > 0 && (
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                      Gateway Agents
                    </div>
                  )}
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4" />
                        {agent.name || agent.id}
                        {agent.model && (
                          <span className="text-muted-foreground">({agent.model})</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                  {/* AI Specialists */}
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-t mt-1 pt-1">
                    AI Specialists
                  </div>
                  {SPECIALIZED_AGENTS.map((specialist) => (
                    <SelectItem key={specialist.id} value={specialist.id}>
                      <div className="flex items-center gap-2">
                        <span>{specialist.icon}</span>
                        {specialist.name}
                        {suggestedSpecialist?.id === specialist.id && (
                          <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 h-4">
                            Suggested
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {result && (
              <div className={`p-3 rounded-md text-sm ${
                result === "success"
                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                  : "bg-destructive/10 text-destructive border border-destructive/20"
              }`}>
                {result === "success" 
                  ? "✅ Task dispatched! Agent is processing..." 
                  : "❌ Dispatch failed"}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {hasAgents && !result && (
            <Button onClick={handleDispatch} disabled={dispatching || !selectedAgent}>
              {dispatching ? "Dispatching..." : "Send to Agent"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

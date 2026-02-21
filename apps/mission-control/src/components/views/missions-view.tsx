"use client";

import { useState, useCallback, useEffect } from "react";
import { Plus, Rocket, FileText, ChevronDown, ChevronRight, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/shared";

interface Task {
  id: string;
  title: string;
  description: string;
  priority: string;
  assigned_agent_id: string | null;
}

interface Mission {
  id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  tasks?: Task[];
}

export function MissionsView() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [expandedMissions, setExpandedMissions] = useState<Set<string>>(new Set());

  const toggleMission = (id: string) => {
    setExpandedMissions(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else { next.add(id); }
      return next;
    });
  };

  const loadInOrchestrator = (mission: Mission) => {
    if (!mission.tasks || mission.tasks.length === 0) { return; }
    try {
      // Map DB tasks to the shape Orchestrator expects
      const orchestratorTasks = mission.tasks.map(t => ({
        title: t.title,
        description: t.description || "",
        priority: t.priority,
        agentId: t.assigned_agent_id || "main"
      }));
      // Put in localStorage so orchestrator can pick it up
      window.localStorage.setItem("mission-control:orchestrator-queue", JSON.stringify(orchestratorTasks));
      window.location.hash = "orchestrate";
    } catch {
      // Ignore
    }
  };

  const fetchMissions = useCallback(async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const workspace = params.get("workspace") || "golden";
      const res = await fetch(`/api/missions?workspace_id=${encodeURIComponent(workspace)}`);
      const data = await res.json();
      setMissions(data.missions || []);
    } catch { /* retry */ }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchMissions();
  }, [fetchMissions]);

  const createMission = async () => {
    if (!newName.trim()) { return; }
    const params = new URLSearchParams(window.location.search);
    const workspace = params.get("workspace") || "golden";
    await fetch("/api/missions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim(),
        description: newDesc.trim(),
        workspace_id: workspace,
      }),
    });
    setNewName("");
    setNewDesc("");
    setShowCreate(false);
    await fetchMissions();
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Your Missions</h3>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Mission
        </Button>
      </div>

      {missions.length === 0 && !showCreate ? (
        <div className="text-center py-12 space-y-3">
          <Rocket className="w-10 h-10 mx-auto text-muted-foreground/30" />
          <p className="text-muted-foreground text-sm">
            No missions yet. Create your first mission.
          </p>
          <Button onClick={() => setShowCreate(true)}>Create Mission</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {showCreate && (
            <div className="bg-card border border-primary/20 rounded-lg p-5 space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Mission Name</label>
                <input
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., Content Marketing Campaign"
                  maxLength={200}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <textarea
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[60px] resize-y"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="What's the goal?"
                  maxLength={2000}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={createMission}>Create</Button>
              </div>
            </div>
          )}
          {missions.map((m) => {
            const isExpanded = expandedMissions.has(m.id);
            const taskCount = m.tasks?.length || 0;
            return (
              <div
                key={m.id}
                className="bg-card border border-border rounded-lg p-5 hover:border-primary/50 transition-all flex flex-col gap-4"
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="font-semibold flex items-center gap-2">
                      <Rocket className="w-5 h-5 text-primary" />
                      <span className="text-lg">{m.name}</span>
                    </div>
                    {m.description && (
                      <div className="text-sm text-muted-foreground mt-2 max-w-2xl">
                        {m.description}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Badge variant="outline" className="capitalize shrink-0">{m.status}</Badge>
                    {taskCount > 0 && (
                      <Button
                        size="sm"
                        variant="default"
                        className="gap-2 shrink-0 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20"
                        onClick={() => loadInOrchestrator(m)}
                      >
                        <Play className="w-4 h-4" /> Load in Orchestrator
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-4 mt-2">
                  <div className="flex items-center gap-2">
                    {timeAgo(m.created_at)}
                  </div>
                  {taskCount > 0 ? (
                    <button
                      onClick={() => toggleMission(m.id)}
                      className="flex items-center gap-1.5 hover:text-foreground font-medium transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      {taskCount} {taskCount === 1 ? 'Task' : 'Tasks'}
                      {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  ) : (
                    <span className="flex items-center gap-1.5 opacity-50">
                      <FileText className="w-3.5 h-3.5" /> 0 Tasks
                    </span>
                  )}
                </div>

                {/* Collapsible Tasks View */}
                {isExpanded && taskCount > 0 && (
                  <div className="pt-2 border-t border-border mt-2 space-y-2 animate-in slide-in-from-top-2 fade-in duration-200">
                    {m.tasks?.map((task, idx) => (
                      <div key={task.id} className="flex flex-col sm:flex-row sm:items-center gap-3 bg-muted/30 p-3 rounded-md border border-border/50">
                        <div className="flex text-muted-foreground font-mono text-xs w-6 shrink-0">
                          {(idx + 1).toString().padStart(2, '0')}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{task.title}</div>
                          {task.description && (
                            <div className="text-xs text-muted-foreground truncate opacity-80 mt-0.5">{task.description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary" className="text-[10px] uppercase font-mono tracking-wider bg-background/50">{task.priority}</Badge>
                          <div className="text-xs bg-background/50 px-2 py-1 rounded-sm border border-border/50 text-muted-foreground truncate max-w-[120px]">
                            {task.assigned_agent_id || 'main'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

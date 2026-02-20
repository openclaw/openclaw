"use client";

import { useState } from "react";
import { Bot, Plus, Wifi, Monitor, Globe, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { EmptyAgents } from "@/components/empty-states";
import type { GatewayStatus, Agent } from "@/lib/hooks/use-tasks";

interface AgentsViewProps {
  status: GatewayStatus;
  agents: Agent[];
  onRefresh: () => void;
  onStartGateway?: () => void;
}

export function AgentsView({ status, agents, onRefresh, onStartGateway }: AgentsViewProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newIdentity, setNewIdentity] = useState("");
  const [createResult, setCreateResult] = useState<string | null>(null);

  // File editor state
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [activeFile, setActiveFile] = useState<"SOUL.md" | "INSTRUCTIONS.md">("SOUL.md");
  const [fileContent, setFileContent] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileSaved, setFileSaved] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newId.trim()) return;
    setCreating(true);
    setCreateResult(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: newId.trim(),
          name: newId.trim(),
          identity: newIdentity.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setCreateResult("success");
        setNewId("");
        setNewIdentity("");
        onRefresh();
        setTimeout(() => { setShowCreate(false); setCreateResult(null); }, 1500);
      } else {
        setCreateResult(`error:${data.error || "Failed to create agent"}`);
      }
    } catch (err) {
      setCreateResult(`error:${String(err)}`);
    }
    setCreating(false);
  };

  const handleOpenEditor = async (agent: Agent) => {
    setEditingAgent(agent);
    setActiveFile("SOUL.md");
    setFileSaved(false);
    setFileError(null);
    await loadFile(agent.id, "SOUL.md");
  };

  const loadFile = async (agentId: string, fileName: "SOUL.md" | "INSTRUCTIONS.md") => {
    setLoadingFile(true);
    setFileError(null);
    try {
      const res = await fetch(`/api/agents/files?agentId=${encodeURIComponent(agentId)}&name=${encodeURIComponent(fileName)}`);
      const data = await res.json();
      if (res.ok) {
        setFileContent(data.content || "");
      } else {
        setFileError(data.error || "Failed to load file");
        setFileContent("");
      }
    } catch (err) {
      setFileError(String(err));
      setFileContent("");
    }
    setLoadingFile(false);
  };

  const handleSaveFile = async () => {
    if (!editingAgent) return;
    setSavingFile(true);
    setFileSaved(false);
    setFileError(null);
    try {
      const res = await fetch("/api/agents/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: editingAgent.id,
          name: activeFile,
          content: fileContent,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setFileSaved(true);
        setTimeout(() => setFileSaved(false), 2000);
      } else {
        setFileError(data.error || "Failed to save file");
      }
    } catch (err) {
      setFileError(String(err));
    }
    setSavingFile(false);
  };

  const handleTabChange = async (fileName: "SOUL.md" | "INSTRUCTIONS.md") => {
    if (!editingAgent) return;
    setActiveFile(fileName);
    setFileSaved(false);
    await loadFile(editingAgent.id, fileName);
  };

  if (!status.connected) {
    return (
      <EmptyAgents
        isConnected={false}
        onCreateAgent={() => setShowCreate(true)}
        onStartGateway={onStartGateway}
      />
    );
  }

  // Show empty state when no agents exist
  if (agents.length === 0 && !showCreate) {
    return (
      <div className="p-6">
        <EmptyAgents
          isConnected={true}
          onCreateAgent={() => setShowCreate(true)}
        />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Total Agents
          </div>
          <div className="text-2xl font-bold text-primary">{agents.length}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Cron Jobs
          </div>
          <div className="text-2xl font-bold text-primary">{status.cronJobCount}</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Gateway
          </div>
          <div className="text-lg font-bold text-green-500 flex items-center gap-2">
            <Wifi className="w-4 h-4" /> Online
          </div>
        </div>
      </div>

      {/* Telegram Control Callout */}
      <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <div className="flex-shrink-0 bg-primary/10 p-2 rounded-full">
          <Bot className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 space-y-1">
          <h4 className="text-sm font-semibold text-primary">Remote Control Available</h4>
          <p className="text-xs text-muted-foreground">
            Bind the <code className="bg-muted px-1 py-0.5 rounded text-[10px]">mission_control_ops</code> skill to your Telegram Master Bot to manage specialists, check system status, and deploy tasks directly via chat commands (e.g. <code className="bg-muted px-1 py-0.5 rounded text-[10px]">/tasks</code>, <code className="bg-muted px-1 py-0.5 rounded text-[10px]">/status</code>).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { window.location.hash = "integrations"; }}>
          Configure Integrations
        </Button>
      </div>

      {/* Create button and Channel Nav */}
      <div className="flex items-center justify-between">
        <Button
          onClick={() => setShowCreate(!showCreate)}
          variant={showCreate ? "outline" : "default"}
        >
          {showCreate ? "Cancel" : <><Plus className="w-4 h-4 mr-1" /> Create Agent</>}
        </Button>
        <button
          onClick={() => { window.location.hash = "channels"; }}
          className="text-sm text-muted-foreground hover:text-foreground hover:underline flex items-center gap-1.5 transition-colors"
        >
          <Globe className="h-4 w-4" />
          Manage Channels
          <ArrowRight className="h-3 w-3 opacity-50" />
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-card border border-primary/20 rounded-lg p-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Agent ID</label>
            <input
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="e.g., researcher, writer, reviewer"
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Identity / Persona (SOUL.md)</label>
            <textarea
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[100px] resize-y"
              value={newIdentity}
              onChange={(e) => setNewIdentity(e.target.value)}
              placeholder="You are a skilled researcher who finds and summarizes information..."
              maxLength={2000}
            />
          </div>
          {createResult && (
            <div className={`p-3 rounded-md text-sm ${createResult === "success"
              ? "bg-green-500/10 text-green-500"
              : "bg-destructive/10 text-destructive"
              }`}>
              {createResult === "success"
                ? "✅ Agent created successfully!"
                : `❌ ${createResult.replace("error:", "")}`}
            </div>
          )}
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create Agent in OpenClaw"}
          </Button>
        </div>
      )}

      {/* Agent grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="bg-card border border-border rounded-lg p-5 hover:border-primary/50 hover:shadow-[0_0_15px_oklch(0.58_0.2_260/0.1)] transition-all cursor-pointer group"
            onClick={() => handleOpenEditor(agent)}
          >
            <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center mb-3">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div className="font-semibold">{agent.name || agent.id}</div>
            <div className="text-xs text-muted-foreground font-mono">{agent.id}</div>
            {agent.model && (
              <div className="mt-2 text-xs text-primary flex items-center gap-1">
                <Monitor className="w-3 h-3" /> {agent.model}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* File Editor Dialog */}
      <Dialog open={!!editingAgent} onOpenChange={(open) => !open && setEditingAgent(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              Edit Agent: {editingAgent?.name || editingAgent?.id}
            </DialogTitle>
            <DialogDescription>
              Edit your agent&apos;s personality and instructions. Changes take effect immediately.
            </DialogDescription>
          </DialogHeader>

          {/* File Tabs */}
          <div className="flex gap-2 border-b border-border">
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px ${activeFile === "SOUL.md"
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
                }`}
              onClick={() => handleTabChange("SOUL.md")}
              disabled={loadingFile}
            >
              SOUL.md
            </button>
            <button
              className={`px-4 py-2 text-sm font-medium transition-colors -mb-px ${activeFile === "INSTRUCTIONS.md"
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
                }`}
              onClick={() => handleTabChange("INSTRUCTIONS.md")}
              disabled={loadingFile}
            >
              INSTRUCTIONS.md
            </button>
          </div>

          {/* Editor */}
          <div className="flex-1 min-h-0">
            {loadingFile ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Loading...
              </div>
            ) : (
              <textarea
                className="w-full h-full px-3 py-2 rounded-md border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                placeholder={`Enter ${activeFile} content...`}
              />
            )}
          </div>

          {/* Status Messages */}
          {fileError && (
            <div className="p-3 rounded-md text-sm bg-destructive/10 text-destructive">
              {fileError}
            </div>
          )}
          {fileSaved && (
            <div className="p-3 rounded-md text-sm bg-green-500/10 text-green-500">
              File saved successfully!
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingAgent(null)}
              disabled={savingFile}
            >
              Close
            </Button>
            <Button
              onClick={handleSaveFile}
              disabled={savingFile || loadingFile}
            >
              {savingFile ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

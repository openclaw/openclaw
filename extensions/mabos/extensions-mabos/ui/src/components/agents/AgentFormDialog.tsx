import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCreateAgent, useUpdateAgent } from "@/hooks/useAgentMutations";
import type { AgentListItem } from "@/lib/types";

type AgentFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  agent?: AgentListItem | null;
};

export function AgentFormDialog({ open, onOpenChange, businessId, agent }: AgentFormDialogProps) {
  const isEdit = !!agent;
  const createAgent = useCreateAgent(businessId);
  const updateAgent = useUpdateAgent(businessId);

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<"core" | "domain">("domain");
  const [autonomyLevel, setAutonomyLevel] = useState<"low" | "medium" | "high">("medium");
  const [threshold, setThreshold] = useState(100);
  const [status, setStatus] = useState<"active" | "idle" | "paused">("active");

  useEffect(() => {
    if (agent) {
      setId(agent.id);
      setName(agent.name);
      setType(agent.type);
      setAutonomyLevel(agent.autonomy_level);
      setThreshold(agent.approval_threshold_usd);
      setStatus(agent.status === "error" ? "paused" : agent.status);
    } else {
      setId("");
      setName("");
      setType("domain");
      setAutonomyLevel("medium");
      setThreshold(100);
      setStatus("active");
    }
  }, [agent, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (isEdit && agent) {
      updateAgent.mutate(
        {
          agentId: agent.id,
          body: {
            name,
            type,
            autonomy_level: autonomyLevel,
            approval_threshold_usd: threshold,
            status,
          },
        },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createAgent.mutate(
        {
          id: id.toLowerCase().replace(/\s+/g, "-"),
          name,
          type,
          autonomy_level: autonomyLevel,
          approval_threshold_usd: threshold,
        },
        { onSuccess: () => onOpenChange(false) },
      );
    }
  }

  const isPending = createAgent.isPending || updateAgent.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[var(--bg-card)] border-[var(--border-mabos)] text-[var(--text-primary)] max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Agent" : "Create Agent"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Agent ID</label>
              <Input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="e.g., product-mgr"
                required
                className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Product Manager"
              required
              className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as "core" | "domain")}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
              >
                <option value="core">Core</option>
                <option value="domain">Domain</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Autonomy Level</label>
              <select
                value={autonomyLevel}
                onChange={(e) => setAutonomyLevel(e.target.value as "low" | "medium" | "high")}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">
              Approval Threshold (USD)
            </label>
            <Input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              min={0}
              className="bg-[var(--bg-secondary)] border-[var(--border-mabos)] text-[var(--text-primary)]"
            />
          </div>

          {isEdit && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as "active" | "idle" | "paused")}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-mabos)] text-[var(--text-primary)]"
              >
                <option value="active">Active</option>
                <option value="idle">Idle</option>
                <option value="paused">Paused</option>
              </select>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-[var(--border-mabos)] text-[var(--text-secondary)]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending}
              className="bg-[var(--accent-green)] text-white hover:bg-[var(--accent-green)]/90"
            >
              {isPending ? "Saving..." : isEdit ? "Save Changes" : "Create Agent"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

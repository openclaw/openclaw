import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useArchiveAgent } from "@/hooks/useAgentMutations";

type AgentDeleteConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessId: string;
  agentId: string;
  agentName: string;
  onArchived?: () => void;
};

export function AgentDeleteConfirmDialog({
  open,
  onOpenChange,
  businessId,
  agentId,
  agentName,
  onArchived,
}: AgentDeleteConfirmDialogProps) {
  const archiveAgent = useArchiveAgent(businessId);

  function handleArchive() {
    archiveAgent.mutate(agentId, {
      onSuccess: () => {
        onOpenChange(false);
        onArchived?.();
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[var(--bg-card)] border-[var(--border-mabos)] text-[var(--text-primary)] max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-[var(--accent-red)]" />
            Archive Agent
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-[var(--text-secondary)]">
          Are you sure you want to archive{" "}
          <span className="font-medium text-[var(--text-primary)]">{agentName}</span>? The agent's
          data will be preserved but it will be removed from active duty.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-[var(--border-mabos)] text-[var(--text-secondary)]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleArchive}
            disabled={archiveAgent.isPending}
            className="bg-[var(--accent-red)] text-white hover:bg-[var(--accent-red)]/90"
          >
            {archiveAgent.isPending ? "Archiving..." : "Archive"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

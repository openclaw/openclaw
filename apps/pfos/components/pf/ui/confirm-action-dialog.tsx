"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { dangerousActionLabel } from "../core/runtime";

export type PendingAction = {
  open: boolean;
  kind: string;
  title: string;
  detail?: string;
  payloadPreview?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmActionDialog({ pending, onClose }: { pending: PendingAction | null; onClose: () => void }) {
  if (!pending) return null;

  return (
    <Dialog open={pending.open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="border-white/10 bg-black/85 text-slate-100">
        <DialogHeader>
          <DialogTitle className="tracking-[0.16em] uppercase">Confirm: {dangerousActionLabel(pending.kind)}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">{pending.title}</div>
              <Badge className="rounded-full border border-yellow-300/20 bg-yellow-300/10 text-yellow-100">GUARDRAIL</Badge>
            </div>
            {pending.detail ? <div className="mt-2 text-sm text-slate-200/70">{pending.detail}</div> : null}
          </div>

          {pending.payloadPreview ? (
            <pre className="whitespace-pre-wrap rounded-2xl border border-white/10 bg-slate-950/35 p-3 font-mono text-xs text-slate-100/80">
              {pending.payloadPreview}
            </pre>
          ) : null}

          <div className="flex gap-2">
            <Button variant="secondary" className="w-full rounded-2xl border border-white/10 bg-slate-900/40" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="pf-glow w-full rounded-2xl border border-yellow-300/35 bg-gradient-to-b from-yellow-400/15 to-sky-900/30"
              onClick={async () => {
                await pending.onConfirm();
                onClose();
              }}
            >
              {pending.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

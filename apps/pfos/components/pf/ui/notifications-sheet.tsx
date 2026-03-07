"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NOTIFICATIONS } from "../mock-data";
import { Badge } from "@/components/ui/badge";

export function NotificationsSheet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} className="rounded-2xl">
        Notifications
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notifications</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {NOTIFICATIONS.map((n) => (
              <div key={n.title} className="rounded-xl border border-white/10 bg-slate-950/35 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">{n.title}</div>
                  <Badge>{n.tag}</Badge>
                </div>
                <div className="mt-1 text-xs text-slate-300/80">{n.body}</div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

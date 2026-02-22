"use client";

import { X, Monitor, Terminal } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTime, getActivityColor, getActivityLabel } from "@/lib/shared";
import type { ActivityEntry } from "@/lib/hooks/use-tasks";

interface LiveTerminalProps {
  open: boolean;
  onClose: () => void;
  activity: ActivityEntry[];
}

export function LiveTerminal({ open, onClose, activity }: LiveTerminalProps) {
  return (
    <aside
      className={`absolute top-0 right-0 bottom-0 w-80 border-l border-border bg-background flex flex-col overflow-hidden z-30 font-mono text-xs shadow-[-4px_0_24px_oklch(0_0_0/0.15)] transition-transform duration-300 ease-in-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="p-4 border-b border-border bg-card/50 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-primary" />
          <span className="font-bold tracking-wide text-sm">LIVE TERMINAL</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <button
            onClick={onClose}
            type="button"
            aria-label="Close terminal panel"
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4 text-muted-foreground font-mono">
          {activity.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground/50">
              <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>Waiting for activity...</p>
            </div>
          ) : (
            activity.map((entry, i) => (
              <div
                key={entry.id}
                className="flex gap-2 leading-relaxed"
                style={{ opacity: Math.max(0.5, 1 - i * 0.06) }}
              >
                <span className="text-muted-foreground/60 shrink-0 tabular-nums">
                  [{formatTime(entry.created_at)}]
                </span>
                <div className="wrap-break-word min-w-0">
                  <span className={getActivityColor(entry.type)}>
                    {getActivityLabel(entry.type)}
                  </span>{" "}
                  <span className="text-foreground">
                    {entry.message}
                  </span>
                </div>
              </div>
            ))
          )}

          {/* Blinking cursor */}
          <div className="mt-4 flex gap-2 items-center">
            <span className="text-primary">{">"}</span>
            <span className="w-2 h-4 bg-primary cursor-blink" />
          </div>
        </div>
      </ScrollArea>

      {/* Command input - display only (read-only terminal) */}
      <div className="p-3 border-t border-border bg-card/50">
        <div className="flex items-center gap-2 text-muted-foreground/50 text-[10px]">
          <Monitor className="w-3 h-3" />
          <span>Read-only activity feed</span>
        </div>
      </div>
    </aside>
  );
}

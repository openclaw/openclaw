"use client";

import { useState, useEffect, useCallback } from "react";
import { Undo2, X, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getUndoStack,
  executeUndo,
  clearUndo,
  subscribeToUndo,
  getUndoRemainingTime,
  type UndoableAction,
} from "@/lib/undo-manager";

// --- Types ---

interface UndoToastProps {
  onUndoComplete?: (action: UndoableAction) => void;
}

// --- Main Component ---

export function UndoToast({ onUndoComplete }: UndoToastProps) {
  const [actions, setActions] = useState<UndoableAction[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [remainingTimes, setRemainingTimes] = useState<Record<string, number>>({});

  // Subscribe to undo stack changes
  useEffect(() => {
    const updateActions = () => {
      setActions(getUndoStack());
    };

    // Initial load
    updateActions();

    // Subscribe to changes
    const unsubscribe = subscribeToUndo(updateActions);

    return () => unsubscribe();
  }, []);

  // Update remaining times every 100ms
  useEffect(() => {
    if (actions.length === 0) {return;}

    const interval = setInterval(() => {
      const times: Record<string, number> = {};
      let hasExpired = false;

      actions.forEach((action) => {
        const remaining = getUndoRemainingTime(action);
        times[action.id] = remaining;
        if (remaining <= 0) {hasExpired = true;}
      });

      setRemainingTimes(times);

      // Refresh actions if any expired
      if (hasExpired) {
        setActions(getUndoStack());
      }
    }, 100);

    return () => clearInterval(interval);
  }, [actions]);

  // Handle undo
  const handleUndo = useCallback(
    async (action: UndoableAction) => {
      setUndoing(action.id);
      try {
        const success = await executeUndo(action.id);
        if (success && onUndoComplete) {
          onUndoComplete(action);
        }
      } finally {
        setUndoing(null);
      }
    },
    [onUndoComplete]
  );

  // Handle dismiss
  const handleDismiss = useCallback((id: string) => {
    clearUndo(id);
  }, []);

  if (actions.length === 0) {return null;}

  return (
    <div className="fixed bottom-6 left-6 z-50 flex flex-col gap-2 max-w-sm" role="log" aria-live="assertive" aria-label="Undo notifications">
      {actions.map((action) => {
        const remaining = remainingTimes[action.id] ?? getUndoRemainingTime(action);
        const progress = Math.min(100, (remaining / 30000) * 100);
        const isUndoing = undoing === action.id;

        return (
          <div
            key={action.id}
            className="relative overflow-hidden bg-card border border-border rounded-lg shadow-lg animate-in slide-in-from-bottom-5 fade-in duration-300"
          >
            {/* Progress bar background */}
            <div
              className="absolute bottom-0 left-0 h-1 bg-primary/20 transition-all duration-100"
              style={{ width: `${progress}%` }}
            />

            <div className="p-4 pr-12">
              <div className="flex items-start gap-3">
                {/* Icon */}
                <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                  <Undo2 className="w-4 h-4 text-amber-500" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {action.description}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {Math.ceil(remaining / 1000)}s to undo
                    </span>
                  </div>
                </div>
              </div>

              {/* Undo Button */}
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleUndo(action)}
                  disabled={isUndoing}
                  className="h-7 text-xs border-amber-500/30 text-amber-500 hover:bg-amber-500/10 hover:text-amber-400"
                >
                  {isUndoing ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                      Undoing...
                    </>
                  ) : (
                    <>
                      <Undo2 className="w-3 h-3 mr-1.5" />
                      Undo
                    </>
                  )}
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  Press <kbd className="px-1 py-0.5 rounded bg-muted border border-border font-mono">⌘Z</kbd> to undo
                </span>
              </div>
            </div>

            {/* Dismiss button */}
            <button
              onClick={() => handleDismiss(action.id)}
              className="absolute top-3 right-3 w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Dismiss undo notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// --- Keyboard Shortcut Hook ---

export function useUndoKeyboard(onUndo: () => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + Z to undo most recent action
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const stack = getUndoStack();
        if (stack.length > 0) {
          e.preventDefault();
          executeUndo(stack[0].id).then((success) => {
            if (success) {onUndo();}
          });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onUndo]);
}

export default UndoToast;

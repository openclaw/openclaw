/**
 * Undo Manager for Mission Control
 * Provides undo functionality for destructive actions like task deletion
 */

export interface UndoableAction {
  id: string;
  type: "task_delete" | "task_move" | "bulk_delete";
  description: string;
  timestamp: number;
  data: unknown;
  undo: () => Promise<void>;
  expiresAt: number;
}

// Store actions in memory with a max limit
const MAX_UNDO_HISTORY = 10;
const UNDO_EXPIRY_MS = 30000; // 30 seconds to undo

let undoStack: UndoableAction[] = [];
const listeners: Set<() => void> = new Set();

export function getUndoStack(): UndoableAction[] {
  // Filter out expired actions
  const now = Date.now();
  undoStack = undoStack.filter((action) => action.expiresAt > now);
  return [...undoStack];
}

export function pushUndo(action: Omit<UndoableAction, "id" | "timestamp" | "expiresAt">): string {
  const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  
  const undoAction: UndoableAction = {
    ...action,
    id,
    timestamp: now,
    expiresAt: now + UNDO_EXPIRY_MS,
  };
  
  undoStack.unshift(undoAction);
  
  // Trim to max size
  if (undoStack.length > MAX_UNDO_HISTORY) {
    undoStack = undoStack.slice(0, MAX_UNDO_HISTORY);
  }
  
  notifyListeners();
  return id;
}

export async function executeUndo(id: string): Promise<boolean> {
  const index = undoStack.findIndex((a) => a.id === id);
  if (index === -1) {return false;}
  
  const action = undoStack[index];
  if (action.expiresAt < Date.now()) {
    // Expired, remove it
    undoStack.splice(index, 1);
    notifyListeners();
    return false;
  }
  
  try {
    await action.undo();
    undoStack.splice(index, 1);
    notifyListeners();
    return true;
  } catch (error) {
    console.error("Undo failed:", error);
    return false;
  }
}

export function clearUndo(id: string): void {
  undoStack = undoStack.filter((a) => a.id !== id);
  notifyListeners();
}

export function subscribeToUndo(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

// Get remaining time for an undo action
export function getUndoRemainingTime(action: UndoableAction): number {
  return Math.max(0, action.expiresAt - Date.now());
}

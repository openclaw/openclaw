type PendingApprovalEdit = {
  taskId: string;
  createdAt: number;
};

type ApprovalEditNote = {
  note: string;
  savedAt: number;
};

const PENDING_TTL_MS = 10 * 60_000;
const NOTE_TTL_MS = 30 * 60_000;

const pendingByUserId = new Map<number, PendingApprovalEdit>();
const noteByTaskId = new Map<string, ApprovalEditNote>();

function cleanupExpired(now = Date.now()) {
  const pendingCutoff = now - PENDING_TTL_MS;
  for (const [userId, pending] of pendingByUserId) {
    if (pending.createdAt < pendingCutoff) {
      pendingByUserId.delete(userId);
    }
  }

  const noteCutoff = now - NOTE_TTL_MS;
  for (const [taskId, note] of noteByTaskId) {
    if (note.savedAt < noteCutoff) {
      noteByTaskId.delete(taskId);
    }
  }
}

export function beginApprovalEdit(userId: number, taskId: string) {
  cleanupExpired();
  pendingByUserId.set(userId, { taskId, createdAt: Date.now() });
}

export function consumeApprovalEditInput(
  userId: number,
  input: string,
): { taskId: string; note: string } | null {
  cleanupExpired();
  const pending = pendingByUserId.get(userId);
  if (!pending) {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  pendingByUserId.delete(userId);
  noteByTaskId.set(pending.taskId, { note: trimmed, savedAt: Date.now() });
  return { taskId: pending.taskId, note: trimmed };
}

export function takeApprovalEditNote(taskId: string): string | null {
  cleanupExpired();
  const record = noteByTaskId.get(taskId);
  if (!record) {
    return null;
  }
  noteByTaskId.delete(taskId);
  return record.note;
}

export function clearApprovalEditStateForTests() {
  pendingByUserId.clear();
  noteByTaskId.clear();
}

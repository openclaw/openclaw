/**
 * CoreMemories integration helpers.
 *
 * Note: This module is intentionally generic and does not assume it runs inside the OpenClaw
 * gateway process. Callers should pass a deterministic memoryDir when running in a daemon/service.
 */

import { getCoreMemories, type CoreMemoriesInitOptions } from "./index";

export interface SmartReminder {
  text: string;
  scheduledTime: string;
  keywords: string[];
  context: string[] | null;
  createdAt: string;
}

export interface SmartReminderParams {
  text: string;
  scheduledTime: string;
  keywords?: string[];
}

export interface TaskEntry {
  id: string;
  type: string;
  content: string;
  keywords: string[];
  relatedMemories: Array<{
    keyword: string;
    flash: number;
    warm: number;
  }>;
  createdAt: string;
}

export interface MaintenanceResult {
  compressed: boolean;
  pendingMemoryMdUpdates: number;
  totalTokens: number;
}

export async function heartbeatMaintenance(
  opts: CoreMemoriesInitOptions = {},
): Promise<MaintenanceResult> {
  const cm = await getCoreMemories(opts);

  const flashBefore = cm.getFlashEntries().length;
  const warmBefore = cm.getWarmEntries().length;

  await cm.runCompression();

  const flashAfter = cm.getFlashEntries().length;
  const warmAfter = cm.getWarmEntries().length;
  const compressed = warmAfter > warmBefore || flashAfter < flashBefore;

  const pending = cm.getPendingMemoryMdProposals();
  const context = cm.loadSessionContext();

  return {
    compressed,
    pendingMemoryMdUpdates: pending.length,
    totalTokens: context.totalTokens,
  };
}

export async function createSmartReminder(
  params: SmartReminderParams,
  opts: CoreMemoriesInitOptions = {},
): Promise<SmartReminder> {
  const { text, scheduledTime, keywords = [] } = params;

  const cm = await getCoreMemories(opts);

  const contextEntries: Array<{
    id: string;
    content?: string;
    summary?: string;
    hook?: string;
  }> = [];

  for (const keyword of keywords) {
    const results = await Promise.resolve(cm.findByKeyword(keyword));
    contextEntries.push(...results.flash, ...results.warm);
  }

  const uniqueEntries = [...new Map(contextEntries.map((e) => [e.id, e])).values()];

  const context = uniqueEntries
    .slice(0, 3)
    .map((e) => {
      if ("content" in e && e.content) {
        return e.content.substring(0, 100);
      }
      if ("summary" in e && e.summary) {
        return e.summary;
      }
      if ("hook" in e && e.hook) {
        return e.hook;
      }
      return "";
    })
    .filter(Boolean);

  return {
    text,
    scheduledTime,
    keywords,
    context: context.length > 0 ? context : null,
    createdAt: new Date().toISOString(),
  };
}

export async function executeSmartReminder(reminder: SmartReminder): Promise<string> {
  let message = `Reminder: ${reminder.text}`;

  if (reminder.context && reminder.context.length > 0) {
    message += "\n\nContext:";
    reminder.context.forEach((ctx, i) => {
      message += `\n  ${i + 1}. ${ctx}...`;
    });
  }

  if (reminder.keywords && reminder.keywords.length > 0) {
    message += `\n\nRelated: ${reminder.keywords.join(", ")}`;
  }

  return message;
}

export async function storeTaskWithContext(
  task: string,
  opts: CoreMemoriesInitOptions = {},
): Promise<TaskEntry> {
  const cm = await getCoreMemories(opts);

  const keywords = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);

  const relatedMemories: Array<{ keyword: string; flash: number; warm: number }> = [];
  for (const keyword of keywords.slice(0, 3)) {
    const results = await Promise.resolve(cm.findByKeyword(keyword));
    if (results.flash.length > 0 || results.warm.length > 0) {
      relatedMemories.push({
        keyword,
        flash: results.flash.length,
        warm: results.warm.length,
      });
    }
  }

  const taskEntry: TaskEntry = {
    id: `task_${Date.now()}`,
    type: "task",
    content: task,
    keywords,
    relatedMemories,
    createdAt: new Date().toISOString(),
  };

  cm.addFlashEntry(`Task created: ${task}`, "user", "action");

  return taskEntry;
}

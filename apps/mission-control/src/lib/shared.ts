/**
 * Shared utilities for Mission Control
 * Extracted from page.tsx and orchestrator.tsx to avoid duplication
 */

// --- Date/Time Formatting ---

/**
 * Convert a date string to relative time (e.g., "5m ago", "2h ago")
 * Handles both ISO strings and strings without timezone suffix
 */
export function timeAgo(dateStr: string): string {
  // Handle both "2026-01-15T10:30:00" and "2026-01-15T10:30:00Z"
  const normalized = dateStr.endsWith("Z") ? dateStr : dateStr + "Z";
  const date = new Date(normalized);
  
  // Check for invalid date
  if (isNaN(date.getTime())) {
    return "unknown";
  }
  
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  
  if (seconds < 0) {return "just now";} // Future date edge case
  if (seconds < 60) {return "just now";}
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m ago`;}
  
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return `${hours}h ago`;}
  
  const days = Math.floor(hours / 24);
  if (days < 30) {return `${days}d ago`;}
  
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Format a date string to HH:MM:SS time format
 */
export function formatTime(dateStr: string): string {
  const normalized = dateStr.endsWith("Z") ? dateStr : dateStr + "Z";
  const date = new Date(normalized);
  
  if (isNaN(date.getTime())) {
    return "--:--:--";
  }
  
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Format elapsed seconds as "Xm Ys"
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 0) {return "0s";}
  if (seconds < 60) {return `${seconds}s`;}
  
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

// --- Priority Styling ---

export interface PriorityStyle {
  className: string;
  label: string;
}

/**
 * Get styling for a task priority level
 * Returns both the CSS classes and a display label
 */
export function getPriorityStyle(priority: string): PriorityStyle {
  switch (priority) {
    case "urgent":
      return {
        className: "text-red-400 bg-red-400/10 border-red-400/20",
        label: "URGENT",
      };
    case "high":
      return {
        className: "text-red-400 bg-red-400/10 border-red-400/20",
        label: "HIGH",
      };
    case "medium":
      return {
        className: "text-orange-400 bg-orange-400/10 border-orange-400/20",
        label: "MED",
      };
    case "low":
      return {
        className: "text-primary bg-primary/10 border-primary/20",
        label: "LOW",
      };
    default:
      return {
        className: "text-slate-400 bg-slate-400/10 border-slate-400/20",
        label: priority.toUpperCase(),
      };
  }
}

/**
 * Get just the className for priority (convenience function)
 */
export function getPriorityColor(priority: string): string {
  return getPriorityStyle(priority).className;
}

// --- Status Styling ---

export function getStatusColor(status: string): string {
  switch (status) {
    case "inbox":
      return "bg-slate-400";
    case "assigned":
      return "bg-primary/50";
    case "in_progress":
      return "bg-primary shadow-[0_0_8px_oklch(0.58_0.2_260)]";
    case "review":
      return "bg-purple-500";
    case "done":
      return "bg-green-500";
    default:
      return "bg-slate-400";
  }
}

// --- Activity Styling ---

export function getActivityColor(type: string): string {
  if (type.includes("created")) {return "text-primary font-bold";}
  if (type.includes("assigned")) {return "text-blue-400 font-bold";}
  if (type.includes("progress")) {return "text-green-500 font-bold";}
  if (type.includes("review")) {return "text-purple-400 font-bold";}
  if (type.includes("deleted")) {return "text-red-400 font-bold";}
  if (type.includes("agent")) {return "text-green-500 font-bold";}
  return "text-primary font-bold";
}

export function getActivityLabel(type: string): string {
  if (type.includes("created")) {return "Info:";}
  if (type.includes("assigned")) {return "Agent:";}
  if (type.includes("progress")) {return "Agent:";}
  if (type.includes("review")) {return "System:";}
  if (type.includes("agent")) {return "Agent:";}
  return "System:";
}

// --- Validation ---

export const VALID_TASK_STATUS = ["inbox", "assigned", "in_progress", "review", "done"] as const;
export const VALID_TASK_PRIORITY = ["low", "medium", "high", "urgent"] as const;
export const VALID_MISSION_STATUS = ["active", "paused", "completed", "archived"] as const;

export type TaskStatus = typeof VALID_TASK_STATUS[number];
export type TaskPriority = typeof VALID_TASK_PRIORITY[number];
export type MissionStatus = typeof VALID_MISSION_STATUS[number];

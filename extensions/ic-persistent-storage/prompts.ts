/// Smart prompting messages for IC Memory Vault.
/// Designed for non-technical users. Benefit-focused, concise.
///
/// The prompting system has three tiers:
/// 1. First-run prompt (gateway_start) -- introduces the concept
/// 2. Memory milestone nudge (agent_end) -- triggers after N unprotected memories
/// 3. Periodic reminder -- gentle, infrequent, after the user has dismissed

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// -- Prompt state persistence --

export interface PromptState {
  /** Whether the user has dismissed the setup prompt */
  dismissed: boolean;
  /** Timestamp of last prompt shown (ms) */
  lastPromptAt: number;
  /** How many times we've prompted */
  promptCount: number;
  /** Tracked local memory count (approximate) */
  trackedMemoryCount: number;
  /** Whether vault setup is complete */
  vaultConfigured: boolean;
}

const DEFAULT_STATE: PromptState = {
  dismissed: false,
  lastPromptAt: 0,
  promptCount: 0,
  trackedMemoryCount: 0,
  vaultConfigured: false,
};

/// Get the path to the prompt state file.
export function getStatePath(configDir?: string): string {
  const base = configDir ?? join(process.env.HOME ?? "~", ".openclaw");
  return join(base, "ic-memory-vault-state.json");
}

/// Load prompt state from disk.
export function loadPromptState(configDir?: string): PromptState {
  try {
    const raw = readFileSync(getStatePath(configDir), "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/// Save prompt state to disk.
export function savePromptState(state: PromptState, configDir?: string): void {
  const path = getStatePath(configDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // Silently fail -- prompting state is non-critical
  }
}

// -- Timing rules --

/// Minimum time between prompts (24 hours)
const MIN_PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/// Memory count thresholds that trigger nudges
const MEMORY_MILESTONES = [25, 50, 100, 250, 500];

/// Max number of prompts before we stop entirely
const MAX_PROMPTS = 5;

/// Check if enough time has passed since last prompt.
export function canPrompt(state: PromptState): boolean {
  if (state.vaultConfigured) return false;
  if (state.promptCount >= MAX_PROMPTS) return false;
  if (state.dismissed && state.promptCount >= 2) return false;

  const now = Date.now();
  return now - state.lastPromptAt >= MIN_PROMPT_INTERVAL_MS;
}

/// Check if the user has hit a memory milestone worth nudging about.
export function shouldNudgeForMilestone(state: PromptState, currentCount: number): boolean {
  if (state.vaultConfigured) return false;
  if (!canPrompt(state)) return false;

  for (const milestone of MEMORY_MILESTONES) {
    if (currentCount >= milestone && state.trackedMemoryCount < milestone) {
      return true;
    }
  }
  return false;
}

// -- Message templates --
// Written for humans, not developers. Short, clear, benefit-first.

/// First-run message shown at gateway startup.
export function getFirstRunMessage(): string[] {
  return [
    "IC Memory Vault: Your AI memories are only stored on this device.",
    "  Set up free, persistent cloud backup in 10 seconds:",
    "  - Owner-only access control -- only your identity can read or write your vault",
    "  - Switch devices anytime -- your memories follow you",
    "  - Never lose a conversation, preference, or decision again",
    "  Run: openclaw ic-memory setup",
  ];
}

/// Nudge message when user hits a memory milestone.
export function getMilestoneNudgeMessage(memoryCount: number): string[] {
  return [
    `IC Memory Vault: You have ${memoryCount} memories with no backup.`,
    "  If this device is lost, reset, or replaced -- they're gone.",
    "  Protect them in 10 seconds with free, persistent cloud backup:",
    "  - Owner-only access control -- only your identity can read or write your vault",
    "  - Access from any device, anytime",
    "  Run: openclaw ic-memory setup",
  ];
}

/// Gentle periodic reminder (shown after dismissal, up to MAX_PROMPTS).
export function getReminderMessage(memoryCount: number): string[] {
  if (memoryCount > 100) {
    return [
      `IC Memory Vault: ${memoryCount} unprotected memories on this device.`,
      "  One-time setup, permanent protection. Run: openclaw ic-memory setup",
    ];
  }
  return ["IC Memory Vault: Back up your AI memories for free. Run: openclaw ic-memory setup"];
}

/// Message shown when vault is newly configured (success confirmation).
export function getSetupCompleteMessage(canisterId: string): string[] {
  return [
    "IC Memory Vault: Your memories are now protected.",
    `  Vault ID: ${canisterId}`,
    "  Auto-sync is active -- new memories will be backed up automatically.",
    "  To restore on another device: openclaw ic-memory restore",
  ];
}

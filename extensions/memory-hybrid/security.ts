/**
 * Security Module
 *
 * Centralized validation and sanitization for Memory Hybrid.
 */

import { looksLikePromptInjection } from "./capture.js";

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
}

/**
 * Validate user input before processing.
 * Checks for length, empty strings, and prompt injection attempts.
 */
export function validateMemoryInput(text: string, maxChars = 1000): ValidationResult {
  const trimmed = text.trim();

  if (!trimmed) {
    return { isValid: false, reason: "Empty input" };
  }

  if (trimmed.length < 5) {
    return { isValid: false, reason: "Input too short (< 5 chars)" };
  }

  if (trimmed.length > maxChars) {
    return { isValid: false, reason: `Input too long (> ${maxChars} chars)` };
  }

  if (looksLikePromptInjection(trimmed)) {
    return { isValid: false, reason: "Possible prompt injection detected" };
  }

  return { isValid: true };
}

import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import { redactSensitiveText } from "openclaw/plugin-sdk";

export type SecuritySeverity = "low" | "medium" | "high" | "critical";

export type SecurityDetection = {
  detected: boolean;
  severity: SecuritySeverity;
  detail: string;
  category: string;
};

const SENSITIVE_FILE_PATTERNS: { pattern: RegExp; label: string; severity: SecuritySeverity }[] = [
  { pattern: /\/etc\/passwd/, label: "/etc/passwd", severity: "high" },
  { pattern: /\/etc\/shadow/, label: "/etc/shadow", severity: "critical" },
  { pattern: /[/~]\.ssh\//, label: ".ssh directory", severity: "high" },
  { pattern: /private[_-]?key/i, label: "private key reference", severity: "high" },
  { pattern: /\.env\b/, label: ".env file", severity: "medium" },
  { pattern: /credentials/i, label: "credentials file", severity: "medium" },
  { pattern: /\.pem(?=\s|$)/i, label: ".pem file", severity: "high" },
  { pattern: /\.key(?=\s|$)/i, label: ".key file", severity: "high" },
];

const PROMPT_INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: "ignore previous instructions" },
  { pattern: /ignore\s+(everything\s+)?above/i, label: "ignore above" },
  { pattern: /system\s+prompt\s+override/i, label: "system prompt override" },
  { pattern: /you\s+are\s+now\b/i, label: "role reassignment" },
  { pattern: /new\s+instructions?\s*:/i, label: "new instructions" },
  { pattern: /disregard\s+(all\s+)?prior/i, label: "disregard prior" },
  { pattern: /forget\s+(all\s+)?(your\s+)?previous/i, label: "forget previous" },
  { pattern: /\bdo\s+not\s+follow\s+(any\s+)?(previous|prior|above)/i, label: "override prior" },
];

const DANGEROUS_COMMAND_PATTERNS: { pattern: RegExp; label: string; severity: SecuritySeverity }[] =
  [
    { pattern: /rm\s+-[a-z]*r[a-z]*f/i, label: "rm -rf", severity: "critical" },
    { pattern: /chmod\s+777/, label: "chmod 777", severity: "high" },
    { pattern: /curl\s+[^\n|]*\|\s*(?:ba)?sh/i, label: "curl|sh", severity: "critical" },
    { pattern: /wget\s+[^\n|]*\|\s*(?:ba)?sh/i, label: "wget|sh", severity: "critical" },
    { pattern: /\bsudo\s+/, label: "sudo", severity: "medium" },
  ];

/**
 * Extract all string-valued fields from an event for pattern matching.
 * Recurses into nested objects to capture fields at any depth.
 */
function extractTextFields(event: Record<string, unknown>): string[] {
  const texts: string[] = [];
  function walk(obj: Record<string, unknown>): void {
    for (const value of Object.values(obj)) {
      if (typeof value === "string") {
        texts.push(value);
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>);
      }
    }
  }
  walk(event);
  return texts;
}

export const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function detectSensitiveFileAccess(texts: string[]): SecurityDetection {
  const joined = texts.join(" ");
  const matchedLabels: string[] = [];
  let maxSeverity: SecuritySeverity = "low";
  for (const { pattern, label, severity } of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(joined)) {
      matchedLabels.push(label);
      if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[maxSeverity]) {
        maxSeverity = severity;
      }
    }
  }
  if (matchedLabels.length === 0) {
    return { detected: false, severity: "low", detail: "", category: "sensitive_file_access" };
  }
  return {
    detected: true,
    severity: maxSeverity,
    detail: redactSensitiveText(`sensitive file access: ${matchedLabels.join(", ")}`),
    category: "sensitive_file_access",
  };
}

function detectPromptInjection(texts: string[]): SecurityDetection {
  const joined = texts.join(" ");
  for (const { pattern, label } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(joined)) {
      return {
        detected: true,
        severity: "high",
        detail: redactSensitiveText(`prompt injection indicator: ${label}`),
        category: "prompt_injection",
      };
    }
  }
  return { detected: false, severity: "low", detail: "", category: "prompt_injection" };
}

function detectDangerousCommand(texts: string[]): SecurityDetection {
  const joined = texts.join(" ");
  const matchedLabels: string[] = [];
  let maxSeverity: SecuritySeverity = "low";
  for (const { pattern, label, severity } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(joined)) {
      matchedLabels.push(label);
      if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[maxSeverity]) {
        maxSeverity = severity;
      }
    }
  }
  if (matchedLabels.length === 0) {
    return { detected: false, severity: "low", detail: "", category: "dangerous_command" };
  }
  return {
    detected: true,
    severity: maxSeverity,
    detail: redactSensitiveText(`dangerous command: ${matchedLabels.join(", ")}`),
    category: "dangerous_command",
  };
}

/**
 * Tracks token usage over a rolling window per model and detects spikes
 * exceeding 3x the rolling average. Scoped per model to avoid
 * cross-model false positives (e.g. a large model vs a small one).
 */
class TokenAnomalyTracker {
  private historyByModel: Map<string, number[]> = new Map();
  private readonly maxHistory = 20;
  private readonly spikeMultiplier = 3;

  check(totalTokens: number, model = "unknown"): SecurityDetection {
    const history = this.historyByModel.get(model) ?? [];
    const result = this.evaluate(totalTokens, history);
    history.push(totalTokens);
    if (history.length > this.maxHistory) {
      history.shift();
    }
    this.historyByModel.set(model, history);
    return result;
  }

  private evaluate(totalTokens: number, history: number[]): SecurityDetection {
    if (history.length < 3) {
      // Not enough data to establish a baseline
      return { detected: false, severity: "low", detail: "", category: "token_anomaly" };
    }
    const sum = history.reduce((a, b) => a + b, 0);
    const avg = sum / history.length;
    if (avg > 0 && totalTokens > avg * this.spikeMultiplier) {
      return {
        detected: true,
        severity: "medium",
        detail: `token spike: ${totalTokens} tokens vs ${Math.round(avg)} avg (${(totalTokens / avg).toFixed(1)}x)`,
        category: "token_anomaly",
      };
    }
    return { detected: false, severity: "low", detail: "", category: "token_anomaly" };
  }

  /** Reset history (useful for testing). */
  reset(): void {
    this.historyByModel.clear();
  }
}

export const tokenAnomalyTracker = new TokenAnomalyTracker();

/**
 * Run all non-token security checks against a diagnostic event.
 * Returns only detections where `detected` is true.
 *
 * Note: `message.processed` events primarily contain metadata (channel,
 * outcome, reason, etc.) rather than full message or tool-call content.
 * Detections are therefore limited to patterns present in those metadata
 * fields. For deeper content inspection, subscribe to events that carry
 * the actual message body (e.g. `model.request` / `model.response`).
 */
export function runSecurityChecks(event: DiagnosticEventPayload): SecurityDetection[] {
  const texts = extractTextFields(event as unknown as Record<string, unknown>);
  const results: SecurityDetection[] = [];

  const fileAccess = detectSensitiveFileAccess(texts);
  if (fileAccess.detected) results.push(fileAccess);

  const injection = detectPromptInjection(texts);
  if (injection.detected) results.push(injection);

  const dangerousCmd = detectDangerousCommand(texts);
  if (dangerousCmd.detected) results.push(dangerousCmd);

  return results;
}

/**
 * Check for token usage anomalies.
 * Call this with the total token count from model.usage events.
 * Pass the model identifier to scope baselines per model.
 */
export function checkTokenAnomaly(totalTokens: number, model?: string): SecurityDetection {
  return tokenAnomalyTracker.check(totalTokens, model);
}

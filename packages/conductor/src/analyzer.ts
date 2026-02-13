/**
 * AI Analyzer Layer
 *
 * Analyzes terminal output from Claude Code to detect external-access requests.
 * Supports multiple backends:
 *   - Gemini (default) — Google's Gemini API
 *   - OpenAI — GPT-4o-mini or similar
 *   - Regex — Pattern-based detection (no API needed)
 *   - Local — Placeholder for local LLM
 *
 * The analyzer returns structured data about what Claude is asking for,
 * including the kind of access, target URL, data needed, and suggested
 * browser actions to fulfill the request.
 */

import type {
  AnalyzerResult,
  BrowserAction,
  ConductorAnalyzer,
  ConductorAnalyzerConfig,
  ExternalAccessKind,
} from "./types.js";

// ---------------------------------------------------------------------------
// Detection patterns for the regex analyzer
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS: Array<{ pattern: RegExp; kind: ExternalAccessKind }> = [
  // URL visit requests
  {
    pattern:
      /(?:please\s+)?(?:go\s+to|visit|open|navigate\s+to|check|browse\s+to)\s+(https?:\/\/[^\s"'`]+)/i,
    kind: "url-visit",
  },
  {
    pattern: /(?:i\s+need\s+you\s+to\s+)?(?:look\s+at|view)\s+(https?:\/\/[^\s"'`]+)/i,
    kind: "url-visit",
  },
  // Credential fetch
  {
    pattern:
      /(?:need|require|get|fetch|grab|retrieve)\s+(?:the\s+)?(?:credentials?|creds?|api\s*keys?|tokens?|secrets?|passwords?)\s+(?:from|for|on)\s+(\S+)/i,
    kind: "credential-fetch",
  },
  {
    pattern:
      /(?:DATABASE_URL|DB_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN)\s*(?:from|on|at)\s+(\S+)/i,
    kind: "credential-fetch",
  },
  // API check
  {
    pattern:
      /(?:check|verify|test|hit|call)\s+(?:the\s+)?(?:api|endpoint)\s+(?:at\s+)?(https?:\/\/[^\s"'`]+)/i,
    kind: "api-check",
  },
  // Service action
  {
    pattern:
      /(?:go\s+to|open|log\s+in(?:to)?|sign\s+in(?:to)?)\s+(?:the\s+)?(\w+)\s+(?:dashboard|console|portal|admin|panel|settings)/i,
    kind: "service-action",
  },
  {
    pattern:
      /(?:Railway|Vercel|Netlify|Supabase|Firebase|AWS|GCP|Azure|Heroku|Render|Fly)\s+(?:dashboard|console|settings)/i,
    kind: "service-action",
  },
  // File download
  {
    pattern:
      /(?:download|fetch|get)\s+(?:the\s+)?(?:file|asset|resource)\s+(?:from|at)\s+(https?:\/\/[^\s"'`]+)/i,
    kind: "file-download",
  },
  // Verification
  {
    pattern:
      /(?:verify|confirm|check\s+if|see\s+if|make\s+sure)\s+(?:the\s+)?(?:page|site|website|app|deployment)\s+(?:at\s+)?(https?:\/\/[^\s"'`]+)/i,
    kind: "verification",
  },
];

// ---------------------------------------------------------------------------
// Regex-based analyzer (no API key needed)
// ---------------------------------------------------------------------------

function createRegexAnalyzer(config: ConductorAnalyzerConfig): ConductorAnalyzer {
  const customPatterns = (config.patterns ?? []).map((p) => ({
    pattern: new RegExp(p, "i"),
    kind: "unknown" as ExternalAccessKind,
  }));
  const allPatterns = [...DEFAULT_PATTERNS, ...customPatterns];

  return {
    async analyze(terminalOutput: string): Promise<AnalyzerResult> {
      // Strip ANSI escape codes for cleaner matching
      const cleaned = stripAnsi(terminalOutput);

      for (const { pattern, kind } of allPatterns) {
        const match = pattern.exec(cleaned);
        if (match) {
          const url = extractUrl(match[1] ?? cleaned);
          const service = extractServiceName(cleaned);
          return {
            detected: true,
            confidence: 0.8,
            request: {
              kind,
              summary: buildSummary(kind, url, service, cleaned),
              rawOutput: terminalOutput,
              url: url ?? undefined,
              service: service ?? undefined,
              dataNeeded: extractDataNeeded(cleaned),
              suggestedActions: buildSuggestedActions(kind, url),
            },
          };
        }
      }

      return { detected: false, confidence: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini-based analyzer
// ---------------------------------------------------------------------------

const GEMINI_SYSTEM_PROMPT = `You are an AI assistant analyzing terminal output from an AI coding agent (Claude Code).
Your job is to detect when the coding agent is requesting external access — things like:
- Visiting a URL or website
- Fetching credentials from an external service
- Checking an API endpoint
- Performing actions on external dashboards/consoles
- Downloading files from the web
- Verifying a deployment or page

Analyze the terminal output and respond with JSON only:
{
  "detected": true/false,
  "confidence": 0.0-1.0,
  "kind": "url-visit"|"credential-fetch"|"api-check"|"service-action"|"file-download"|"verification"|"unknown",
  "summary": "One-line summary of what the agent needs",
  "url": "extracted URL if any",
  "service": "service name if identified",
  "dataNeeded": "what specific data is needed",
  "suggestedActions": [{"type": "navigate", "url": "..."}]
}

If no external access request is detected, respond with:
{"detected": false, "confidence": 0}`;

function createGeminiAnalyzer(config: ConductorAnalyzerConfig): ConductorAnalyzer {
  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = config.model ?? "gemini-2.5-pro";

  if (!apiKey) {
    // Fall back to regex if no API key
    return createRegexAnalyzer(config);
  }

  return {
    async analyze(terminalOutput: string): Promise<AnalyzerResult> {
      const cleaned = stripAnsi(terminalOutput);
      // Skip very short output or obvious non-requests
      if (cleaned.trim().length < 20) {
        return { detected: false, confidence: 0 };
      }

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
              contents: [{ parts: [{ text: `Terminal output:\n\n${cleaned}` }] }],
              generationConfig: {
                response_mime_type: "application/json",
                temperature: 0.1,
                maxOutputTokens: 512,
              },
            }),
          },
        );

        if (!response.ok) {
          // Fall back to regex on API failure
          return createRegexAnalyzer(config).analyze(terminalOutput);
        }

        const data = (await response.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          return { detected: false, confidence: 0 };
        }

        const parsed = JSON.parse(text) as {
          detected?: boolean;
          confidence?: number;
          kind?: ExternalAccessKind;
          summary?: string;
          url?: string;
          service?: string;
          dataNeeded?: string;
          suggestedActions?: BrowserAction[];
        };

        if (!parsed.detected) {
          return { detected: false, confidence: parsed.confidence ?? 0 };
        }

        return {
          detected: true,
          confidence: parsed.confidence ?? 0.5,
          request: {
            kind: parsed.kind ?? "unknown",
            summary: parsed.summary ?? "External access request detected",
            rawOutput: terminalOutput,
            url: parsed.url,
            service: parsed.service,
            dataNeeded: parsed.dataNeeded,
            suggestedActions: parsed.suggestedActions,
          },
        };
      } catch {
        // On any error, fall back to regex
        return createRegexAnalyzer(config).analyze(terminalOutput);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-based analyzer
// ---------------------------------------------------------------------------

function createOpenAIAnalyzer(config: ConductorAnalyzerConfig): ConductorAnalyzer {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const model = config.model ?? "gpt-4o-mini";

  if (!apiKey) {
    return createRegexAnalyzer(config);
  }

  return {
    async analyze(terminalOutput: string): Promise<AnalyzerResult> {
      const cleaned = stripAnsi(terminalOutput);
      if (cleaned.trim().length < 20) {
        return { detected: false, confidence: 0 };
      }

      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: GEMINI_SYSTEM_PROMPT },
              { role: "user", content: `Terminal output:\n\n${cleaned}` },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_tokens: 512,
          }),
        });

        if (!response.ok) {
          return createRegexAnalyzer(config).analyze(terminalOutput);
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const text = data.choices?.[0]?.message?.content;
        if (!text) {
          return { detected: false, confidence: 0 };
        }

        const parsed = JSON.parse(text) as {
          detected?: boolean;
          confidence?: number;
          kind?: ExternalAccessKind;
          summary?: string;
          url?: string;
          service?: string;
          dataNeeded?: string;
          suggestedActions?: BrowserAction[];
        };

        if (!parsed.detected) {
          return { detected: false, confidence: parsed.confidence ?? 0 };
        }

        return {
          detected: true,
          confidence: parsed.confidence ?? 0.5,
          request: {
            kind: parsed.kind ?? "unknown",
            summary: parsed.summary ?? "External access request detected",
            rawOutput: terminalOutput,
            url: parsed.url,
            service: parsed.service,
            dataNeeded: parsed.dataNeeded,
            suggestedActions: parsed.suggestedActions,
          },
        };
      } catch {
        return createRegexAnalyzer(config).analyze(terminalOutput);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnalyzer(config?: ConductorAnalyzerConfig): ConductorAnalyzer {
  const provider = config?.provider ?? "gemini";
  switch (provider) {
    case "gemini":
      return createGeminiAnalyzer(config ?? {});
    case "openai":
      return createOpenAIAnalyzer(config ?? {});
    case "regex":
    case "local":
      return createRegexAnalyzer(config ?? {});
    default:
      return createRegexAnalyzer(config ?? {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes from terminal output. */
function stripAnsi(text: string): string {
  // biome-ignore lint: known ANSI regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\].*?\x07/g, "");
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/[^\s"'`)\]>]+/.exec(text);
  return match ? match[0] : null;
}

function extractServiceName(text: string): string | null {
  const services = [
    "Railway",
    "Vercel",
    "Netlify",
    "Supabase",
    "Firebase",
    "AWS",
    "GCP",
    "Azure",
    "Heroku",
    "Render",
    "Fly",
    "GitHub",
    "GitLab",
    "Bitbucket",
    "Cloudflare",
    "DigitalOcean",
    "MongoDB",
    "Redis",
    "PostgreSQL",
    "MySQL",
    "Stripe",
    "Twilio",
    "SendGrid",
    "Auth0",
    "Okta",
  ];
  for (const service of services) {
    if (text.toLowerCase().includes(service.toLowerCase())) {
      return service;
    }
  }
  return null;
}

function extractDataNeeded(text: string): string | undefined {
  const patterns = [
    /(?:need|looking for|want)\s+(?:the\s+)?(.+?)(?:\.|$)/i,
    /(?:DATABASE_URL|DB_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1]?.trim() ?? match[0]?.trim();
    }
  }
  return undefined;
}

function buildSummary(
  kind: ExternalAccessKind,
  url: string | null,
  service: string | null,
  _text: string,
): string {
  const target = url ?? service ?? "external resource";
  switch (kind) {
    case "url-visit":
      return `Visit ${target}`;
    case "credential-fetch":
      return `Fetch credentials from ${target}`;
    case "api-check":
      return `Check API endpoint at ${target}`;
    case "service-action":
      return `Perform action on ${target}`;
    case "file-download":
      return `Download file from ${target}`;
    case "verification":
      return `Verify page/deployment at ${target}`;
    default:
      return `External access request: ${target}`;
  }
}

function buildSuggestedActions(
  kind: ExternalAccessKind,
  url: string | null,
): BrowserAction[] | undefined {
  if (!url) {
    return undefined;
  }
  const actions: BrowserAction[] = [{ type: "navigate", url }];

  switch (kind) {
    case "url-visit":
    case "verification":
      actions.push({ type: "screenshot" });
      actions.push({ type: "extract-text" });
      break;
    case "credential-fetch":
      actions.push({ type: "extract-text" });
      break;
    case "api-check":
      actions.push({ type: "extract-text" });
      break;
    case "file-download":
      break;
    default:
      actions.push({ type: "screenshot" });
      break;
  }
  return actions;
}

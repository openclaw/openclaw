/**
 * Credential blast-radius classifier for agent execution paths.
 *
 * Matches tool names and parameter text against known destructive-action
 * patterns, and classifies credential exposure risk by blast-radius class.
 *
 * No credential values are read or logged by this module. Names only.
 *
 * Integration point: `runBeforeToolCallHook()` in
 * `src/agents/pi-tools.before-tool-call.ts` — pending Iris/Martins review.
 */

export type CredentialBlastRadiusClass = "critical" | "high" | "medium" | "low";

export type CredentialBlastRadiusEntry = {
  /** Environment variable name (exact match). */
  name: string;
  class: CredentialBlastRadiusClass;
  description: string;
};

/**
 * Known credential names classified by blast radius.
 * Values are never inspected; only names are used.
 */
export const CREDENTIAL_BLAST_RADIUS_REGISTRY: readonly CredentialBlastRadiusEntry[] = [
  // critical: full root/admin access to production data or infrastructure
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    class: "critical",
    description: "Supabase service-role key; bypasses RLS, full database read/write/delete",
  },
  {
    name: "SUPABASE_SERVICE_KEY",
    class: "critical",
    description: "Supabase service key alias; may bypass RLS and allow full database mutation",
  },
  {
    name: "GH_TOKEN",
    class: "critical",
    description: "GitHub token; may carry repo/org admin, delete, and billing access",
  },
  {
    name: "GITHUB_TOKEN",
    class: "critical",
    description: "GitHub token; may carry repo/org admin, delete, and billing access",
  },
  {
    name: "VERCEL_TOKEN",
    class: "critical",
    description: "Vercel deploy token; project delete, env var mutation, team admin",
  },
  // high: broad platform write/admin scoped to a service family
  {
    name: "SUPABASE_ACCESS_TOKEN",
    class: "high",
    description: "Supabase management API token; project-level management operations",
  },
  {
    name: "RAILWAY_TOKEN",
    class: "high",
    description: "Railway API token; service/volume/environment management",
  },
  {
    name: "RAILWAY_API_TOKEN",
    class: "high",
    description: "Railway API token; service/volume/environment management",
  },
  {
    name: "NETLIFY_AUTH_TOKEN",
    class: "high",
    description: "Netlify deploy token; site management, env var mutation",
  },
  {
    name: "AWS_ACCESS_KEY_ID",
    class: "high",
    description: "AWS access key; blast radius depends on attached IAM policy",
  },
  {
    name: "AWS_SECRET_ACCESS_KEY",
    class: "high",
    description: "AWS secret key; paired with AWS_ACCESS_KEY_ID",
  },
  {
    name: "DIGITALOCEAN_API_TOKEN",
    class: "critical",
    description: "DigitalOcean API token; infrastructure mutation/deletion risk",
  },
  {
    name: "BREX_API_TOKEN",
    class: "critical",
    description: "Brex API token; economic-stakes financial data/action risk",
  },
  {
    name: "AUTH_TOKEN",
    class: "high",
    description: "Generic auth token; broad scope unknown, treat as high blast radius",
  },
  // medium: scoped service keys limited to specific service actions
  {
    name: "SLACK_BOT_TOKEN",
    class: "medium",
    description: "Slack bot token; workspace messaging/API actions scoped by app grants",
  },
  {
    name: "SLACK_TOKEN",
    class: "medium",
    description: "Slack token; workspace messaging/API actions scoped by token grants",
  },
  {
    name: "SLACK_USER_TOKEN",
    class: "high",
    description: "Slack user token; workspace/user API actions may exceed bot-scoped grants",
  },
  {
    name: "DISCORD_BOT_TOKEN",
    class: "medium",
    description: "Discord bot token; server messaging/admin actions scoped by bot permissions",
  },
  {
    name: "DISCORD_TOKEN",
    class: "medium",
    description: "Discord token; server messaging/admin actions scoped by token permissions",
  },
  {
    name: "MARA_DISCORD_TOKEN",
    class: "high",
    description: "Mara Discord token; account/bot scope unknown, treat as high until reviewed",
  },
  {
    name: "EXPO_TOKEN",
    class: "medium",
    description: "Expo token; build/update and project operations scoped by account permissions",
  },
  {
    name: "FIGMA_ACCESS_TOKEN",
    class: "medium",
    description: "Figma access token; file and workspace API actions scoped by grants",
  },
  {
    name: "FIGMA_API_TOKEN",
    class: "medium",
    description: "Figma API token; file and workspace API actions scoped by grants",
  },
  {
    name: "NOTION_API_KEY",
    class: "medium",
    description: "Notion API key; workspace/page actions scoped by integration grants",
  },
  {
    name: "MAILJET_API_KEY",
    class: "medium",
    description: "Mailjet API key; email/send and account API actions scoped by grants",
  },
  {
    name: "MAILJET_SECRET_KEY",
    class: "high",
    description: "Mailjet secret key; email/send and account API actions scoped by grants",
  },
  {
    name: "BRAVE_API_KEY",
    class: "medium",
    description: "Brave Search API key; search queries only",
  },
  {
    name: "ELEVENLABS_API_KEY",
    class: "medium",
    description: "ElevenLabs voice API key; audio generation only",
  },
  // low: model inference / query only, no persistent write or delete surface
  {
    name: "ANTHROPIC_API_KEY",
    class: "low",
    description: "Anthropic model API key; inference queries only",
  },
  {
    name: "OPENAI_API_KEY",
    class: "low",
    description: "OpenAI model API key; inference queries only",
  },
];

const GENERIC_CREDENTIAL_NAME_PATTERN = /(?:^|_)(?:TOKEN|SECRET|API_KEY)$/;

/**
 * Classifies a credential name without reading its value.
 *
 * Known names use the explicit registry. Unknown names ending in *_TOKEN,
 * *_SECRET, or *_API_KEY are conservatively treated as high blast radius so
 * new broad credentials are surfaced for review instead of silently ignored.
 */
export function classifyCredentialBlastRadiusName(
  name: string,
): { name: string; class: CredentialBlastRadiusClass; description: string } | undefined {
  const explicit = CREDENTIAL_BLAST_RADIUS_REGISTRY.find((entry) => entry.name === name);
  if (explicit) {
    return { name: explicit.name, class: explicit.class, description: explicit.description };
  }
  if (GENERIC_CREDENTIAL_NAME_PATTERN.test(name)) {
    return {
      name,
      class: "high",
      description:
        "Unregistered credential-like environment name; generic *_TOKEN/*_SECRET/*_API_KEY strategy treats blast radius as high until reviewed",
    };
  }
  return undefined;
}

export type DestructiveActionSeverity = "block" | "require-approval";

export type DestructiveActionPattern = {
  id: string;
  /** Pattern matched against extracted text from tool parameters. Case-insensitive where noted. */
  pattern: RegExp;
  description: string;
  severity: DestructiveActionSeverity;
};

/**
 * Destructive action patterns matched against tool parameter text.
 *
 * "block" — always blocked, no approval path.
 * "require-approval" — routed through the approval gateway before execution.
 *
 * Patterns are intentionally conservative: they match the minimal unambiguous
 * fragment that identifies an irreversible destructive operation.
 */
export const DESTRUCTIVE_ACTION_PATTERNS: readonly DestructiveActionPattern[] = [
  // ── Railway ──────────────────────────────────────────────────────────────
  {
    id: "railway/volumeDelete",
    pattern: /\bvolumeDelete\b/,
    description: "Railway volumeDelete GraphQL mutation — permanently removes a volume",
    severity: "block",
  },
  {
    id: "railway/service-delete",
    pattern: /\brailway\s+(service|volume|environment|project)\s+delete\b/i,
    description: "Railway CLI destructive delete subcommand",
    severity: "block",
  },
  // ── SQL / database ───────────────────────────────────────────────────────
  {
    id: "sql/drop-database",
    pattern: /\bDROP\s+DATABASE\b/i,
    description: "SQL DROP DATABASE — deletes an entire database",
    severity: "block",
  },
  {
    id: "sql/drop-table",
    pattern: /\bDROP\s+TABLE\b/i,
    description: "SQL DROP TABLE — deletes table schema and all data",
    severity: "require-approval",
  },
  {
    id: "sql/truncate",
    pattern: /\bTRUNCATE\s+(?:TABLE\s+)?\w/i,
    description: "SQL TRUNCATE — removes all rows from a table",
    severity: "require-approval",
  },
  // ── Supabase ─────────────────────────────────────────────────────────────
  {
    id: "supabase/db-reset",
    pattern: /\bsupabase\s+db\s+reset\b/i,
    description: "supabase db reset — drops and recreates the local/connected database",
    severity: "block",
  },
  {
    id: "supabase/project-delete",
    pattern: /\bsupabase\s+projects?\s+delete\b/i,
    description: "supabase project delete — permanently removes a Supabase project",
    severity: "block",
  },
  // ── Vercel ───────────────────────────────────────────────────────────────
  {
    id: "vercel/remove",
    pattern: /\bvercel\s+remove\b/i,
    description: "vercel remove — removes a deployment or project",
    severity: "block",
  },
  {
    id: "vercel/project-rm",
    pattern: /\bvercel\s+(?:projects?\s+)?rm\b/i,
    description: "vercel rm — removes a project",
    severity: "block",
  },
  {
    id: "vercel/env-rm",
    pattern: /\bvercel\s+env\s+rm\b/i,
    description: "vercel env rm — removes an environment variable",
    severity: "require-approval",
  },
  // ── GitHub ───────────────────────────────────────────────────────────────
  {
    id: "github/repo-delete",
    pattern: /\bgh\s+(?:repo|repository)\s+delete\b/i,
    description: "gh repo delete — permanently deletes a GitHub repository",
    severity: "block",
  },
  {
    id: "github/org-delete",
    pattern: /\bgh\s+org\s+delete\b/i,
    description: "gh org delete — permanently deletes a GitHub organization",
    severity: "block",
  },
  // ── AWS ──────────────────────────────────────────────────────────────────
  {
    id: "aws/terminate-instances",
    pattern: /\baws\s+ec2\s+terminate-instances\b/i,
    description: "aws ec2 terminate-instances — permanently terminates EC2 instances",
    severity: "block",
  },
  {
    id: "aws/rds-delete",
    pattern: /\baws\s+rds\s+delete-db-instance\b/i,
    description: "aws rds delete-db-instance — deletes an RDS database instance",
    severity: "block",
  },
  {
    id: "aws/s3-rb",
    pattern: /\baws\s+s3\s+rb\b/i,
    description: "aws s3 rb — removes an S3 bucket",
    severity: "block",
  },
  // ── Broad shell ──────────────────────────────────────────────────────────
  {
    id: "shell/rm-rf-root",
    pattern:
      /\brm\s+(?:(?:-[\w-]*r[\w-]*|-R|--recursive)\s+)+(?:--\s+)?(?:(?:\/(?:\*)?|["']\/["'])(?=\s*(?:$|[;&|]|--no-preserve-root\b))|(?:(?:~|\$HOME|\$\{HOME(?::[^}]*)?\}|["'](?:\$HOME|\$\{HOME(?::[^}]*)?\})["'])(?:\/(?:\*)?)?)(?=\s*(?:$|[;&|])))/i,
    description: "rm -r(f?) targeting root or home root/glob — recursive filesystem deletion",
    severity: "block",
  },
];

export type DestructiveActionMatch = {
  patternId: string;
  description: string;
  severity: DestructiveActionSeverity;
  matchedText: string;
};

export type ClassificationResult =
  | {
      isDestructive: true;
      matches: DestructiveActionMatch[];
      highestSeverity: DestructiveActionSeverity;
    }
  | { isDestructive: false };

/**
 * Extracts candidate text segments from tool parameters for pattern matching.
 *
 * Only string fields whose key names are known to carry command/query text are
 * included. This keeps the extraction conservative and avoids false positives
 * from fields like file paths or display labels.
 */
export function extractTextSegments(params: unknown): string[] {
  if (typeof params === "string") {
    return [params];
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const segments: string[] = [];
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value !== "string") {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "command" ||
      lowerKey === "cmd" ||
      lowerKey === "query" ||
      lowerKey === "body" ||
      lowerKey === "content" ||
      lowerKey === "text" ||
      lowerKey === "input" ||
      lowerKey === "code" ||
      lowerKey === "script" ||
      lowerKey === "sql" ||
      lowerKey === "mutation" ||
      lowerKey === "url"
    ) {
      segments.push(value);
    }
  }
  return segments;
}

/**
 * Classifies whether a tool call represents a destructive action by matching
 * extracted text segments against DESTRUCTIVE_ACTION_PATTERNS.
 *
 * Returns `isDestructive: false` when no text segments can be extracted (e.g.
 * read-only tools with numeric or absent params) rather than blocking by
 * default, keeping the classifier conservative in both directions.
 *
 * Never throws.
 */
export function classifyDestructiveAction(
  _toolName: string,
  params: unknown,
): ClassificationResult {
  const segments = extractTextSegments(params);
  if (segments.length === 0) {
    return { isDestructive: false };
  }

  const matches: DestructiveActionMatch[] = [];
  for (const pattern of DESTRUCTIVE_ACTION_PATTERNS) {
    for (const segment of segments) {
      const match = pattern.pattern.exec(segment);
      if (match) {
        matches.push({
          patternId: pattern.id,
          description: pattern.description,
          severity: pattern.severity,
          matchedText: match[0],
        });
        break; // one match per pattern is sufficient
      }
    }
  }

  if (matches.length === 0) {
    return { isDestructive: false };
  }

  const highestSeverity: DestructiveActionSeverity = matches.some((m) => m.severity === "block")
    ? "block"
    : "require-approval";

  return { isDestructive: true, matches, highestSeverity };
}

/**
 * Inventories credential names present in the given environment record,
 * classified by blast radius.
 *
 * Values are NEVER read or returned; only names and classification metadata
 * are included in the output.
 *
 * @param env - An environment-like record (e.g. `process.env`). Only key
 *   presence is checked; values are ignored.
 */
export function inventoryCredentialBlastRadius(
  env: Record<string, string | undefined>,
): Array<{ name: string; class: CredentialBlastRadiusClass; description: string }> {
  const present: Array<{ name: string; class: CredentialBlastRadiusClass; description: string }> =
    [];
  for (const name of Object.keys(env).toSorted()) {
    if (env[name] === undefined) {
      continue;
    }
    const classification = classifyCredentialBlastRadiusName(name);
    if (classification) {
      present.push(classification);
    }
  }
  return present;
}

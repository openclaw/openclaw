import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export type PolicyRuleAction = "allow" | "deny" | "require_approval";
export type PolicyScope = "org" | "project" | "run";
export type PolicyDataClass = "PCI" | "PAYMENT" | "PHI" | "PII";

export type PolicyRule = {
  id: string;
  action: PolicyRuleAction;
  tool: string;
  dataClass?: PolicyDataClass;
  params?: Record<string, unknown>;
  scope?: PolicyScope;
};

export type PolicyDefinition = {
  rules: PolicyRule[];
};

export type PolicyHistoryEntry = {
  version: number;
  updatedAt: string;
  updatedBy?: string;
  reason?: string;
  policy: PolicyDefinition;
};

export type PolicyState = {
  version: number;
  updatedAt: string;
  updatedBy?: string;
  policy: PolicyDefinition;
  history: PolicyHistoryEntry[];
};

const POLICY_ACTIONS = ["allow", "deny", "require_approval"] as const;
const POLICY_SCOPES = ["org", "project", "run"] as const;
const POLICY_DATA_CLASSES = ["PCI", "PAYMENT", "PHI", "PII"] as const;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  action: z.enum(POLICY_ACTIONS),
  tool: z.string().min(1),
  dataClass: z.enum(POLICY_DATA_CLASSES).optional(),
  params: z.record(z.string(), z.any()).optional(),
  scope: z.enum(POLICY_SCOPES).optional(),
});

export const PolicyUpdateSchema = z.object({
  reason: z.string().min(1),
  rules: z.array(PolicyRuleSchema).min(1),
  mode: z.enum(["replace", "merge"]).optional(),
  scope: z.enum(POLICY_SCOPES).optional(),
  expiresAt: z.number().optional(),
  actor: z.string().optional(),
});

export type PolicyUpdate = z.infer<typeof PolicyUpdateSchema>;

export function normalizePolicyDefinition(raw?: Record<string, unknown>): PolicyDefinition {
  if (!raw || typeof raw !== "object") {
    return { rules: [] };
  }
  if (Array.isArray((raw as { rules?: unknown }).rules)) {
    const rules = (raw as { rules?: unknown[] }).rules ?? [];
    const normalized = rules
      .map((rule) => PolicyRuleSchema.safeParse(rule))
      .filter((result) => result.success)
      .map((result) => result.data);
    return { rules: normalized };
  }

  const allow = Array.isArray((raw as { allow?: unknown }).allow)
    ? ((raw as { allow?: unknown[] }).allow as unknown[])
    : [];
  const deny = Array.isArray((raw as { deny?: unknown }).deny)
    ? ((raw as { deny?: unknown[] }).deny as unknown[])
    : [];

  const rules: PolicyRule[] = [];
  allow.forEach((entry, idx) => {
    if (typeof entry === "string" && entry.trim()) {
      rules.push({
        id: `allow_${idx}_${entry}`,
        action: "allow",
        tool: entry.trim(),
      });
    }
  });
  deny.forEach((entry, idx) => {
    if (typeof entry === "string" && entry.trim()) {
      rules.push({
        id: `deny_${idx}_${entry}`,
        action: "deny",
        tool: entry.trim(),
      });
    }
  });
  return { rules };
}

function hashPolicy(policy: PolicyDefinition): string {
  const json = JSON.stringify(policy);
  return createHash("sha256").update(json).digest("hex");
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function isSubsetValue(candidate: unknown, target: unknown): boolean {
  if (candidate === undefined) {
    return true;
  }
  if (candidate === null || target === null) {
    return candidate === target;
  }
  if (Array.isArray(candidate)) {
    if (!Array.isArray(target)) {
      return false;
    }
    return candidate.every((value) => target.some((item) => isSubsetValue(value, item)));
  }
  if (typeof candidate === "object") {
    if (typeof target !== "object") {
      return false;
    }
    for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
      if (!isSubsetValue(value, (target as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return candidate === target;
}

function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool.trim() === "*") {
    return true;
  }
  return normalizeToolName(ruleTool) === normalizeToolName(toolName);
}

function extractStrings(value: unknown, depth: number, texts: string[], keys: string[]) {
  if (depth > 4) {
    return;
  }
  if (typeof value === "string") {
    texts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => extractStrings(item, depth + 1, texts, keys));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      extractStrings(val, depth + 1, texts, keys);
    }
  }
}

function luhnCheck(value: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number.parseInt(value[i] ?? "", 10);
    if (!Number.isFinite(digit)) {
      return false;
    }
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function hasCardNumber(texts: string[]): boolean {
  const regex = /\b(?:\d[ -]*?){13,19}\b/g;
  for (const text of texts) {
    const matches = text.match(regex);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      const digits = match.replace(/[^\d]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
        return true;
      }
    }
  }
  return false;
}

function hasPaymentKeywords(texts: string[], keys: string[]): boolean {
  const keywords = ["card", "credit", "payment", "cvv", "cvc", "iban", "swift", "bank", "routing"];
  const haystack = [...texts, ...keys].join(" ").toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function isPaymentTool(toolName: string): boolean {
  return /pay|payment|transfer|charge|crypto|bank|card|stripe|billing/i.test(toolName);
}

export function detectDataClasses(
  toolName: string,
  toolParams: Record<string, unknown> | undefined,
): Set<PolicyDataClass> {
  const texts: string[] = [];
  const keys: string[] = [];
  extractStrings(toolParams ?? {}, 0, texts, keys);
  const classes = new Set<PolicyDataClass>();
  if (hasCardNumber(texts) || hasPaymentKeywords(texts, keys)) {
    classes.add("PCI");
  }
  if (isPaymentTool(toolName) || hasPaymentKeywords(texts, keys)) {
    classes.add("PAYMENT");
  }
  return classes;
}

export function evaluatePolicy(params: {
  policy: PolicyDefinition;
  toolName: string;
  toolParams?: Record<string, unknown>;
}): {
  allowed: boolean;
  reason?: string;
  matchedRule?: PolicyRule;
  dataClasses: PolicyDataClass[];
} {
  const { policy, toolName, toolParams } = params;
  const dataClasses = detectDataClasses(toolName, toolParams);

  for (const rule of policy.rules) {
    if (!toolMatches(rule.tool, toolName)) {
      continue;
    }
    if (rule.dataClass && !dataClasses.has(rule.dataClass)) {
      continue;
    }
    if (rule.params && !isSubsetValue(rule.params, toolParams ?? {})) {
      continue;
    }
    if (rule.action === "deny") {
      return {
        allowed: false,
        reason: `ArmorIQ policy deny: ${rule.id}`,
        matchedRule: rule,
        dataClasses: Array.from(dataClasses),
      };
    }
    if (rule.action === "require_approval") {
      return {
        allowed: false,
        reason: `ArmorIQ policy requires approval: ${rule.id}`,
        matchedRule: rule,
        dataClasses: Array.from(dataClasses),
      };
    }
    if (rule.action === "allow") {
      return {
        allowed: true,
        matchedRule: rule,
        dataClasses: Array.from(dataClasses),
      };
    }
  }

  return {
    allowed: true,
    dataClasses: Array.from(dataClasses),
  };
}

function mergeRules(existing: PolicyRule[], updates: PolicyRule[]): PolicyRule[] {
  const map = new Map<string, PolicyRule>();
  for (const rule of existing) {
    map.set(rule.id, rule);
  }
  for (const rule of updates) {
    map.set(rule.id, rule);
  }
  return Array.from(map.values());
}

export type PolicyChangeCallback = (state: PolicyState) => void | Promise<void>;

export class PolicyStore {
  private state: PolicyState;
  private readonly filePath: string;
  private readonly logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  private readonly onPolicyChange?: PolicyChangeCallback;
  private cryptoTokenDigest?: string;

  constructor(params: {
    filePath: string;
    basePolicy: PolicyDefinition;
    logger?: { info?: (message: string) => void; warn?: (message: string) => void };
    onPolicyChange?: PolicyChangeCallback;
  }) {
    this.filePath = params.filePath;
    this.logger = params.logger;
    this.onPolicyChange = params.onPolicyChange;
    this.state = {
      version: 0,
      updatedAt: new Date().toISOString(),
      policy: params.basePolicy,
      history: [],
    };
  }

  setCryptoTokenDigest(digest: string): void {
    this.cryptoTokenDigest = digest;
    this.logger?.info?.(`armoriq: crypto token digest set: ${digest.slice(0, 16)}...`);
  }

  getCryptoTokenDigest(): string | undefined {
    return this.cryptoTokenDigest;
  }

  private async notifyPolicyChange(): Promise<void> {
    if (this.onPolicyChange) {
      try {
        await this.onPolicyChange(this.state);
      } catch (err) {
        this.logger?.warn?.(`armoriq: policy change callback failed: ${String(err)}`);
      }
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const policy =
        typeof parsed.policy === "object"
          ? normalizePolicyDefinition(parsed.policy as Record<string, unknown>)
          : normalizePolicyDefinition(parsed as Record<string, unknown>);
      const version = typeof parsed.version === "number" ? parsed.version : 0;
      const updatedAt =
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString();
      const updatedBy = typeof parsed.updatedBy === "string" ? parsed.updatedBy : undefined;
      const history = Array.isArray(parsed.history)
        ? (parsed.history as PolicyHistoryEntry[])
        : [];

      this.state = {
        version,
        updatedAt,
        updatedBy,
        policy,
        history,
      };
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        this.logger?.warn?.(`armoriq: failed to load policy store (${String(err)})`);
      }
    }
  }

  getState(): PolicyState {
    return this.state;
  }

  getPolicy(): PolicyDefinition {
    return this.state.policy;
  }

  getPolicyHash(): string {
    return hashPolicy(this.state.policy);
  }

  async applyUpdate(update: PolicyUpdate, actor?: string): Promise<PolicyState> {
    const nextRules =
      update.mode === "replace"
        ? update.rules
        : mergeRules(this.state.policy.rules, update.rules);

    const nextPolicy: PolicyDefinition = { rules: nextRules };
    const nextVersion = this.state.version + 1;
    const updatedAt = new Date().toISOString();
    const updatedBy = actor ?? update.actor;

    const entry: PolicyHistoryEntry = {
      version: nextVersion,
      updatedAt,
      updatedBy,
      reason: update.reason,
      policy: nextPolicy,
    };

    this.state = {
      version: nextVersion,
      updatedAt,
      updatedBy,
      policy: nextPolicy,
      history: [...this.state.history, entry],
    };

    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    await this.notifyPolicyChange();
    return this.state;
  }

  async removeRules(ids: string[], actor?: string, reason?: string): Promise<PolicyState> {
    const idSet = new Set(ids.filter((id) => id.trim()));
    const nextRules = this.state.policy.rules.filter((rule) => !idSet.has(rule.id));
    const nextVersion = this.state.version + 1;
    const updatedAt = new Date().toISOString();
    const updatedBy = actor;

    const entry: PolicyHistoryEntry = {
      version: nextVersion,
      updatedAt,
      updatedBy,
      reason: reason ?? "Policy rule removal",
      policy: { rules: nextRules },
    };

    this.state = {
      version: nextVersion,
      updatedAt,
      updatedBy,
      policy: { rules: nextRules },
      history: [...this.state.history, entry],
    };

    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    await this.notifyPolicyChange();
    return this.state;
  }

  async reorderRule(
    id: string,
    position: number,
    actor?: string,
    reason?: string,
  ): Promise<PolicyState> {
    const rules = [...this.state.policy.rules];
    const index = rules.findIndex((rule) => rule.id === id);
    if (index === -1) {
      throw new Error(`Policy rule not found: ${id}`);
    }
    const clamped = Math.min(Math.max(position, 1), rules.length);
    const [rule] = rules.splice(index, 1);
    rules.splice(clamped - 1, 0, rule);

    const nextVersion = this.state.version + 1;
    const updatedAt = new Date().toISOString();
    const updatedBy = actor;

    const entry: PolicyHistoryEntry = {
      version: nextVersion,
      updatedAt,
      updatedBy,
      reason: reason ?? `Policy reorder: ${id} -> ${clamped}`,
      policy: { rules },
    };

    this.state = {
      version: nextVersion,
      updatedAt,
      updatedBy,
      policy: { rules },
      history: [...this.state.history, entry],
    };

    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
    await this.notifyPolicyChange();
    return this.state;
  }
}

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PgClient } from "../db/postgres.js";

const ERP_TAG_RE = /\[erp:(\w[\w-]*):([^\]]+)\]/;
const COGNITIVE_FILES = {
  beliefs: "Beliefs.md",
  desires: "Desires.md",
  goals: "Goals.md",
  intentions: "Intentions.md",
} as const;

export interface SyncEvent {
  direction: "erp-to-bdi" | "bdi-to-erp";
  domain: string;
  entityType: string;
  entityId: string;
  agentId: string;
  action: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface SyncRule {
  domain: string;
  entityType: string;
  trigger: "create" | "update" | "delete" | "status_change";
  cognitiveTarget: keyof typeof COGNITIVE_FILES;
  toMarkdown: (record: Record<string, unknown>) => string;
  toErpUpdate?: (
    cognitiveBlock: string,
    oldStatus: string,
    newStatus: string,
  ) => {
    action: string;
    params: Record<string, unknown>;
  } | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export const ERP_TO_BDI_RULES: SyncRule[] = [
  {
    domain: "projects",
    entityType: "project",
    trigger: "create",
    cognitiveTarget: "desires",
    toMarkdown: (r) =>
      `## ${r.name} [erp:projects:${r.id}]\n` +
      `- priority: ${r.priority ?? 0.7}\n` +
      `- domain: projects\n` +
      `- budget: ${r.budget ?? "unset"}\n` +
      `- timeline: ${r.start_date} → ${r.end_date}\n` +
      `- status: ${r.status}\n`,
    toErpUpdate: (_block, _old, newStatus) => {
      if (newStatus === "dropped") return { action: "update", params: { status: "on_hold" } };
      return null;
    },
  },
  {
    domain: "marketing",
    entityType: "campaign",
    trigger: "create",
    cognitiveTarget: "desires",
    toMarkdown: (r) =>
      `## ${r.name} [erp:marketing:${r.id}]\n` +
      `- priority: ${r.priority ?? 0.6}\n` +
      `- domain: marketing\n` +
      `- channel: ${r.channel}\n` +
      `- budget: ${r.budget}\n` +
      `- target_segment: ${r.target_segment}\n` +
      `- timeline: ${r.start_date} → ${r.end_date}\n`,
    toErpUpdate: (_block, _old, newStatus) => {
      if (newStatus === "dropped") return { action: "update", params: { status: "paused" } };
      return null;
    },
  },
  {
    domain: "projects",
    entityType: "task",
    trigger: "create",
    cognitiveTarget: "intentions",
    toMarkdown: (r) =>
      `## ${r.title} [erp:projects:${r.id}]\n` +
      `- status: active\n` +
      `- [deadline: ${r.due_date}]\n` +
      `- [updated: ${today()}]\n` +
      `- priority: ${r.priority}\n` +
      `- project: ${r.project_id}\n`,
    toErpUpdate: (_block, _old, newStatus) => {
      const map: Record<string, string> = {
        stalled: "blocked",
        expired: "at_risk",
        completed: "done",
      };
      if (map[newStatus]) return { action: "update", params: { status: map[newStatus] } };
      return null;
    },
  },
  {
    domain: "projects",
    entityType: "milestone",
    trigger: "create",
    cognitiveTarget: "intentions",
    toMarkdown: (r) =>
      `## Milestone: ${r.title} [erp:projects:${r.id}]\n` +
      `- status: active\n` +
      `- [deadline: ${r.target_date}]\n` +
      `- [updated: ${today()}]\n` +
      `- kpi_targets: ${JSON.stringify(r.kpi_targets)}\n`,
    toErpUpdate: (_block, _old, newStatus) => {
      if (newStatus === "expired") return { action: "update", params: { status: "at_risk" } };
      if (newStatus === "completed") return { action: "update", params: { status: "completed" } };
      return null;
    },
  },
  {
    domain: "analytics",
    entityType: "kpi",
    trigger: "update",
    cognitiveTarget: "beliefs",
    toMarkdown: (r) =>
      `## KPI: ${r.name} [erp:analytics:${r.id}]\n` +
      `- domain: ${r.domain}\n` +
      `- current: ${r.current} / target: ${r.target} ${r.unit}\n` +
      `- period: ${r.period}\n` +
      `- on_track: ${Number(r.current) >= Number(r.target) * 0.8 ? "yes" : "no"}\n` +
      `- last_updated: ${r.updated_at}\n`,
  },
  {
    domain: "compliance",
    entityType: "violation",
    trigger: "create",
    cognitiveTarget: "goals",
    toMarkdown: (r) =>
      `## Resolve: ${r.entity_type} violation [erp:compliance:${r.id}]\n` +
      `- severity: ${r.severity}\n` +
      `- rule: ${r.rule_id}\n` +
      `- entity: ${r.entity_type}:${r.entity_id}\n` +
      `- status: open\n` +
      `- priority: ${r.severity === "critical" ? 1.0 : r.severity === "high" ? 0.8 : 0.5}\n`,
    toErpUpdate: (_block, _old, newStatus) => {
      if (newStatus === "resolved")
        return {
          action: "update",
          params: { status: "resolved", resolved_at: new Date().toISOString() },
        };
      return null;
    },
  },
  {
    domain: "suppliers",
    entityType: "supplier",
    trigger: "update",
    cognitiveTarget: "beliefs",
    toMarkdown: (r) =>
      `## Supplier: ${r.name} [erp:suppliers:${r.id}]\n` +
      `- rating: ${r.rating}\n` +
      `- status: ${r.status}\n` +
      `- category: ${r.category}\n` +
      `- risk_level: ${Number(r.rating) < 3.0 ? "high" : Number(r.rating) < 4.0 ? "medium" : "low"}\n`,
  },
  {
    domain: "ecommerce",
    entityType: "order",
    trigger: "create",
    cognitiveTarget: "beliefs",
    toMarkdown: (r) =>
      `## Order received [erp:ecommerce:${r.id}]\n` +
      `- customer: ${r.customer_id}\n` +
      `- total: ${r.total} ${r.currency}\n` +
      `- items: ${Array.isArray(r.line_items) ? r.line_items.length : 0} SKUs\n` +
      `- timestamp: ${r.created_at}\n`,
  },
];

export class BdiSyncEngine {
  private rules: SyncRule[];
  private syncLog: SyncEvent[] = [];

  constructor(
    private pg: PgClient,
    private logger: { info: (msg: string) => void; warn: (msg: string) => void },
    rules?: SyncRule[],
  ) {
    this.rules = rules ?? ERP_TO_BDI_RULES;
  }

  async syncErpToBdi(params: {
    agentDir: string;
    agentId: string;
    domain: string;
    entityType: string;
    trigger: "create" | "update" | "delete" | "status_change";
    record: Record<string, unknown>;
  }): Promise<void> {
    const rule = this.rules.find(
      (r) =>
        r.domain === params.domain &&
        r.entityType === params.entityType &&
        r.trigger === params.trigger,
    );
    if (!rule) return;

    const targetFile = join(params.agentDir, COGNITIVE_FILES[rule.cognitiveTarget]);
    const markdown = rule.toMarkdown(params.record);
    const entityId = params.record.id as string;
    const tag = `[erp:${params.domain}:${entityId}]`;

    let existing = "";
    try {
      existing = await readFile(targetFile, "utf-8");
    } catch {
      // File does not exist yet
    }

    if (existing.includes(tag)) {
      const updated = this.replaceBlock(existing, tag, markdown);
      await writeFile(targetFile, updated, "utf-8");
    } else {
      const updated = existing.trimEnd() + "\n\n" + markdown;
      await writeFile(targetFile, updated, "utf-8");
    }

    this.logEvent({
      direction: "erp-to-bdi",
      domain: params.domain,
      entityType: params.entityType,
      entityId,
      agentId: params.agentId,
      action: params.trigger,
      payload: params.record,
      timestamp: new Date().toISOString(),
    });

    this.logger.info(
      `[bdi-sync] ERP→BDI: ${params.domain}/${params.entityType} → ${rule.cognitiveTarget} for agent ${params.agentId}`,
    );
  }

  async syncBdiToErp(params: {
    agentDir: string;
    agentId: string;
    previousState: { intentions: string; desires: string; goals: string };
    currentState: { intentions: string; desires: string; goals: string };
  }): Promise<number> {
    let updatesApplied = 0;

    for (const fileKey of ["intentions", "desires", "goals"] as const) {
      const prevBlocks = this.parseBlocks(params.previousState[fileKey]);
      const currBlocks = this.parseBlocks(params.currentState[fileKey]);

      for (const [tag, currBlock] of currBlocks) {
        const prevBlock = prevBlocks.get(tag);
        if (!prevBlock) continue;

        const prevStatus = this.extractStatus(prevBlock);
        const currStatus = this.extractStatus(currBlock);

        if (prevStatus && currStatus && prevStatus !== currStatus) {
          const tagMatch = tag.match(ERP_TAG_RE);
          if (!tagMatch) continue;

          const [, domain, entityId] = tagMatch;
          const matchingRules = this.rules.filter((r) => r.domain === domain && r.toErpUpdate);
          let erpUpdate: { action: string; params: Record<string, unknown> } | null = null;
          let matchedRule: SyncRule | undefined;
          for (const candidate of matchingRules) {
            erpUpdate = candidate.toErpUpdate!(currBlock, prevStatus, currStatus);
            if (erpUpdate) {
              matchedRule = candidate;
              break;
            }
          }
          if (!erpUpdate || !matchedRule) continue;

          await this.applyErpUpdate(domain, entityId, erpUpdate);
          updatesApplied++;

          this.logEvent({
            direction: "bdi-to-erp",
            domain,
            entityType: matchedRule.entityType,
            entityId,
            agentId: params.agentId,
            action: `status: ${prevStatus} → ${currStatus}`,
            payload: erpUpdate.params,
            timestamp: new Date().toISOString(),
          });

          this.logger.info(
            `[bdi-sync] BDI→ERP: ${fileKey} status ${prevStatus}→${currStatus} → ${domain}/${entityId}`,
          );
        }
      }
    }

    return updatesApplied;
  }

  private parseBlocks(markdown: string): Map<string, string> {
    const blocks = new Map<string, string>();
    const sections = markdown.split(/(?=^## )/m);
    for (const section of sections) {
      const tagMatch = section.match(ERP_TAG_RE);
      if (tagMatch) {
        blocks.set(tagMatch[0], section.trim());
      }
    }
    return blocks;
  }

  private extractStatus(block: string): string | null {
    const match = block.match(/[-*]\s*status:\s*(\S+)/);
    return match?.[1] ?? null;
  }

  private replaceBlock(content: string, tag: string, newBlock: string): string {
    const sections = content.split(/(?=^## )/m);
    const updated = sections.map((section) => (section.includes(tag) ? newBlock : section));
    return updated.join("\n");
  }

  private async applyErpUpdate(
    domain: string,
    entityId: string,
    update: { action: string; params: Record<string, unknown> },
  ): Promise<void> {
    const tableMap: Record<string, string> = {
      projects: "erp.projects",
      marketing: "erp.campaigns",
      compliance: "erp.violations",
      ecommerce: "erp.orders",
      finance: "erp.invoices",
      suppliers: "erp.suppliers",
      hr: "erp.employees",
      inventory: "erp.stock_items",
      legal: "erp.contracts",
      "supply-chain": "erp.shipments",
    };
    const table = tableMap[domain];
    if (!table) return;

    const keys = Object.keys(update.params);
    const setClauses = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
    const values = [entityId, ...Object.values(update.params)];
    await this.pg.query(`UPDATE ${table} SET ${setClauses} WHERE id = $1`, values);
  }

  private logEvent(event: SyncEvent): void {
    this.syncLog.push(event);
    if (this.syncLog.length > 1000) {
      this.syncLog = this.syncLog.slice(-500);
    }
  }

  getRecentEvents(limit = 50): SyncEvent[] {
    return this.syncLog.slice(-limit);
  }
}

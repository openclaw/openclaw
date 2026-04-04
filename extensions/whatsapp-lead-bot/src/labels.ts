/**
 * WhatsApp label management for lead scores and statuses.
 *
 * Label names from config are resolved to WhatsApp IDs via:
 * 1. In-memory cache (hot path)
 * 2. SQLite whatsapp_labels table
 * 3. runtime.getLabels() — fetch from WhatsApp, match by name
 * 4. runtime.createLabel() — create if not found
 */

import type { LabelStore } from "./database.js";
import type { Runtime } from "./runtime.js";
import { normalizePhone } from "./utils/phone.js";

export interface LabelConfig {
  scores: Record<string, string>;
  statuses: { BOT: string; HUMANO: string };
}

export interface LabelService {
  applyScore(phone: string, score: string, runtime: Runtime): Promise<void>;
  applyStatus(phone: string, status: string, runtime: Runtime): Promise<void>;
  removeAllScoreLabels(phone: string, runtime: Runtime): Promise<void>;
  syncAll(phone: string, score: string | null, status: string, runtime: Runtime): Promise<void>;
  ensureLabels?(runtime: Runtime): Promise<void>;
}

// Default WhatsApp label colors per name
const DEFAULT_COLORS: Record<string, number> = {
  HOT: 0,
  WARM: 3,
  COLD: 7,
  OUT: 14,
  BOT: 4,
  HUMANO: 5,
};

export class WhatsAppLabelService implements LabelService {
  private readonly scoreNames: Record<string, string>;
  private readonly statusNames: { BOT: string; HUMANO: string };
  private readonly allScoreNames: string[];
  // In-memory cache: label name → WhatsApp label ID
  private readonly idCache = new Map<string, string>();

  constructor(
    labelConfig: LabelConfig,
    private readonly labelStore: LabelStore,
    private readonly delayMs = 1500,
  ) {
    this.scoreNames = labelConfig.scores;
    this.statusNames = labelConfig.statuses;
    this.allScoreNames = [...new Set(Object.values(this.scoreNames))];
  }

  /** Resolve a label name to its WhatsApp ID, using cache → DB → runtime */
  private async resolveId(name: string, runtime: Runtime): Promise<string | null> {
    // 1. In-memory cache
    const cached = this.idCache.get(name);
    if (cached) return cached;

    // 2. DB lookup
    const dbId = await this.labelStore.getLabelId(name);
    if (dbId) {
      this.idCache.set(name, dbId);
      return dbId;
    }

    // 3. Fetch labels from WhatsApp runtime
    if (!runtime.getLabels) {
      console.warn(`[labels] resolveId("${name}"): runtime.getLabels not available`);
      return null;
    }
    const labels = await runtime.getLabels();
    console.log(
      `[labels] resolveId("${name}"): fetched ${labels.length} labels from WhatsApp: ${JSON.stringify(labels.map((l) => ({ id: l.id, name: l.name, deleted: l.deleted })))}`,
    );
    const match = labels.find((l) => !l.deleted && l.name.toLowerCase() === name.toLowerCase());
    if (match) {
      console.log(`[labels] resolveId("${name}"): matched → id=${match.id} name="${match.name}"`);
      await this.labelStore.upsertLabel(name, match.id, match.color);
      this.idCache.set(name, match.id);
      return match.id;
    }

    console.warn(`[labels] resolveId("${name}"): no match found among fetched labels`);

    // 4. Create label via runtime
    if (!runtime.createLabel) {
      console.warn(`[labels] resolveId("${name}"): runtime.createLabel not available`);
      return null;
    }
    const color = DEFAULT_COLORS[name] ?? 0;
    const created = await runtime.createLabel(name, color);
    if (created) {
      console.log(`[labels] resolveId("${name}"): created label → id=${created.id}`);
      await this.labelStore.upsertLabel(name, created.id, created.color);
      this.idCache.set(name, created.id);
      return created.id;
    }

    console.warn(`[labels] resolveId("${name}"): createLabel returned nothing`);
    return null;
  }

  /** Delay between WhatsApp API calls to avoid rate limits (429) */
  private delay(): Promise<void> {
    if (this.delayMs <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, this.delayMs));
  }

  /** Apply score label and remove other score labels */
  async applyScore(phone: string, score: string, runtime: Runtime): Promise<void> {
    const labelName = this.scoreNames[score];
    if (!labelName) return;

    const labelId = await this.resolveId(labelName, runtime);
    if (!labelId) return;

    const phoneJid = `${normalizePhone(phone)}@s.whatsapp.net`;
    await runtime.addChatLabel?.(phoneJid, labelId);
    await this.delay();

    // Remove other score labels
    for (const otherName of this.allScoreNames) {
      if (otherName === labelName) continue;
      const otherId = await this.resolveId(otherName, runtime);
      if (otherId && otherId !== labelId) {
        try {
          await runtime.removeChatLabel?.(phoneJid, otherId);
          await this.delay();
        } catch {
          /* label may not exist on this chat */
        }
      }
    }
  }

  /** Apply status label (BOT or HUMANO) and remove the other */
  async applyStatus(phone: string, status: string, runtime: Runtime): Promise<void> {
    const phoneJid = `${normalizePhone(phone)}@s.whatsapp.net`;
    const isHandedOff = status === "handed_off";

    const applyName = isHandedOff ? this.statusNames.HUMANO : this.statusNames.BOT;
    const removeName = isHandedOff ? this.statusNames.BOT : this.statusNames.HUMANO;

    const applyId = await this.resolveId(applyName, runtime);
    if (applyId) {
      await runtime.addChatLabel?.(phoneJid, applyId);
      await this.delay();
    }

    const removeId = await this.resolveId(removeName, runtime);
    if (removeId) {
      try {
        await runtime.removeChatLabel?.(phoneJid, removeId);
        await this.delay();
      } catch {
        /* label may not exist on this chat */
      }
    }
  }

  /** Remove all score labels from a chat */
  async removeAllScoreLabels(phone: string, runtime: Runtime): Promise<void> {
    const phoneJid = `${normalizePhone(phone)}@s.whatsapp.net`;
    for (const name of this.allScoreNames) {
      const labelId = await this.resolveId(name, runtime);
      if (labelId) {
        try {
          await runtime.removeChatLabel?.(phoneJid, labelId);
          await this.delay();
        } catch {
          /* label may not exist on this chat */
        }
      }
    }
  }

  /** Full sync: apply correct score + status labels */
  async syncAll(
    phone: string,
    score: string | null,
    status: string,
    runtime: Runtime,
  ): Promise<void> {
    if (score && this.scoreNames[score]) {
      await this.applyScore(phone, score, runtime);
    } else {
      await this.removeAllScoreLabels(phone, runtime);
    }
    await this.applyStatus(phone, status, runtime);
  }

  /** Pre-warm: resolve all configured label names to IDs */
  async ensureLabels(runtime: Runtime): Promise<void> {
    const allNames = [...this.allScoreNames, this.statusNames.BOT, this.statusNames.HUMANO];
    const unique = [...new Set(allNames)];
    for (const name of unique) {
      await this.resolveId(name, runtime);
    }
  }
}

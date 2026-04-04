/**
 * Admin command parser and executor — registry-based dispatch.
 * Adding a command = add a parse case + register a handler.
 */

import type { Database } from "../database.js";
import type { Lead } from "../database/schema.js";
import type { HandoffManager } from "../handoff/manager.js";
import type { LabelService } from "../labels.js";
import type { CircuitBreaker } from "../rate-limit/circuit-breaker.js";
import type { GlobalRateLimiter } from "../rate-limit/global-limiter.js";
import type { RateLimiter } from "../rate-limit/limiter.js";
import type { Runtime } from "../runtime.js";
import { computeScore } from "../scoring.js";
import type { SessionResetter } from "../session-resetter.js";
import { formatTimeAgo } from "../utils/format.js";
import { normalizePhone } from "../utils/phone.js";

export type AdminCommand =
  | { type: "status"; phone: string }
  | { type: "block"; phone: string; reason: string }
  | { type: "unblock"; phone: string }
  | { type: "handoff"; phone: string }
  | { type: "takeback"; phone: string }
  | { type: "reset-lead"; phone: string }
  | { type: "clear-limit"; phone: string }
  | { type: "score"; phone: string; score: string }
  | { type: "recent"; count: number }
  | { type: "rate-status" }
  | { type: "reset-breaker" }
  | { type: "sync-leads" }
  | { type: "sync-labels" }
  | { type: "followup"; phone: string }
  | { type: "pending" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "help" };

type CommandHandler = (command: AdminCommand, runtime?: Runtime) => Promise<string>;

export class AdminCommandHandler {
  private handlers = new Map<string, CommandHandler>();

  constructor(
    private db: Database,
    private handoffManager: HandoffManager,
    private rateLimiter: RateLimiter,
    private selfE164: string | null,
    private sessionResetter: SessionResetter | null,
    private circuitBreaker: CircuitBreaker | null = null,
    private globalLimiter: GlobalRateLimiter | null = null,
    private labelService: LabelService | null = null,
  ) {
    this.registerBuiltinHandlers();
  }

  private registerBuiltinHandlers(): void {
    this.register("status", (cmd) => this.handleStatus((cmd as { phone: string }).phone));
    this.register("block", (cmd) => {
      const c = cmd as { phone: string; reason: string };
      return this.handleBlock(c.phone, c.reason);
    });
    this.register("unblock", (cmd) => this.handleUnblock((cmd as { phone: string }).phone));
    this.register("handoff", (cmd) => this.handleHandoff((cmd as { phone: string }).phone));
    this.register("takeback", (cmd) => this.handleTakeback((cmd as { phone: string }).phone));
    this.register("reset-lead", (cmd) => this.handleResetLead((cmd as { phone: string }).phone));
    this.register("clear-limit", (cmd) => this.handleClearLimit((cmd as { phone: string }).phone));
    this.register("score", (cmd, runtime) => {
      const c = cmd as { phone: string; score: string };
      return this.handleScore(c.phone, c.score, runtime);
    });
    this.register("recent", (cmd) => this.handleRecent((cmd as { count: number }).count));
    this.register("rate-status", () => this.handleRateStatus());
    this.register("reset-breaker", () => this.handleResetBreaker());
    this.register("sync-leads", () => this.handleSyncLeads());
    this.register("sync-labels", (_cmd, runtime) => this.handleSyncLabels(runtime));
    this.register("followup", (cmd) => this.handleFollowup((cmd as { phone: string }).phone));
    this.register("pending", () => this.handlePending());
    this.register("pause", () => this.handlePause());
    this.register("resume", () => this.handleResume());
    this.register("help", () => Promise.resolve(this.handleHelp()));
  }

  /** Register a command handler. Overwrites existing handler for same type. */
  register(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  isAdmin(phoneNumber: string): boolean {
    if (!this.selfE164) return false;
    return normalizePhone(phoneNumber) === normalizePhone(this.selfE164);
  }

  private stripUnicode(text: string): string {
    return text.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
  }

  private extractPhone(parts: string[]): [string, string[]] {
    const phoneParts: string[] = [];
    let i = 0;
    for (; i < parts.length; i++) {
      const clean = this.stripUnicode(parts[i]);
      if (clean.length > 0 && /^[+\d\s()\-]+$/.test(clean)) {
        phoneParts.push(clean);
      } else {
        break;
      }
    }
    const phone = normalizePhone(phoneParts.join(""));
    return [phone, parts.slice(i)];
  }

  parseCommand(message: string): AdminCommand | null {
    const trimmed = this.stripUnicode(message.trim());
    if (!trimmed.startsWith("/")) return null;

    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "status": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "status", phone };
      }

      case "block": {
        const [phone, rest] = this.extractPhone(args);
        const reason = rest.join(" ") || "No reason provided";
        if (!phone) return null;
        return { type: "block", phone, reason };
      }

      case "unblock": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "unblock", phone };
      }

      case "handoff": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "handoff", phone };
      }

      case "takeback": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "takeback", phone };
      }

      case "reset-lead": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "reset-lead", phone };
      }

      case "clear-limit": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "clear-limit", phone };
      }

      case "score": {
        const [phone, rest] = this.extractPhone(args);
        const score = rest[0]?.toUpperCase();
        if (!phone || !score) return null;
        if (!["HOT", "WARM", "COLD", "OUT"].includes(score)) return null;
        return { type: "score", phone, score };
      }

      case "recent": {
        const count = parseInt(parts[1] || "5", 10);
        return { type: "recent", count: isNaN(count) ? 5 : count };
      }

      case "rate-status":
        return { type: "rate-status" };

      case "reset-breaker":
        return { type: "reset-breaker" };

      case "sync-leads":
        return { type: "sync-leads" };

      case "sync-labels":
        return { type: "sync-labels" };

      case "followup": {
        const [phone] = this.extractPhone(args);
        if (!phone) return null;
        return { type: "followup", phone };
      }

      case "pending":
        return { type: "pending" };

      case "pause":
        return { type: "pause" };

      case "resume":
        return { type: "resume" };

      case "help":
        return { type: "help" };

      default:
        return null;
    }
  }

  async execute(command: AdminCommand, runtime?: Runtime): Promise<string> {
    try {
      const handler = this.handlers.get(command.type);
      if (!handler) return "Unknown command. Type /help for available commands.";
      return await handler(command, runtime);
    } catch (err) {
      console.error("[admin-commands] Execution error:", err);
      return `Error: ${String(err)}`;
    }
  }

  // --- Individual command handlers ---

  private async handleStatus(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    const qualified = await this.db.isLeadQualified(lead.id);

    return `**Lead Status**\n\nPhone: ${lead.phone_number}\nName: ${lead.name || "N/A"}\nStatus: ${lead.status}\nScore: ${lead.score || "N/A"}\nQualified: ${qualified ? "Yes" : "No"}\n\nLocation: ${lead.location || "N/A"}\nProperty: ${lead.property_type || "N/A"}\nOwnership: ${lead.ownership || "N/A"}\nBill: ${lead.bimonthly_bill ?? "N/A"}\n\nLast message: ${this.formatDate(lead.last_message_at)}`;
  }

  private async handleBlock(phone: string, reason: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    await this.db.blockLead(lead.id, reason);
    await this.db.logHandoffEvent(lead.id, "admin_block", "admin", { reason });
    return `✅ Blocked lead: ${phone}\nReason: ${reason}`;
  }

  private async handleUnblock(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    await this.db.unblockLead(lead.id);
    await this.db.logHandoffEvent(lead.id, "admin_unblock", "admin");
    return `✅ Unblocked lead: ${phone}`;
  }

  private async handleHandoff(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    await this.handoffManager.triggerAdminHandoff(lead.id);
    return `✅ Handoff triggered for: ${phone}\nBot will stop responding.`;
  }

  private async handleTakeback(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    if (lead.status !== "handed_off") {
      return `Lead is not handed off (current status: ${lead.status})`;
    }

    await this.db.updateLeadStatus(lead.id, "qualifying");
    await this.db.updateAssignedAgent(lead.id, null);
    await this.db.logHandoffEvent(lead.id, "admin_takeback", "admin");

    // Build handoff activity summary from stored messages
    const summary = await this.buildHandoffSummary(lead);
    return `✅ Takeback: ${phone}\nBot will resume handling this lead.${summary}`;
  }

  private async buildHandoffSummary(lead: Lead): Promise<string> {
    if (!lead.handed_off_at) return "";

    // Convert phone to WhatsApp JID format for message lookup
    const digits = normalizePhone(lead.phone_number).replace(/^\+/, "");
    const chatJid = `${digits}@s.whatsapp.net`;

    try {
      const messages = await this.db.getMessagesSince(chatJid, lead.handed_off_at);
      if (messages.length === 0) return "";

      // Count inbound messages (from_me = 0) by type
      const inbound = messages.filter((m) => m.from_me === 0);
      if (inbound.length === 0) return "";

      const textCount = inbound.filter(
        (m) =>
          !m.message_type ||
          m.message_type === "conversation" ||
          m.message_type === "extendedTextMessage",
      ).length;
      const mediaCount = inbound.filter(
        (m) =>
          m.message_type &&
          m.message_type !== "conversation" &&
          m.message_type !== "extendedTextMessage",
      ).length;

      const duration = formatTimeAgo(Date.now() - lead.handed_off_at);
      const lines: string[] = [`\n\nDuring handoff (${duration}):`];

      if (textCount > 0) lines.push(`- ${textCount} text message${textCount > 1 ? "s" : ""}`);
      if (mediaCount > 0) lines.push(`- ${mediaCount} media file${mediaCount > 1 ? "s" : ""}`);

      // Check if receipt was processed during handoff
      if (lead.receipt_data) {
        try {
          const receipt = JSON.parse(lead.receipt_data);
          if (receipt.tarifa || receipt.calculado?.promedio_anual_kwh) {
            lines.push(
              `- CFE receipt processed (Tarifa ${receipt.tarifa || "?"}, ${receipt.calculado?.promedio_anual_kwh || "?"} kWh/yr)`,
            );
          }
        } catch {
          /* ignore parse errors */
        }
      }

      return lines.join("\n");
    } catch (err) {
      console.error("[admin-commands] Failed to build handoff summary:", err);
      return "";
    }
  }

  private async handleResetLead(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    await this.db.resetLead(lead.id);
    await this.db.logHandoffEvent(lead.id, "admin_reset_lead", "admin");

    let sessionCleared = false;
    if (this.sessionResetter) {
      try {
        sessionCleared = await this.sessionResetter.resetSession(lead.phone_number);
      } catch (err) {
        console.error("[admin-commands] Session reset error:", err);
      }
    }

    if (sessionCleared) {
      return `✅ Reset lead: ${phone}\nStatus, qualification data, and OpenClaw session cleared. Lead will be treated as new.`;
    }
    return `✅ Reset lead: ${phone}\nPlugin state cleared. No active OpenClaw session found for this lead.`;
  }

  private async handleClearLimit(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    await this.rateLimiter.clearLimit(lead.id);
    await this.db.updateLeadStatus(lead.id, "qualifying");
    await this.db.logHandoffEvent(lead.id, "admin_clear_limit", "admin");
    return `✅ Rate limit cleared for: ${phone}`;
  }

  private async handleScore(phone: string, score: string, runtime?: Runtime): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    await this.db.updateQualificationData(lead.id, { score });
    await this.db.logHandoffEvent(lead.id, "admin_score", "admin", { score });

    if (this.labelService && runtime) {
      try {
        await this.labelService.applyScore(phone, score, runtime);
      } catch (err) {
        console.error("[admin-commands] Label application failed:", err);
      }
    }

    return `Score set: ${phone} → ${score}`;
  }

  private async handleRecent(count: number): Promise<string> {
    const leads = await this.db.getRecentLeads(count);
    if (leads.length === 0) return "No leads found.";

    const lines = leads.map((lead) => {
      const timeAgo = formatTimeAgo(Date.now() - lead.last_message_at);
      return `${lead.phone_number} - ${lead.status} (${timeAgo})`;
    });

    return `**Recent Leads (${leads.length})**\n\n${lines.join("\n")}`;
  }

  private async handleRateStatus(): Promise<string> {
    const lines: string[] = ["**Rate Limit Status**\n"];

    if (this.circuitBreaker) {
      const cb = await this.circuitBreaker.getStatus();
      lines.push(
        `Circuit Breaker: ${cb.isTripped ? "TRIPPED" : "OK"}`,
        `  Hit rate: ${Math.round(cb.hitRate * 100)}% (${cb.totalHits}/${cb.totalChecks})`,
      );
      if (cb.isTripped && cb.reason) {
        lines.push(`  Reason: ${cb.reason}`);
      }
    }

    if (this.globalLimiter) {
      const gl = await this.globalLimiter.getStatus();
      lines.push(`\nGlobal Limit: ${gl.count}/${gl.maxPerHour} msg/hr`);
    }

    const stats = await this.db.getStats();
    lines.push(`\nRate-limited leads: ${stats.rateLimited}`);
    return lines.join("\n");
  }

  private async handleResetBreaker(): Promise<string> {
    if (!this.circuitBreaker) return "Circuit breaker is not enabled.";
    await this.circuitBreaker.reset();
    return "✅ Circuit breaker reset. Bot responses restored.";
  }

  private async handleSyncLeads(): Promise<string> {
    const allLeads = await this.db.listLeads();
    let recomputed = 0;
    let skipped = 0;
    const changes: string[] = [];

    for (const lead of allLeads) {
      const phone = lead.phone_number;
      if (!phone || phone.length < 10) {
        skipped++;
        continue;
      }

      const previousScore = lead.score ?? null;
      const newScore = computeScore({
        location: lead.location,
        bimonthly_bill: lead.bimonthly_bill,
        ownership: lead.ownership,
      });

      if (newScore !== null && newScore !== previousScore) {
        await this.db.upsertLead(phone, { score: newScore });
        changes.push(`${phone}: ${previousScore || "—"} → ${newScore}`);
        recomputed++;
      }
    }

    const lines = [
      `✅ **Sync Leads**`,
      `Total: ${allLeads.length} | Recomputed: ${recomputed} | Skipped: ${skipped}`,
    ];
    if (changes.length > 0) {
      lines.push("", "Changes:", ...changes.slice(0, 20));
      if (changes.length > 20) lines.push(`... y ${changes.length - 20} más`);
    } else {
      lines.push("No score changes needed.");
    }
    return lines.join("\n");
  }

  private async handleSyncLabels(runtime?: Runtime): Promise<string> {
    if (!this.labelService || !runtime) {
      return "❌ Label service or runtime not available.";
    }

    const allLeads = await this.db.listLeads();
    let synced = 0;
    let recomputed = 0;
    let errors = 0;
    const BATCH_SIZE = 10;
    const BATCH_PAUSE_MS = 15_000;

    for (let i = 0; i < allLeads.length; i++) {
      const lead = allLeads[i];
      const phone = lead.phone_number;
      if (!phone || phone.length < 10) continue;

      const previousScore = lead.score ?? null;
      const newScore = computeScore({
        location: lead.location,
        bimonthly_bill: lead.bimonthly_bill,
        ownership: lead.ownership,
      });

      try {
        if (newScore !== null && newScore !== previousScore) {
          await this.db.upsertLead(phone, { score: newScore });
          recomputed++;
        }

        const effectiveScore = newScore ?? previousScore;
        await this.labelService.syncAll(phone, effectiveScore, lead.status ?? "new", runtime);
        synced++;

        if ((i + 1) % BATCH_SIZE === 0 && i + 1 < allLeads.length) {
          await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
        }
      } catch (err: any) {
        errors++;
        console.error(`[admin] sync-labels error for ${phone}:`, err.message);
      }
    }

    return [
      `✅ **Sync Labels**`,
      `Total: ${allLeads.length} | Synced: ${synced} | Scores changed: ${recomputed} | Errors: ${errors}`,
      ``,
      `⚠️ Labels sync uses batches de 10 con pausas de 15s para evitar rate limits.`,
    ].join("\n");
  }

  private async handleFollowup(phone: string): Promise<string> {
    const lead = await this.findLead(phone);
    if (!lead) return `Lead not found: ${phone}`;

    if (lead.status === "blocked") return `❌ Lead está bloqueado: ${phone}`;
    if (lead.status === "handed_off") return `⚠️ Lead está en handoff. Usa /takeback primero.`;

    // Reset follow_up_sent_at so the lead becomes eligible for the next follow-up cycle
    await this.db.updateFollowUpSentAt(lead.id, 0);
    // Set last_message_at to 25 hours ago so it passes the silence threshold immediately
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    await this.db.updateLeadTimestamp(lead.id, twentyFiveHoursAgo);

    return `✅ Seguimiento programado: ${phone}\nEl lead será contactado en el próximo ciclo de follow-up (~15 min max).`;
  }

  private async handlePending(): Promise<string> {
    // Find leads where the last message from the lead is newer than last bot reply (or no bot reply)
    const allLeads = await this.db.listLeads({
      status: "qualifying",
    });

    const newLeads = await this.db.listLeads({
      status: "new",
    });

    const pending = [...newLeads, ...allLeads].filter((lead) => {
      if (!lead.last_message_at) return false;
      // No bot reply yet, or lead messaged after bot's last reply
      return !lead.last_bot_reply_at || lead.last_message_at > lead.last_bot_reply_at;
    });

    if (pending.length === 0) {
      return "✅ No hay leads pendientes de respuesta.";
    }

    const lines = pending.map((lead) => {
      const waitTime = formatTimeAgo(Date.now() - lead.last_message_at);
      const name = lead.name || "Sin nombre";
      const score = lead.score || "—";
      return `${lead.phone_number} (${name}) [${score}] — esperando ${waitTime}`;
    });

    return `**⏳ Leads pendientes (${pending.length})**\n\n${lines.join("\n")}`;
  }

  private async handlePause(): Promise<string> {
    if (!this.circuitBreaker) {
      return "❌ Circuit breaker no está habilitado. No se puede pausar.";
    }

    const status = await this.circuitBreaker.getStatus();
    if (status.isTripped) {
      return "⏸️ El bot ya está pausado.";
    }

    // Trip the circuit breaker via DB to stop all bot responses
    await this.db.tripCircuitBreaker("Admin manual pause via /pause");

    return "⏸️ **Bot pausado.** No responderá a ningún lead hasta que uses /resume.";
  }

  private async handleResume(): Promise<string> {
    if (!this.circuitBreaker) {
      return "❌ Circuit breaker no está habilitado.";
    }

    const status = await this.circuitBreaker.getStatus();
    if (!status.isTripped) {
      return "▶️ El bot ya está activo.";
    }

    await this.circuitBreaker.reset();
    return "▶️ **Bot reactivado.** Vuelve a responder a todos los leads.";
  }

  private handleHelp(): string {
    return `**Admin Commands**\n\n/status <phone> - View lead status\n/block <phone> [reason] - Block lead\n/unblock <phone> - Unblock lead\n/handoff <phone> - Force handoff\n/takeback <phone> - Undo handoff, bot resumes\n/reset-lead <phone> - Reset lead state & qualification\n/clear-limit <phone> - Clear rate limit\n/score <phone> <HOT|WARM|COLD|OUT> - Set lead score & apply label\n/recent [N] - List N recent leads\n/sync-leads - Recalcular scores de todos los leads\n/sync-labels - Recalcular scores + sincronizar etiquetas WhatsApp\n/followup <phone> - Forzar seguimiento inmediato a un lead\n/pending - Ver leads sin respuesta del bot\n/pause - Pausar el bot (no responde a nadie)\n/resume - Reactivar el bot\n/rate-status - View rate limit & circuit breaker status\n/reset-breaker - Reset circuit breaker\n/help - Show this help`;
  }

  // --- Shared helpers ---

  private async findLead(phone: string) {
    const digits = normalizePhone(phone);
    const candidates = [digits, `+${digits}`];
    if (digits.startsWith("52") && digits.length === 12) {
      candidates.push(`+521${digits.slice(2)}`);
    }
    if (digits.startsWith("521") && digits.length === 13) {
      candidates.push(`+52${digits.slice(3)}`);
    }
    for (const candidate of candidates) {
      const lead = await this.db.getLeadByPhone(candidate);
      if (lead) return lead;
    }
    return null;
  }

  private formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }
}

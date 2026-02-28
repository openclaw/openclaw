/**
 * BCL Database Layer - SQLite based persistence
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import BetterSqlite3 from "better-sqlite3";
import type {
  Opportunity,
  Project,
  FinanceEntry,
  Wallet,
  Milestone,
  DecisionRecord,
  MemoryEntry,
  HealthStatus,
  BCLAgentType,
  CompetitorAnalysis,
  AgentHealth,
} from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RateLimitRecord {
  provider: string;
  model: string;
  request_count: number;
  last_request: string;
  cooldown_until: string | null;
  failure_count: number;
  success_count: number;
}

export interface CircuitBreakerRecord {
  provider: string;
  state: "closed" | "open" | "half_open";
  failure_count: number;
  last_failure: string | null;
  last_check: string;
}

export interface CacheRecord {
  cache_key: string;
  response: string;
  expires_at: string;
  created_at: string;
}

export interface UsageStatsRecord {
  id?: number;
  provider: string;
  model: string;
  tokens_used: number;
  requests_count: number;
  date: string;
  hour: number;
}

export interface ScheduleRecord {
  agent: string;
  cron: string;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
}

export class Database {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, "../../data/bcl.db");
  }

  initialize(): BetterSqlite3.Database {
    if (this.db) return this.db;

    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_count INTEGER DEFAULT 0,
        last_request TEXT,
        cooldown_until TEXT,
        failure_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        PRIMARY KEY (provider, model)
      );

      CREATE TABLE IF NOT EXISTS circuit_breakers (
        provider TEXT PRIMARY KEY,
        state TEXT DEFAULT 'closed',
        failure_count INTEGER DEFAULT 0,
        last_failure TEXT,
        last_check TEXT
      );

      CREATE TABLE IF NOT EXISTS cache (
        cache_key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        requests_count INTEGER DEFAULT 0,
        date TEXT NOT NULL,
        hour INTEGER NOT NULL,
        UNIQUE(provider, model, date, hour)
      );

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT, score INTEGER DEFAULT 0, confidence REAL DEFAULT 0,
        sources TEXT, timestamp TEXT, status TEXT DEFAULT 'new'
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        github_url TEXT, status TEXT DEFAULT 'planning', revenue REAL DEFAULT 0,
        costs REAL DEFAULT 0, roi REAL DEFAULT 0, created_at TEXT, updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS finance_entries (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, amount REAL NOT NULL,
        currency TEXT NOT NULL, description TEXT, project_id TEXT,
        receipt_path TEXT, timestamp TEXT
      );

      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL,
        balance REAL DEFAULT 0, last_updated TEXT
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, target_value REAL NOT NULL,
        current_value REAL DEFAULT 0, reached_at TEXT, notified INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, decision TEXT NOT NULL, confidence REAL NOT NULL,
        sources TEXT, reasoning TEXT, impact REAL DEFAULT 0,
        human_review INTEGER DEFAULT 0, approved_by TEXT, timestamp TEXT
      );

      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, content TEXT NOT NULL,
        tags TEXT, timestamp TEXT
      );

      CREATE TABLE IF NOT EXISTS schedules (
        agent TEXT PRIMARY KEY,
        cron TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        next_run TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_health (
        agent_type TEXT PRIMARY KEY, status TEXT DEFAULT 'healthy',
        last_run TEXT, error_count INTEGER DEFAULT 0, last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS competitor_analyses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        pricing TEXT,
        features TEXT,
        marketing_strategy TEXT,
        strengths TEXT,
        weaknesses TEXT,
        lessons_learned TEXT,
        timestamp TEXT
      );

      CREATE TABLE IF NOT EXISTS marketing_campaigns (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT DEFAULT 'planning',
        content TEXT,
        start_date TEXT,
        end_date TEXT,
        metrics TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS landing_pages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        headline TEXT,
        subheadline TEXT,
        cta TEXT,
        sections TEXT,
        seo_title TEXT,
        seo_description TEXT,
        seo_keywords TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS social_posts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        content TEXT,
        title TEXT,
        media_urls TEXT,
        link TEXT,
        scheduled_at TEXT,
        posted_at TEXT,
        engagement TEXT
      );

      CREATE TABLE IF NOT EXISTS blog_posts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        content TEXT,
        excerpt TEXT,
        tags TEXT,
        seo_title TEXT,
        seo_description TEXT,
        seo_keywords TEXT,
        status TEXT DEFAULT 'draft',
        published_at TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS feedback_analyses (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        sentiment TEXT NOT NULL,
        summary TEXT,
        key_points TEXT,
        action_items TEXT,
        timestamp TEXT
      );
    `);

    return this.db;
  }

  getDb(): BetterSqlite3.Database {
    if (!this.db) return this.initialize();
    return this.db;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  recordRequest(provider: string, model: string): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO rate_limits (provider, model, request_count, last_request, failure_count, success_count)
      VALUES (?, ?, 1, ?, 0, 0)
      ON CONFLICT(provider, model) DO UPDATE SET
        request_count = request_count + 1,
        last_request = ?
    `).run(provider, model, now, now);
  }

  getCooldown(provider: string, model: string): number | null {
    const db = this.getDb();
    const row = db
      .prepare("SELECT cooldown_until FROM rate_limits WHERE provider = ? AND model = ?")
      .get(provider, model) as { cooldown_until: string | null } | undefined;
    if (!row?.cooldown_until) return null;
    const cooldownUntil = new Date(row.cooldown_until).getTime();
    const now = Date.now();
    if (cooldownUntil <= now) {
      db.prepare(
        "UPDATE rate_limits SET cooldown_until = NULL WHERE provider = ? AND model = ?",
      ).run(provider, model);
      return null;
    }
    return cooldownUntil - now;
  }

  recordRateLimit(provider: string, model: string, retryAfterMs: number): void {
    const db = this.getDb();
    const cooldownUntil = new Date(Date.now() + retryAfterMs).toISOString();
    db.prepare(`
      INSERT INTO rate_limits (provider, model, cooldown_until, failure_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(provider, model) DO UPDATE SET
        cooldown_until = ?,
        failure_count = failure_count + 1
    `).run(provider, model, cooldownUntil, cooldownUntil);
  }

  recordSuccess(provider: string, model: string): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO rate_limits (provider, model, success_count)
      VALUES (?, ?, 1)
      ON CONFLICT(provider, model) DO UPDATE SET
        success_count = success_count + 1,
        cooldown_until = NULL
    `).run(provider, model);
  }

  recordFailure(provider: string, model: string): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO rate_limits (provider, model, failure_count)
      VALUES (?, ?, 1)
      ON CONFLICT(provider, model) DO UPDATE SET
        failure_count = failure_count + 1
    `).run(provider, model);
  }

  getCircuitBreakerState(provider: string): CircuitBreakerRecord | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM circuit_breakers WHERE provider = ?").get(provider) as
      | CircuitBreakerRecord
      | undefined;
    return row || null;
  }

  setCircuitBreakerState(
    provider: string,
    state: "closed" | "open" | "half_open",
    failureCount: number = 0,
  ): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    const lastFailure = state === "open" ? now : null;
    db.prepare(`
      INSERT INTO circuit_breakers (provider, state, failure_count, last_failure, last_check)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        state = ?,
        failure_count = ?,
        last_failure = COALESCE(?, last_failure),
        last_check = ?
    `).run(provider, state, failureCount, lastFailure, now, state, failureCount, lastFailure, now);
  }

  getCache(key: string): unknown | null {
    const db = this.getDb();
    const row = db.prepare("SELECT response, expires_at FROM cache WHERE cache_key = ?").get(key) as
      | { response: string; expires_at: string }
      | undefined;
    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) {
      db.prepare("DELETE FROM cache WHERE cache_key = ?").run(key);
      return null;
    }
    return JSON.parse(row.response);
  }

  setCache(key: string, value: unknown, ttlMs: number): void {
    const db = this.getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    db.prepare(`
      INSERT INTO cache (cache_key, response, expires_at, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response = ?,
        expires_at = ?,
        created_at = ?
    `).run(
      key,
      JSON.stringify(value),
      expiresAt.toISOString(),
      now.toISOString(),
      JSON.stringify(value),
      expiresAt.toISOString(),
      now.toISOString(),
    );
  }

  cleanupExpired(): number {
    const db = this.getDb();
    const now = new Date().toISOString();
    const result = db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now);
    return result.changes;
  }

  recordUsageStats(provider: string, model: string, tokensUsed: number = 0): void {
    const db = this.getDb();
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const hour = now.getHours();
    db.prepare(`
      INSERT INTO api_usage_stats (provider, model, tokens_used, requests_count, date, hour)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(provider, model, date, hour) DO UPDATE SET
        tokens_used = tokens_used + ?,
        requests_count = requests_count + 1
    `).run(provider, model, tokensUsed, date, hour, tokensUsed);
  }

  getUsageStats(
    provider?: string,
    model?: string,
    startDate?: string,
    endDate?: string,
  ): UsageStatsRecord[] {
    const db = this.getDb();
    let query = "SELECT * FROM api_usage_stats WHERE 1=1";
    const params: unknown[] = [];

    if (provider) {
      query += " AND provider = ?";
      params.push(provider);
    }
    if (model) {
      query += " AND model = ?";
      params.push(model);
    }
    if (startDate) {
      query += " AND date >= ?";
      params.push(startDate);
    }
    if (endDate) {
      query += " AND date <= ?";
      params.push(endDate);
    }

    query += " ORDER BY date DESC, hour DESC";
    return db.prepare(query).all(...params) as UsageStatsRecord[];
  }

  saveOpportunity(opp: Opportunity): void {
    const db = this.getDb();
    db.prepare(`INSERT OR REPLACE INTO opportunities (id, source, title, description, score, confidence, sources, timestamp, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      opp.id,
      opp.source,
      opp.title,
      opp.description,
      opp.score,
      opp.confidence,
      JSON.stringify(opp.sources),
      opp.timestamp.toISOString(),
      opp.status,
    );
  }

  getOpportunities(status?: string): Opportunity[] {
    const db = this.getDb();
    const rows = status
      ? db.prepare("SELECT * FROM opportunities WHERE status = ?").all(status)
      : db.prepare("SELECT * FROM opportunities").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      source: row.source as string,
      title: row.title as string,
      description: row.description as string | undefined,
      score: row.score as number,
      confidence: row.confidence as number,
      sources: JSON.parse((row.sources as string) || "[]"),
      timestamp: new Date(row.timestamp as string),
      status: row.status as string,
    }));
  }

  deleteOpportunity(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM opportunities WHERE id = ?").run(id);
  }

  saveProject(project: Project): void {
    const db = this.getDb();
    db.prepare(`INSERT OR REPLACE INTO projects (id, name, description, github_url, status, revenue, costs, roi, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      project.id,
      project.name,
      project.description,
      project.github_url,
      project.status,
      project.revenue,
      project.costs,
      project.roi,
      project.created_at.toISOString(),
      project.updated_at.toISOString(),
    );
  }

  getProjects(status?: string): Project[] {
    const db = this.getDb();
    const rows = status
      ? db.prepare("SELECT * FROM projects WHERE status = ?").all(status)
      : db.prepare("SELECT * FROM projects").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      github_url: row.github_url as string | undefined,
      status: row.status as string,
      revenue: row.revenue as number,
      costs: row.costs as number,
      roi: row.roi as number,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    }));
  }

  deleteProject(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  saveFinanceEntry(entry: FinanceEntry): void {
    const db = this.getDb();
    db.prepare(`INSERT OR REPLACE INTO finance_entries (id, type, amount, currency, description, project_id, receipt_path, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.id,
      entry.type,
      entry.amount,
      entry.currency,
      entry.description,
      entry.project_id,
      entry.receipt_path,
      entry.timestamp.toISOString(),
    );
  }

  getFinanceEntries(projectId?: string): FinanceEntry[] {
    const db = this.getDb();
    const rows = projectId
      ? db.prepare("SELECT * FROM finance_entries WHERE project_id = ?").all(projectId)
      : db.prepare("SELECT * FROM finance_entries").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      type: row.type as "income" | "expense",
      amount: row.amount as number,
      currency: row.currency as string,
      description: row.description as string | undefined,
      project_id: row.project_id as string | undefined,
      receipt_path: row.receipt_path as string | undefined,
      timestamp: new Date(row.timestamp as string),
    }));
  }

  deleteFinanceEntry(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM finance_entries WHERE id = ?").run(id);
  }

  saveWallet(wallet: Wallet): void {
    const db = this.getDb();
    db.prepare(
      "INSERT OR REPLACE INTO wallets (id, chain, address, balance, last_updated) VALUES (?, ?, ?, ?, ?)",
    ).run(
      wallet.id,
      wallet.chain,
      wallet.address,
      wallet.balance,
      wallet.last_updated.toISOString(),
    );
  }

  getWallets(): Wallet[] {
    const db = this.getDb();
    return db
      .prepare("SELECT * FROM wallets")
      .all()
      .map((row: Record<string, unknown>) => ({
        id: row.id as string,
        chain: row.chain as string,
        address: row.address as string,
        balance: row.balance as number,
        last_updated: new Date(row.last_updated as string),
      }));
  }

  deleteWallet(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM wallets WHERE id = ?").run(id);
  }

  saveMilestone(milestone: Milestone): void {
    const db = this.getDb();
    db.prepare(
      "INSERT OR REPLACE INTO milestones (id, type, target_value, current_value, reached_at, notified) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      milestone.id,
      milestone.type,
      milestone.target_value,
      milestone.current_value,
      milestone.reached_at?.toISOString() || null,
      milestone.notified ? 1 : 0,
    );
  }

  getMilestones(): Milestone[] {
    const db = this.getDb();
    return db
      .prepare("SELECT * FROM milestones")
      .all()
      .map((row: Record<string, unknown>) => ({
        id: row.id as string,
        type: row.type as string,
        target_value: row.target_value as number,
        current_value: row.current_value as number,
        reached_at: row.reached_at ? new Date(row.reached_at as string) : undefined,
        notified: row.notified === 1,
      }));
  }

  deleteMilestone(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM milestones WHERE id = ?").run(id);
  }

  saveDecision(decision: DecisionRecord): void {
    const db = this.getDb();
    db.prepare(`INSERT OR REPLACE INTO decisions (id, decision, confidence, sources, reasoning, impact, human_review, approved_by, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decision.id,
      decision.decision,
      decision.confidence,
      JSON.stringify(decision.sources),
      decision.reasoning,
      decision.impact,
      decision.human_review ? 1 : 0,
      decision.approved_by,
      decision.timestamp.toISOString(),
    );
  }

  getDecisions(limit: number = 100): DecisionRecord[] {
    const db = this.getDb();
    return db
      .prepare("SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?")
      .all(limit)
      .map((row: Record<string, unknown>) => ({
        id: row.id as string,
        decision: row.decision as string,
        confidence: row.confidence as number,
        sources: JSON.parse((row.sources as string) || "[]"),
        reasoning: row.reasoning as string | undefined,
        impact: row.impact as number,
        human_review: row.human_review === 1,
        approved_by: row.approved_by as string | undefined,
        timestamp: new Date(row.timestamp as string),
      }));
  }

  deleteDecision(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM decisions WHERE id = ?").run(id);
  }

  saveMemory(memory: MemoryEntry): void {
    const db = this.getDb();
    db.prepare(
      "INSERT OR REPLACE INTO memory (id, category, content, tags, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run(
      memory.id,
      memory.category,
      memory.content,
      JSON.stringify(memory.tags),
      memory.timestamp.toISOString(),
    );
  }

  getMemory(category?: string): MemoryEntry[] {
    const db = this.getDb();
    const rows = category
      ? db.prepare("SELECT * FROM memory WHERE category = ?").all(category)
      : db.prepare("SELECT * FROM memory").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      category: row.category as string,
      content: row.content as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      timestamp: new Date(row.timestamp as string),
    }));
  }

  deleteMemory(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM memory WHERE id = ?").run(id);
  }

  saveSchedule(agent: string, cron: string, enabled: boolean = true, nextRun?: string): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO schedules (agent, cron, enabled, next_run)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET
        cron = ?,
        enabled = ?,
        next_run = ?
    `).run(agent, cron, enabled ? 1 : 0, nextRun || null, cron, enabled ? 1 : 0, nextRun || null);
  }

  getSchedules(enabledOnly: boolean = false): ScheduleRecord[] {
    const db = this.getDb();
    const rows = enabledOnly
      ? db.prepare("SELECT * FROM schedules WHERE enabled = 1").all()
      : db.prepare("SELECT * FROM schedules").all();
    return rows.map((row: Record<string, unknown>) => ({
      agent: row.agent as string,
      cron: row.cron as string,
      enabled: row.enabled as number,
      last_run: row.last_run as string | null,
      next_run: row.next_run as string | null,
    }));
  }

  updateScheduleLastRun(agent: string, lastRun: string, nextRun: string): void {
    const db = this.getDb();
    db.prepare("UPDATE schedules SET last_run = ?, next_run = ? WHERE agent = ?").run(
      lastRun,
      nextRun,
      agent,
    );
  }

  deleteSchedule(agent: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM schedules WHERE agent = ?").run(agent);
  }

  updateAgentHealth(
    agentType: BCLAgentType,
    status: "healthy" | "degraded" | "down",
    error?: string,
  ): void {
    const db = this.getDb();
    const existing = db
      .prepare("SELECT error_count FROM agent_health WHERE agent_type = ?")
      .get(agentType) as { error_count: number } | undefined;
    const errorCount = (existing?.error_count || 0) + (error ? 1 : 0);
    db.prepare(
      "INSERT OR REPLACE INTO agent_health (agent_type, status, last_run, error_count, last_error) VALUES (?, ?, ?, ?, ?)",
    ).run(agentType, status, new Date().toISOString(), errorCount, error || null);
  }

  getHealthStatus(): HealthStatus {
    const db = this.getDb();
    const rows = db.prepare("SELECT * FROM agent_health").all() as {
      agent_type: string;
      status: "healthy" | "degraded" | "down";
      last_run: string | null;
      error_count: number;
      last_error: string | null;
    }[];
    const agents: Record<BCLAgentType, AgentHealth> = {} as Record<BCLAgentType, AgentHealth>;
    for (const row of rows) {
      if (row.agent_type && Object.prototype.hasOwnProperty.call(agents, row.agent_type)) {
        continue;
      }
      agents[row.agent_type as BCLAgentType] = {
        status: row.status,
        last_run: row.last_run ? new Date(row.last_run) : undefined,
        error_count: row.error_count,
        last_error: row.last_error || undefined,
      };
    }
    return { agents, database: true, last_check: new Date() };
  }

  saveCompetitorAnalysis(analysis: CompetitorAnalysis): void {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO competitor_analyses 
      (id, name, url, pricing, features, marketing_strategy, strengths, weaknesses, lessons_learned, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      analysis.id,
      analysis.name,
      analysis.url,
      analysis.pricing,
      JSON.stringify(analysis.features),
      analysis.marketing_strategy,
      JSON.stringify(analysis.strengths),
      JSON.stringify(analysis.weaknesses),
      JSON.stringify(analysis.lessons_learned),
      analysis.timestamp.toISOString(),
    );
  }

  getCompetitorAnalyses(): CompetitorAnalysis[] {
    const db = this.getDb();
    const rows = db.prepare("SELECT * FROM competitor_analyses ORDER BY timestamp DESC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      url: row.url as string,
      pricing: row.pricing as string,
      features: JSON.parse((row.features as string) || "[]"),
      marketing_strategy: row.marketing_strategy as string,
      strengths: JSON.parse((row.strengths as string) || "[]"),
      weaknesses: JSON.parse((row.weaknesses as string) || "[]"),
      lessons_learned: JSON.parse((row.lessons_learned as string) || "[]"),
      timestamp: new Date(row.timestamp as string),
    }));
  }

  deleteCompetitorAnalysis(id: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM competitor_analyses WHERE id = ?").run(id);
  }

  saveMarketingCampaign(campaign: {
    id: string;
    projectId: string;
    name: string;
    type: string;
    status: string;
    content: unknown[];
    startDate: Date;
    endDate?: Date;
    metrics?: unknown;
    createdAt: Date;
  }): void {
    const db = this.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO marketing_campaigns (id, project_id, name, type, status, content, start_date, end_date, metrics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      campaign.id,
      campaign.projectId,
      campaign.name,
      campaign.type,
      campaign.status,
      JSON.stringify(campaign.content),
      campaign.startDate.toISOString(),
      campaign.endDate?.toISOString() || null,
      campaign.metrics ? JSON.stringify(campaign.metrics) : null,
      campaign.createdAt.toISOString(),
    );
  }

  getMarketingCampaigns(): {
    id: string;
    projectId: string;
    name: string;
    type: string;
    status: string;
    content: unknown[];
    startDate: Date;
    endDate?: Date;
    metrics?: unknown;
    createdAt: Date;
  }[] {
    const db = this.getDb();
    const rows = db.prepare("SELECT * FROM marketing_campaigns ORDER BY created_at DESC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      name: row.name as string,
      type: row.type as string,
      status: row.status as string,
      content: JSON.parse((row.content as string) || "[]"),
      startDate: new Date(row.start_date as string),
      endDate: row.end_date ? new Date(row.end_date as string) : undefined,
      metrics: row.metrics ? JSON.parse(row.metrics as string) : undefined,
      createdAt: new Date(row.created_at as string),
    }));
  }

  updateCampaignStatus(campaignId: string, status: string): void {
    const db = this.getDb();
    db.prepare("UPDATE marketing_campaigns SET status = ? WHERE id = ?").run(status, campaignId);
  }

  addContentToCampaign(campaignId: string, content: unknown): void {
    const db = this.getDb();
    const campaign = db
      .prepare("SELECT content FROM marketing_campaigns WHERE id = ?")
      .get(campaignId) as { content: string } | undefined;
    if (campaign) {
      const existingContent = JSON.parse((campaign.content as string) || "[]");
      existingContent.push(content);
      db.prepare("UPDATE marketing_campaigns SET content = ? WHERE id = ?").run(
        JSON.stringify(existingContent),
        campaignId,
      );
    }
  }

  updateContentStatus(campaignId: string, contentId: string, status: string): void {
    const db = this.getDb();
    const campaign = db
      .prepare("SELECT content FROM marketing_campaigns WHERE id = ?")
      .get(campaignId) as { content: string } | undefined;
    if (campaign) {
      const content = JSON.parse((campaign.content as string) || "[]");
      const updatedContent = content.map((c: { id: string }) =>
        c.id === contentId ? { ...c, status } : c,
      );
      db.prepare("UPDATE marketing_campaigns SET content = ? WHERE id = ?").run(
        JSON.stringify(updatedContent),
        campaignId,
      );
    }
  }

  saveLandingPage(landingPage: {
    id: string;
    projectId: string;
    title: string;
    headline: string;
    subheadline: string;
    cta: string;
    sections: unknown[];
    seoTitle: string;
    seoDescription: string;
    seoKeywords: string[];
    createdAt: Date;
  }): void {
    const db = this.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO landing_pages (id, project_id, title, headline, subheadline, cta, sections, seo_title, seo_description, seo_keywords, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      landingPage.id,
      landingPage.projectId,
      landingPage.title,
      landingPage.headline,
      landingPage.subheadline,
      landingPage.cta,
      JSON.stringify(landingPage.sections),
      landingPage.seoTitle,
      landingPage.seoDescription,
      JSON.stringify(landingPage.seoKeywords),
      landingPage.createdAt.toISOString(),
    );
  }

  getLandingPages(projectId?: string): {
    id: string;
    projectId: string;
    title: string;
    headline: string;
    subheadline: string;
    cta: string;
    sections: unknown[];
    seoTitle: string;
    seoDescription: string;
    seoKeywords: string[];
    createdAt: Date;
  }[] {
    const db = this.getDb();
    const rows = projectId
      ? db
          .prepare("SELECT * FROM landing_pages WHERE project_id = ? ORDER BY created_at DESC")
          .all(projectId)
      : db.prepare("SELECT * FROM landing_pages ORDER BY created_at DESC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      headline: row.headline as string,
      subheadline: row.subheadline as string,
      cta: row.cta as string,
      sections: JSON.parse((row.sections as string) || "[]"),
      seoTitle: row.seo_title as string,
      seoDescription: row.seo_description as string,
      seoKeywords: JSON.parse((row.seo_keywords as string) || "[]"),
      createdAt: new Date(row.created_at as string),
    }));
  }

  saveSocialPost(post: {
    id: string;
    projectId: string;
    platform: string;
    content: string;
    title?: string;
    mediaUrls?: string[];
    link?: string;
    scheduledAt?: Date;
    postedAt?: Date;
    engagement?: unknown;
  }): void {
    const db = this.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO social_posts (id, project_id, platform, content, title, media_urls, link, scheduled_at, posted_at, engagement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      post.id,
      post.projectId,
      post.platform,
      post.content,
      post.title || null,
      post.mediaUrls ? JSON.stringify(post.mediaUrls) : null,
      post.link || null,
      post.scheduledAt?.toISOString() || null,
      post.postedAt?.toISOString() || null,
      post.engagement ? JSON.stringify(post.engagement) : null,
    );
  }

  getSocialPosts(projectId?: string): {
    id: string;
    projectId: string;
    platform: string;
    content: string;
    title?: string;
    mediaUrls?: string[];
    link?: string;
    scheduledAt?: Date;
    postedAt?: Date;
    engagement?: unknown;
  }[] {
    const db = this.getDb();
    const rows = projectId
      ? db
          .prepare("SELECT * FROM social_posts WHERE project_id = ? ORDER BY created_at DESC")
          .all(projectId)
      : db.prepare("SELECT * FROM social_posts ORDER BY created_at DESC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      platform: row.platform as string,
      content: row.content as string,
      title: row.title as string | undefined,
      mediaUrls: row.media_urls ? JSON.parse(row.media_urls as string) : undefined,
      link: row.link as string | undefined,
      scheduledAt: row.scheduled_at ? new Date(row.scheduled_at as string) : undefined,
      postedAt: row.posted_at ? new Date(row.posted_at as string) : undefined,
      engagement: row.engagement ? JSON.parse(row.engagement as string) : undefined,
    }));
  }

  saveBlogPost(post: {
    id: string;
    projectId: string;
    title: string;
    slug: string;
    content: string;
    excerpt: string;
    tags: string[];
    seoTitle: string;
    seoDescription: string;
    seoKeywords: string[];
    status: string;
    publishedAt?: Date;
    createdAt: Date;
  }): void {
    const db = this.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO blog_posts (id, project_id, title, slug, content, excerpt, tags, seo_title, seo_description, seo_keywords, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      post.id,
      post.projectId,
      post.title,
      post.slug,
      post.content,
      post.excerpt,
      JSON.stringify(post.tags),
      post.seoTitle,
      post.seoDescription,
      JSON.stringify(post.seoKeywords),
      post.status,
      post.publishedAt?.toISOString() || null,
      post.createdAt.toISOString(),
    );
  }

  getBlogPosts(projectId?: string): {
    id: string;
    projectId: string;
    title: string;
    slug: string;
    content: string;
    excerpt: string;
    tags: string[];
    seoTitle: string;
    seoDescription: string;
    seoKeywords: string[];
    status: string;
    publishedAt?: Date;
    createdAt: Date;
  }[] {
    const db = this.getDb();
    const rows = projectId
      ? db
          .prepare("SELECT * FROM blog_posts WHERE project_id = ? ORDER BY created_at DESC")
          .all(projectId)
      : db.prepare("SELECT * FROM blog_posts ORDER BY created_at DESC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      slug: row.slug as string,
      content: row.content as string,
      excerpt: row.excerpt as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      seoTitle: row.seo_title as string,
      seoDescription: row.seo_description as string,
      seoKeywords: JSON.parse((row.seo_keywords as string) || "[]"),
      status: row.status as string,
      publishedAt: row.published_at ? new Date(row.published_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
    }));
  }

  saveFeedbackAnalysis(analysis: {
    id: string;
    projectId: string;
    source: string;
    sentiment: string;
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    timestamp: Date;
  }): void {
    const db = this.getDb();
    db.prepare(
      `INSERT OR REPLACE INTO feedback_analyses (id, project_id, source, sentiment, summary, key_points, action_items, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      analysis.id,
      analysis.projectId,
      analysis.source,
      analysis.sentiment,
      analysis.summary,
      JSON.stringify(analysis.keyPoints),
      JSON.stringify(analysis.actionItems),
      analysis.timestamp.toISOString(),
    );
  }

  getFeedbackAnalyses(projectId?: string): {
    id: string;
    projectId: string;
    source: string;
    sentiment: string;
    summary: string;
    keyPoints: string[];
    actionItems: string[];
    timestamp: Date;
  }[] {
    const db = this.getDb();
    const rows = projectId
      ? db
          .prepare("SELECT * FROM feedback_analyses WHERE project_id = ? ORDER BY timestamp DESC")
          .all(projectId)
      : db.prepare("SELECT * FROM feedback_analyses ORDER BY timestamp DESC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      source: row.source as string,
      sentiment: row.sentiment as string,
      summary: row.summary as string,
      keyPoints: JSON.parse((row.key_points as string) || "[]"),
      actionItems: JSON.parse((row.action_items as string) || "[]"),
      timestamp: new Date(row.timestamp as string),
    }));
  }
}

let databaseInstance: Database | null = null;

export function initDatabase(dbPath?: string): Database {
  if (!databaseInstance) {
    databaseInstance = new Database(dbPath);
  }
  return databaseInstance;
}

export function getDatabase(): Database {
  if (!databaseInstance) {
    return initDatabase();
  }
  return databaseInstance;
}

export function closeDatabase(): void {
  if (databaseInstance) {
    databaseInstance.close();
    databaseInstance = null;
  }
}

export function saveOpportunity(opp: Opportunity): void {
  const database = new Database();
  database.initialize();
  database.saveOpportunity(opp);
}

export function getOpportunities(status?: string): Opportunity[] {
  const database = new Database();
  database.initialize();
  return database.getOpportunities(status);
}

export function saveProject(project: Project): void {
  const database = new Database();
  database.initialize();
  database.saveProject(project);
}

export function getProjects(status?: string): Project[] {
  const database = new Database();
  database.initialize();
  return database.getProjects(status);
}

export function saveFinanceEntry(entry: FinanceEntry): void {
  const database = new Database();
  database.initialize();
  database.saveFinanceEntry(entry);
}

export function getFinanceEntries(projectId?: string): FinanceEntry[] {
  const database = new Database();
  database.initialize();
  return database.getFinanceEntries(projectId);
}

export function saveWallet(wallet: Wallet): void {
  const database = new Database();
  database.initialize();
  database.saveWallet(wallet);
}

export function getWallets(): Wallet[] {
  const database = new Database();
  database.initialize();
  return database.getWallets();
}

export function saveMilestone(milestone: Milestone): void {
  const database = new Database();
  database.initialize();
  database.saveMilestone(milestone);
}

export function getMilestones(): Milestone[] {
  const database = new Database();
  database.initialize();
  return database.getMilestones();
}

export function saveDecision(decision: DecisionRecord): void {
  const database = new Database();
  database.initialize();
  database.saveDecision(decision);
}

export function getDecisions(limit: number = 100): DecisionRecord[] {
  const database = new Database();
  database.initialize();
  return database.getDecisions(limit);
}

export function saveMemory(memory: MemoryEntry): void {
  const database = new Database();
  database.initialize();
  database.saveMemory(memory);
}

export function getMemory(category?: string): MemoryEntry[] {
  const database = new Database();
  database.initialize();
  return database.getMemory(category);
}

export function updateAgentHealth(
  agentType: BCLAgentType,
  status: "healthy" | "degraded" | "down",
  error?: string,
): void {
  const database = new Database();
  database.initialize();
  database.updateAgentHealth(agentType, status, error);
}

export function getHealthStatus(): HealthStatus {
  const database = new Database();
  database.initialize();
  return database.getHealthStatus();
}

export function saveCompetitorAnalysis(analysis: CompetitorAnalysis): void {
  const database = new Database();
  database.initialize();
  database.saveCompetitorAnalysis(analysis);
}

export function getCompetitorAnalyses(): CompetitorAnalysis[] {
  const database = new Database();
  database.initialize();
  return database.getCompetitorAnalyses();
}

export function deleteCompetitorAnalysis(id: string): void {
  const database = new Database();
  database.initialize();
  database.deleteCompetitorAnalysis(id);
}

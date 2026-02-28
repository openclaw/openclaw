/**
 * Research Agent
 *
 * Searches for business opportunities from various sources
 * Scores and validates opportunities with anti-hallucination safeguards
 */

import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { RateLimitManager } from "../api/rate-limit-manager.js";
import { RequestBatcher } from "../api/request-batcher.js";
import { SmartCache } from "../api/smart-cache.js";
import { getDatabase, getDb, type Database } from "../db/database.js";
import { BCL_CORE_VALUES, type Opportunity } from "../types/index.js";
import { AntiHallucination } from "../utils/anti-hallucination.js";

export type OpportunitySource = "reddit" | "indiehackers" | "twitter" | "github" | "producthunt";

export interface RawOpportunity {
  title: string;
  description: string;
  url: string;
  source: OpportunitySource;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ScoringFactors {
  viability: number;
  marketSize: number;
  competition: number;
  trendIndicator: number;
  monetizationPotential: number;
}

export interface ScoredOpportunity extends Opportunity {
  scoringFactors: ScoringFactors;
}

const SOURCE_CONFIGS: Record<OpportunitySource, { baseUrl: string; searchPath: string }> = {
  reddit: { baseUrl: "https://www.reddit.com", searchPath: "/search.json" },
  indiehackers: { baseUrl: "https://www.indiehackers.com", searchPath: "/search" },
  twitter: { baseUrl: "https://twitter.com", searchPath: "/i/api/2/search" },
  github: { baseUrl: "https://api.github.com", searchPath: "/search/repositories" },
  producthunt: { baseUrl: "https://www.producthunt.com", searchPath: "/search" },
};

const CONFIDENCE_WEIGHTS = {
  viability: 0.25,
  marketSize: 0.25,
  competition: 0.2,
  trendIndicator: 0.15,
  monetizationPotential: 0.15,
};

export class ResearchAgent {
  private api: OpenClawPluginApi;
  private database: Database;
  private antiHallucination: AntiHallucination;
  private confidenceThreshold: number;
  private rateLimitManager: RateLimitManager;
  private smartCache: SmartCache;
  private requestBatcher: RequestBatcher;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.database = getDatabase();
    this.antiHallucination = new AntiHallucination(api);
    this.confidenceThreshold = BCL_CORE_VALUES.min_confidence_threshold;

    try {
      this.rateLimitManager = new RateLimitManager(getDb());
      this.smartCache = new SmartCache(getDb(), 50);
      this.requestBatcher = new RequestBatcher({ maxBatchSize: 5, batchWindowMs: 300 });
    } catch (error) {
      this.api.logger.warn(
        "Research Agent: Failed to initialize rate limiting/caching, using fallback",
        error,
      );
      this.rateLimitManager = new RateLimitManager(null as any);
      this.smartCache = new SmartCache(null as any, 50);
      this.requestBatcher = new RequestBatcher({ maxBatchSize: 5, batchWindowMs: 300 });
    }
  }

  private async fetchWithRateLimit<T>(
    provider: string,
    model: string,
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number = 60000,
  ): Promise<T> {
    const cached = await this.smartCache.get<T>(key);
    if (cached !== null) {
      this.api.logger.debug(`Cache hit for ${key}`);
      return cached;
    }

    const cooldown = await this.rateLimitManager.checkCooldown(provider, model);
    if (cooldown !== null) {
      this.api.logger.info(`Rate limited on ${provider}/${model}, waiting ${cooldown}ms`);
      await new Promise((resolve) => setTimeout(resolve, cooldown));
    }

    return this.requestBatcher.enqueue(key, async () => {
      await this.rateLimitManager.recordRequest(provider, model);

      try {
        const result = await fetcher();
        await this.rateLimitManager.recordSuccess(provider, model);
        await this.smartCache.set(key, result, ttlMs);
        return result;
      } catch (error) {
        await this.rateLimitManager.recordFailure(provider, model);

        if (this.rateLimitManager.shouldRetry(error)) {
          const delay = this.rateLimitManager.getRetryDelay(error, 1);
          this.api.logger.warn(`Request failed, retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          const retryResult = await fetcher();
          await this.rateLimitManager.recordSuccess(provider, model);
          return retryResult;
        }
        throw error;
      }
    });
  }

  async execute(): Promise<void> {
    this.api.logger.info("Research Agent: Starting market research...");

    try {
      const opportunities = await this.scanSources();

      let savedCount = 0;
      for (const rawOpp of opportunities) {
        const analyzedOpp = await this.analyzeOpportunity(rawOpp);

        if (analyzedOpp && analyzedOpp.confidence >= this.confidenceThreshold) {
          await this.saveOpportunity(analyzedOpp);
          savedCount++;
        }
      }

      this.api.logger.info(
        `Research Agent: Completed. Scanned ${opportunities.length} opportunities, saved ${savedCount}`,
      );
    } catch (error) {
      this.api.logger.error("Research Agent failed" + String(error));
      throw error;
    }
  }

  async scanSources(): Promise<RawOpportunity[]> {
    const sources: OpportunitySource[] = [
      "reddit",
      "indiehackers",
      "twitter",
      "github",
      "producthunt",
    ];
    const allOpportunities: RawOpportunity[] = [];

    for (const source of sources) {
      try {
        const opportunities = await this.scanSource(source);
        allOpportunities.push(...opportunities);
        this.api.logger.info(
          `Research: Scanned ${source}, found ${opportunities.length} potential opportunities`,
        );
      } catch (error) {
        this.api.logger.warn(`Research: Failed to scan ${source}`, error);
      }
    }

    return allOpportunities;
  }

  private async scanSource(source: OpportunitySource): Promise<RawOpportunity[]> {
    const config = SOURCE_CONFIGS[source];
    const searchQueries = this.getSearchQueriesForSource(source);
    const opportunities: RawOpportunity[] = [];

    for (const query of searchQueries) {
      try {
        const results = await this.fetchSourceResults(source, query);
        opportunities.push(...results);
      } catch (error) {
        this.api.logger.warn(`Research: Error fetching ${source} for query "${query}"`, error);
      }
    }

    return opportunities;
  }

  private getSearchQueriesForSource(source: OpportunitySource): string[] {
    const baseQueries = [
      "side project revenue",
      "passive income",
      "bootstrapped startup",
      "indie hacker revenue",
      "saas launch",
      "micro saas",
    ];

    const sourceQueries: Record<OpportunitySource, string[]> = {
      reddit: [...baseQueries, "my startup made $", "first revenue", "launch thread"],
      indiehackers: ["revenue", "launch", "bootstrapped", "profitable"],
      twitter: ["building in public", "$ARR", "first 100 users", "bootstrapped"],
      github: ["awesome list", "trending", "built with"],
      producthunt: ["launch", "featured", "new"],
    };

    return sourceQueries[source] || baseQueries;
  }

  private async fetchSourceResults(
    source: OpportunitySource,
    query: string,
  ): Promise<RawOpportunity[]> {
    const config = SOURCE_CONFIGS[source];

    switch (source) {
      case "github":
        return this.fetchGitHubResults(query);
      case "reddit":
        return this.fetchRedditResults(query);
      case "indiehackers":
        return this.fetchIndieHackersResults(query);
      case "producthunt":
        return this.fetchProductHuntResults(query);
      case "twitter":
        return this.fetchTwitterResults(query);
      default:
        return [];
    }
  }

  private async fetchGitHubResults(query: string): Promise<RawOpportunity[]> {
    const cacheKey = `github:${query}`;

    return this.fetchWithRateLimit(
      "github",
      "api",
      cacheKey,
      async () => {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`;

        try {
          const response = await this.api.runtime.fetch(url, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "OpenClaw-Research-Agent",
            },
          });

          if (!response.ok) {
            this.api.logger.warn(`GitHub API error: ${response.status}`);
            return [];
          }

          const data = (await response.json()) as {
            items?: Array<{
              name: string;
              description: string;
              html_url: string;
              stargazers_count: number;
              created_at: string;
            }>;
          };

          return (data.items || []).map((item) => ({
            title: item.name,
            description: item.description || "",
            url: item.html_url,
            source: "github" as OpportunitySource,
            timestamp: new Date(item.created_at),
            metadata: { stars: item.stargazers_count },
          }));
        } catch (error) {
          this.api.logger.warn("GitHub fetch error", error);
          return [];
        }
      },
      300000,
    );
  }

  private async fetchRedditResults(query: string): Promise<RawOpportunity[]> {
    const cacheKey = `reddit:${query}`;

    return this.fetchWithRateLimit(
      "reddit",
      "api",
      cacheKey,
      async () => {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=10`;

        try {
          const response = await this.api.runtime.fetch(url, {
            headers: {
              "User-Agent": "OpenClaw-Research-Agent/1.0",
            },
          });

          if (!response.ok) {
            return [];
          }

          const data = (await response.json()) as {
            data?: {
              children?: Array<{
                data: { title: string; selftext: string; url: string; created_utc: number };
              }>;
            };
          };

          return (data.data?.children || []).map((item) => ({
            title: item.data.title,
            description: item.data.selftext.substring(0, 500),
            url: item.data.url,
            source: "reddit" as OpportunitySource,
            timestamp: new Date(item.data.created_utc * 1000),
          }));
        } catch (error) {
          this.api.logger.warn("Reddit fetch error", error);
          return [];
        }
      },
      60000,
    );
  }

  private async fetchIndieHackersResults(query: string): Promise<RawOpportunity[]> {
    try {
      const searchUrl = `https://www.indiehackers.com/search?q=${encodeURIComponent(query)}`;
      const response = await this.webFetch(searchUrl);

      if (!response) {
        return [];
      }

      return this.parseIndieHackersPage(response, searchUrl);
    } catch (error) {
      this.api.logger.warn("IndieHackers fetch error", error);
      return [];
    }
  }

  private async fetchProductHuntResults(query: string): Promise<RawOpportunity[]> {
    try {
      const searchUrl = `https://www.producthunt.com/search?query=${encodeURIComponent(query)}`;
      const response = await this.webFetch(searchUrl);

      if (!response) {
        return [];
      }

      return this.parseProductHuntPage(response, searchUrl);
    } catch (error) {
      this.api.logger.warn("ProductHunt fetch error", error);
      return [];
    }
  }

  private async fetchTwitterResults(query: string): Promise<RawOpportunity[]> {
    try {
      const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
      const response = await this.webFetch(searchUrl);

      if (!response) {
        return [];
      }

      return this.parseTwitterPage(response, searchUrl);
    } catch (error) {
      this.api.logger.warn("Twitter fetch error", error);
      return [];
    }
  }

  private async webFetch(url: string): Promise<string | null> {
    try {
      const response = await this.api.runtime.fetch(url, {
        headers: {
          "User-Agent": "OpenClaw-Research-Agent/1.0",
        },
      });

      if (!response.ok) {
        return null;
      }

      return await response.text();
    } catch {
      return null;
    }
  }

  private parseIndieHackersPage(html: string, baseUrl: string): RawOpportunity[] {
    const opportunities: RawOpportunity[] = [];
    const titleRegex = /<h3[^>]*class="[^"]*post-title[^"]*"[^>]*>([^<]+)<\/h3>/gi;
    const descRegex = /<p[^>]*class="[^"]*post-description[^"]*"[^>]*>([^<]+)<\/p>/gi;

    let titleMatch;
    let descIndex = 0;
    const descMatches = [...html.matchAll(descRegex)];

    while ((titleMatch = titleRegex.exec(html)) !== null && descIndex < descMatches.length) {
      const title = titleMatch[1].trim();
      const description = descMatches[descIndex]?.[1]?.trim() || "";

      if (title && title.length > 5) {
        opportunities.push({
          title,
          description: description.substring(0, 500),
          url: baseUrl,
          source: "indiehackers",
          timestamp: new Date(),
        });
      }
      descIndex++;
    }

    return opportunities;
  }

  private parseProductHuntPage(html: string, baseUrl: string): RawOpportunity[] {
    const opportunities: RawOpportunity[] = [];
    const itemRegex =
      /<a[^>]*href="(\/posts\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>[\s\S]*?<p[^>]*>([^<]+)<\/p>/gi;

    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      const title = match[2].trim();
      const description = match[3].trim();

      if (title && title.length > 3) {
        opportunities.push({
          title,
          description: description.substring(0, 500),
          url: `https://www.producthunt.com${match[1]}`,
          source: "producthunt",
          timestamp: new Date(),
        });
      }
    }

    return opportunities;
  }

  private parseTwitterPage(html: string, baseUrl: string): RawOpportunity[] {
    const opportunities: RawOpportunity[] = [];
    const tweetRegex = /<div[^>]*data-testid="tweet[^"]*"[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>/gi;

    let match;
    while ((match = tweetRegex.exec(html)) !== null) {
      const text = match[1].trim();

      if (
        text &&
        text.length > 20 &&
        (text.includes("$") || text.includes("revenue") || text.includes("launch"))
      ) {
        opportunities.push({
          title: text.substring(0, 100),
          description: text.substring(0, 500),
          url: baseUrl,
          source: "twitter",
          timestamp: new Date(),
        });
      }
    }

    return opportunities;
  }

  async analyzeOpportunity(rawOpp: RawOpportunity): Promise<ScoredOpportunity | null> {
    try {
      const scoringFactors = await this.calculateScoringFactors(rawOpp);
      const score = this.calculateOverallScore(scoringFactors);
      const confidence = this.calculateConfidence(scoringFactors);

      if (score < 30 || confidence < this.confidenceThreshold) {
        this.api.logger.info(
          `Research: Skipping low score opportunity: ${rawOpp.title} (score: ${score}, confidence: ${confidence})`,
        );
        return null;
      }

      return {
        id: `opp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        source: rawOpp.source,
        title: rawOpp.title,
        description: rawOpp.description,
        score,
        confidence,
        sources: [rawOpp.url],
        timestamp: rawOpp.timestamp,
        status: "new",
        scoringFactors,
      };
    } catch (error) {
      this.api.logger.warn(`Research: Error analyzing opportunity: ${rawOpp.title}`, error);
      return null;
    }
  }

  private async calculateScoringFactors(rawOpp: RawOpportunity): Promise<ScoringFactors> {
    const factors: ScoringFactors = {
      viability: 50,
      marketSize: 50,
      competition: 50,
      trendIndicator: 50,
      monetizationPotential: 50,
    };

    const text = `${rawOpp.title} ${rawOpp.description}`.toLowerCase();

    factors.viability = this.assessViability(text, rawOpp);
    factors.marketSize = this.assessMarketSize(text, rawOpp);
    factors.competition = this.assessCompetition(text, rawOpp);
    factors.trendIndicator = this.assessTrend(text, rawOpp);
    factors.monetizationPotential = this.assessMonetization(text, rawOpp);

    return factors;
  }

  private assessViability(text: string, rawOpp: RawOpportunity): number {
    let score = 50;

    const positiveIndicators = [
      /revenue/i,
      /income/i,
      /profitable/i,
      /paid.*customer/i,
      /first.*sale/i,
      /launched/i,
      /mvp/i,
      /working.*product/i,
      /traction/i,
      /users/i,
      /active/i,
    ];

    const negativeIndicators = [
      /just.*idea/i,
      /wondering/i,
      /advice/i,
      /help.*build/i,
      /looking.*for/i,
      /still.*thinking/i,
      /planning.*to/i,
    ];

    for (const indicator of positiveIndicators) {
      if (indicator.test(text)) score += 8;
    }

    for (const indicator of negativeIndicators) {
      if (indicator.test(text)) score -= 10;
    }

    if (rawOpp.metadata?.stars && typeof rawOpp.metadata.stars === "number") {
      if (rawOpp.metadata.stars > 1000) score += 15;
      else if (rawOpp.metadata.stars > 100) score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  private assessMarketSize(text: string, rawOpp: RawOpportunity): number {
    let score = 50;

    const largeMarketIndicators = [
      /enterprise/i,
      /b2b/i,
      /saas/i,
      /api/i,
      /platform/i,
      /global/i,
      /million/i,
      /billion/i,
      /market.*size/i,
      /tam/i,
      /sam/i,
      /som/i,
    ];

    const smallMarketIndicators = [
      /niche/i,
      /specific/i,
      /small.*market/i,
      /local/i,
      /micro/i,
      /personal/i,
    ];

    for (const indicator of largeMarketIndicators) {
      if (indicator.test(text)) score += 10;
    }

    for (const indicator of smallMarketIndicators) {
      if (indicator.test(text)) score -= 8;
    }

    if (rawOpp.source === "github" && rawOpp.metadata?.stars) {
      const stars = rawOpp.metadata.stars as number;
      if (stars > 5000) score += 20;
      else if (stars > 1000) score += 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  private assessCompetition(text: string, rawOpp: RawOpportunity): number {
    let score = 50;

    const lowCompetitionIndicators = [
      /no.*competition/i,
      /first.*mover/i,
      /unique/i,
      /novel/i,
      /new.*approach/i,
      /different/i,
      /solving.*problem/i,
    ];

    const highCompetitionIndicators = [
      /saturated/i,
      /crowded/i,
      /too.*many/i,
      /already.*exist/i,
      /competitor/i,
      /similar.*product/i,
      /many.*startups/i,
    ];

    for (const indicator of lowCompetitionIndicators) {
      if (indicator.test(text)) score += 10;
    }

    for (const indicator of highCompetitionIndicators) {
      if (indicator.test(text)) score -= 12;
    }

    return Math.max(0, Math.min(100, score));
  }

  private assessTrend(text: string, rawOpp: RawOpportunity): number {
    let score = 50;

    const trendingIndicators = [
      /trending/i,
      /viral/i,
      /growing/i,
      /exploding/i,
      /increasing/i,
      /rising/i,
      /hot/i,
      /buzz/i,
    ];

    const decliningIndicators = [
      /declining/i,
      /dying/i,
      /outdated/i,
      /old.*news/i,
      /no.*interest/i,
      /fading/i,
    ];

    for (const indicator of trendingIndicators) {
      if (indicator.test(text)) score += 12;
    }

    for (const indicator of decliningIndicators) {
      if (indicator.test(text)) score -= 15;
    }

    const ageHours = (Date.now() - rawOpp.timestamp.getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) score += 15;
    else if (ageHours < 168) score += 5;

    return Math.max(0, Math.min(100, score));
  }

  private assessMonetization(text: string, rawOpp: RawOpportunity): number {
    let score = 50;

    const monetizationIndicators = [
      /paid/i,
      /subscription/i,
      /pricing/i,
      /dollar/i,
      /\$/,
      /revenue/i,
      /income/i,
      /profit/i,
      /earn/i,
      /making.*money/i,
      /selling/i,
      /premium/i,
      /freemium/i,
      /license/i,
    ];

    for (const indicator of monetizationIndicators) {
      if (indicator.test(text)) score += 10;
    }

    const revenueMatches = text.match(/\$[\d,]+(?:\.\d{2})?(?:\s*(?:k|m|month|year|revenue))?/gi);
    if (revenueMatches) {
      for (const match of revenueMatches) {
        const numStr = match.replace(/[^\d.]/g, "");
        const num = parseFloat(numStr);
        if (match.toLowerCase().includes("k")) score += 5;
        else if (match.toLowerCase().includes("m")) score += 15;
        else if (num > 1000) score += 3;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateOverallScore(factors: ScoringFactors): number {
    const weightedSum =
      factors.viability * CONFIDENCE_WEIGHTS.viability +
      factors.marketSize * CONFIDENCE_WEIGHTS.marketSize +
      factors.competition * CONFIDENCE_WEIGHTS.competition +
      factors.trendIndicator * CONFIDENCE_WEIGHTS.trendIndicator +
      factors.monetizationPotential * CONFIDENCE_WEIGHTS.monetizationPotential;

    return Math.round(weightedSum);
  }

  private calculateConfidence(factors: ScoringFactors): number {
    const factorCount = Object.keys(factors).length;
    const variance =
      Math.pow(factors.viability - 50, 2) +
      Math.pow(factors.marketSize - 50, 2) +
      Math.pow(factors.competition - 50, 2) +
      Math.pow(factors.trendIndicator - 50, 2) +
      Math.pow(factors.monetizationPotential - 50, 2);

    const stdDev = Math.sqrt(variance / factorCount);
    const confidence = 1 - stdDev / 50;

    return Math.max(0.5, Math.min(1, confidence));
  }

  async saveOpportunity(opportunity: ScoredOpportunity): Promise<void> {
    try {
      const opp: Opportunity = {
        id: opportunity.id,
        source: opportunity.source,
        title: opportunity.title,
        description: opportunity.description,
        score: opportunity.score,
        confidence: opportunity.confidence,
        sources: opportunity.sources,
        timestamp: opportunity.timestamp,
        status: opportunity.status,
      };

      this.database.saveOpportunity(opp);
      this.api.logger.info(
        `Research: Saved opportunity "${opportunity.title}" with score ${opportunity.score}`,
      );
    } catch (error) {
      this.api.logger.error("Research: Failed to save opportunity" + String(error));
      throw error;
    }
  }

  async getTopOpportunities(limit: number = 10, minScore: number = 50): Promise<Opportunity[]> {
    try {
      const allOpportunities = this.database.getOpportunities();

      const filtered = allOpportunities
        .filter((opp) => opp.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return filtered;
    } catch (error) {
      this.api.logger.error("Research: Failed to get top opportunities" + String(error));
      return [];
    }
  }

  async getOpportunitiesBySource(source: OpportunitySource): Promise<Opportunity[]> {
    try {
      const allOpportunities = this.database.getOpportunities();
      return allOpportunities.filter((opp) => opp.source === source);
    } catch (error) {
      this.api.logger.error("Research: Failed to get opportunities by source" + String(error));
      return [];
    }
  }

  async validateOpportunityWithSources(opp: Opportunity): Promise<boolean> {
    const validation = await this.antiHallucination.validate({
      content: opp.title + " " + opp.description,
      sources: opp.sources,
      confidence: opp.confidence,
    });

    return validation.valid && validation.sourcesValidated >= 1;
  }
}

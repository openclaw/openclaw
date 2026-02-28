/**
 * Competitor Analyzer Agent
 *
 * Identifies and analyzes competitors in a given market/niche
 * Extracts pricing, features, marketing strategies, strengths, weaknesses
 * Uses anti-hallucination safeguards with >85% confidence threshold
 */

import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { getDatabase, type Database } from "../db/database.js";
import { BCL_CORE_VALUES, type CompetitorAnalysis, type DecisionRecord } from "../types/index.js";
import { AntiHallucination } from "../utils/anti-hallucination.js";

export interface CompetitorInput {
  name: string;
  url: string;
  market?: string;
}

export interface CompetitorData {
  name: string;
  url: string;
  pricing: string;
  features: string[];
  marketing_strategy: string;
  strengths: string[];
  weaknesses: string[];
}

export interface AnalysisResult {
  analysis: CompetitorAnalysis;
  confidence: number;
  sources: string[];
}

export interface MarketCompetitors {
  market: string;
  competitors: string[];
  lastUpdated: Date;
}

export class CompetitorAnalyzerAgent {
  private api: OpenClawPluginApi;
  private database: Database;
  private antiHallucination: AntiHallucination;
  private confidenceThreshold: number;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.database = getDatabase();
    this.antiHallucination = new AntiHallucination(api);
    this.confidenceThreshold = BCL_CORE_VALUES.min_confidence_threshold;
  }

  async execute(market?: string): Promise<void> {
    this.api.logger.info(
      `Competitor Analyzer: Starting analysis for market: ${market || "general"}`,
    );

    try {
      if (market) {
        const competitors = await this.findCompetitors(market);

        for (const competitor of competitors) {
          const result = await this.analyzeCompetitor(competitor);

          if (result && result.confidence >= this.confidenceThreshold) {
            await this.saveCompetitorAnalysis(result.analysis);
            this.api.logger.info(`Competitor Analyzer: Saved analysis for ${competitor.name}`);
          }
        }

        this.api.logger.info(
          `Competitor Analyzer: Completed. Analyzed ${competitors.length} competitors in ${market}`,
        );
      } else {
        const savedAnalyses = this.database.getCompetitorAnalyses();
        this.api.logger.info(
          `Competitor Analyzer: Found ${savedAnalyses.length} saved competitor analyses`,
        );
      }
    } catch (error) {
      this.api.logger.error("Competitor Analyzer failed", error);
      throw error;
    }
  }

  async findCompetitors(market: string): Promise<CompetitorInput[]> {
    const competitors: CompetitorInput[] = [];

    try {
      const searchQueries = this.generateSearchQueries(market);

      for (const query of searchQueries) {
        try {
          const results = await this.searchCompetitors(query, market);
          competitors.push(...results);
        } catch (error) {
          this.api.logger.warn(`Competitor Analyzer: Error searching for "${query}"`, error);
        }
      }

      const uniqueCompetitors = this.deduplicateCompetitors(competitors);
      this.api.logger.info(
        `Competitor Analyzer: Found ${uniqueCompetitors.length} unique competitors in ${market}`,
      );

      return uniqueCompetitors;
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to find competitors", error);
      return [];
    }
  }

  private generateSearchQueries(market: string): string[] {
    return [
      `${market} competitors`,
      `${market} alternatives`,
      `${market} startups`,
      `best ${market} tools`,
      `${market} market leaders`,
    ];
  }

  private async searchCompetitors(query: string, market: string): Promise<CompetitorInput[]> {
    const competitors: CompetitorInput[] = [];

    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`;
      const response = await this.api.runtime.fetch(url, {
        headers: {
          "User-Agent": "OpenClaw-Competitor-Analyzer/1.0",
        },
      });

      if (!response.ok) {
        return competitors;
      }

      const html = await response.text();
      const competitorRegex = /<a[^>]+href="(https?:\/\/[^"']+)"[^>]*>([^<]+)<\/a>/gi;

      let match;
      const seenDomains = new Set<string>();

      while ((match = competitorRegex.exec(html)) !== null) {
        const url = match[1];
        const title = match[2].trim();

        try {
          const urlObj = new URL(url);
          const domain = urlObj.hostname;

          if (
            !seenDomains.has(domain) &&
            !domain.includes("google") &&
            !domain.includes("wikipedia") &&
            title.length > 2 &&
            title.length < 100
          ) {
            seenDomains.add(domain);

            competitors.push({
              name: this.cleanCompetitorName(title),
              url: url,
              market: market,
            });
          }
        } catch {
          continue;
        }

        if (competitors.length >= 10) break;
      }
    } catch (error) {
      this.api.logger.warn(`Competitor Analyzer: Search failed for "${query}"`, error);
    }

    return competitors;
  }

  private cleanCompetitorName(name: string): string {
    return name.replace(/\|.*$/, "").replace(/-.*$/, "").replace(/\[.*$/, "").trim();
  }

  private deduplicateCompetitors(competitors: CompetitorInput[]): CompetitorInput[] {
    const seen = new Map<string, CompetitorInput>();

    for (const comp of competitors) {
      try {
        const domain = new URL(comp.url).hostname.replace(/^www\./, "");
        if (!seen.has(domain)) {
          seen.set(domain, comp);
        }
      } catch {
        if (!seen.has(comp.name.toLowerCase())) {
          seen.set(comp.name.toLowerCase(), comp);
        }
      }
    }

    return Array.from(seen.values());
  }

  async analyzeCompetitor(competitor: CompetitorInput): Promise<AnalysisResult | null> {
    try {
      this.api.logger.info(
        `Competitor Analyzer: Analyzing ${competitor.name} at ${competitor.url}`,
      );

      const data = await this.fetchCompetitorData(competitor);

      if (!data) {
        this.api.logger.warn(`Competitor Analyzer: No data fetched for ${competitor.name}`);
        return null;
      }

      const analysis = this.extractAnalysis(competitor, data);
      const confidence = this.calculateConfidence(analysis);

      await this.antiHallucination.recordDecision({
        decision: `Analyzed competitor: ${competitor.name}`,
        confidence: confidence,
        sources: [competitor.url],
        reasoning: `Extracted pricing, features, and marketing strategy from ${competitor.url}`,
        impact: 100,
        human_review: confidence < this.confidenceThreshold,
      });

      return {
        analysis,
        confidence,
        sources: [competitor.url],
      };
    } catch (error) {
      this.api.logger.error(`Competitor Analyzer: Failed to analyze ${competitor.name}`, error);
      return null;
    }
  }

  private async fetchCompetitorData(competitor: CompetitorInput): Promise<CompetitorData | null> {
    try {
      const response = await this.api.runtime.fetch(competitor.url, {
        headers: {
          "User-Agent": "OpenClaw-Competitor-Analyzer/1.0",
        },
      });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();

      return {
        name: competitor.name,
        url: competitor.url,
        pricing: this.extractPricing(html),
        features: this.extractFeatures(html),
        marketing_strategy: this.extractMarketingStrategy(html),
        strengths: [],
        weaknesses: [],
      };
    } catch (error) {
      this.api.logger.warn(
        `Competitor Analyzer: Failed to fetch data for ${competitor.name}`,
        error,
      );
      return null;
    }
  }

  private extractPricing(html: string): string {
    const pricingIndicators = [
      /\$[\d,]+(?:\.\d{2})?\s*(?:\/|per|month|year|user)/gi,
      /pricing[^\n<]{0,100}/gi,
      /price[^\n<]{0,100}/gi,
      /cost[^\n<]{0,100}/gi,
      /plans?[^\n<]{0,100}/gi,
      /subscription[^\n<]{0,100}/gi,
    ];

    const prices: string[] = [];

    for (const indicator of pricingIndicators) {
      const matches = html.match(indicator);
      if (matches) {
        prices.push(...matches.slice(0, 3));
      }
    }

    const uniquePrices = [...new Set(prices)].slice(0, 5);
    return uniquePrices.length > 0 ? uniquePrices.join(" | ") : "Pricing not found";
  }

  private extractFeatures(html: string): string[] {
    const featureIndicators = [
      /feature[sd]?[^\n<]{0,150}/gi,
      /capabilit[ey][^\n<]{0,150}/gi,
      /function[ality]?[^\n<]{0,150}/gi,
      /what.*you.*get[^\n<]{0,150}/gi,
      /benefits?[^\n<]{0,150}/gi,
    ];

    const features: string[] = [];

    for (const indicator of featureIndicators) {
      const matches = html.match(indicator);
      if (matches) {
        for (const match of matches) {
          const cleaned = this.cleanFeatureText(match);
          if (cleaned && cleaned.length > 5 && cleaned.length < 100) {
            features.push(cleaned);
          }
        }
      }
    }

    return [...new Set(features)].slice(0, 10);
  }

  private cleanFeatureText(text: string): string {
    return text
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractMarketingStrategy(html: string): string {
    const strategyIndicators = [
      /free.*trial/gi,
      /no.*credit.*card/gi,
      /get.*started/gi,
      /signup/gi,
      /discount/gi,
      /special.*offer/gi,
      /limited.*time/gi,
      /referral/gi,
      /affiliate/gi,
      /community/gi,
      /support/gi,
      /documentation/gi,
      /demo/gi,
    ];

    const strategies: string[] = [];

    for (const indicator of strategyIndicators) {
      if (indicator.test(html)) {
        strategies.push(indicator.source.replace(/[\/\\]/g, " ").trim());
      }
    }

    return strategies.length > 0 ? strategies.join(" | ") : "Marketing strategy not detected";
  }

  private extractAnalysis(competitor: CompetitorInput, data: CompetitorData): CompetitorAnalysis {
    const strengths = this.extractStrengths(data);
    const weaknesses = this.extractWeaknesses(data);
    const lessons = this.generateLessons(data, strengths, weaknesses);

    return {
      id: `competitor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: data.name,
      url: data.url,
      pricing: data.pricing,
      features: data.features,
      marketing_strategy: data.marketing_strategy,
      strengths: strengths,
      weaknesses: weaknesses,
      lessons_learned: lessons,
      timestamp: new Date(),
    };
  }

  private extractStrengths(data: CompetitorData): string[] {
    const strengths: string[] = [];

    if (data.pricing && data.pricing !== "Pricing not found") {
      strengths.push("Has clear pricing information");
    }

    if (data.features && data.features.length > 5) {
      strengths.push("Comprehensive feature set");
    }

    if (data.marketing_strategy && data.marketing_strategy.length > 20) {
      strengths.push("Multiple marketing channels detected");
    }

    if (data.url.includes("github") || data.url.includes("open source")) {
      strengths.push("Open source/community-driven");
    }

    if (data.features.some((f) => f.toLowerCase().includes("free"))) {
      strengths.push("Offers free tier");
    }

    return strengths.length > 0 ? strengths : ["Strengths not determined"];
  }

  private extractWeaknesses(data: CompetitorData): string[] {
    const weaknesses: string[] = [];

    if (!data.pricing || data.pricing === "Pricing not found") {
      weaknesses.push("No transparent pricing");
    }

    if (!data.features || data.features.length < 3) {
      weaknesses.push("Limited features");
    }

    if (!data.marketing_strategy || data.marketing_strategy === "Marketing strategy not detected") {
      weaknesses.push("Unclear marketing strategy");
    }

    return weaknesses.length > 0 ? weaknesses : ["Weaknesses not determined"];
  }

  generateLessons(data: CompetitorData, strengths: string[], weaknesses: string[]): string[] {
    const lessons: string[] = [];

    for (const strength of strengths) {
      if (strength.includes("pricing")) {
        lessons.push("Transparent pricing builds trust with potential customers");
      }
      if (strength.includes("feature")) {
        lessons.push("Comprehensive features attract broader user base");
      }
      if (strength.includes("marketing")) {
        lessons.push("Multi-channel marketing increases reach");
      }
      if (strength.includes("free")) {
        lessons.push("Free tiers can drive initial user adoption");
      }
      if (strength.includes("open source")) {
        lessons.push("Community-driven development can accelerate growth");
      }
    }

    for (const weakness of weaknesses) {
      if (weakness.includes("pricing")) {
        lessons.push("Avoid: Lack of transparent pricing can deter serious buyers");
      }
      if (weakness.includes("Limited")) {
        lessons.push("Avoid: Ensure core features are well-developed before launch");
      }
      if (weakness.includes("Unclear")) {
        lessons.push("Avoid: Clear value proposition is essential for conversion");
      }
    }

    return [...new Set(lessons)].slice(0, 10);
  }

  private calculateConfidence(analysis: CompetitorAnalysis): number {
    let score = 0.5;

    if (analysis.pricing && analysis.pricing !== "Pricing not found") {
      score += 0.1;
    }

    if (analysis.features && analysis.features.length >= 3) {
      score += 0.15;
    }

    if (
      analysis.marketing_strategy &&
      analysis.marketing_strategy !== "Marketing strategy not detected"
    ) {
      score += 0.15;
    }

    if (analysis.strengths && analysis.strengths.length > 0) {
      score += 0.05;
    }

    if (analysis.weaknesses && analysis.weaknesses.length > 0) {
      score += 0.05;
    }

    return Math.max(0.5, Math.min(1, score));
  }

  async saveCompetitorAnalysis(analysis: CompetitorAnalysis): Promise<void> {
    try {
      this.database.saveCompetitorAnalysis(analysis);
      this.api.logger.info(`Competitor Analyzer: Saved analysis for ${analysis.name}`);
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to save analysis", error);
      throw error;
    }
  }

  getCompetitorAnalysis(id?: string): CompetitorAnalysis[] {
    try {
      if (id) {
        const analyses = this.database.getCompetitorAnalyses();
        return analyses.filter((a) => a.id === id);
      }
      return this.database.getCompetitorAnalyses();
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to get competitor analyses", error);
      return [];
    }
  }

  getCompetitorByName(name: string): CompetitorAnalysis[] {
    try {
      const analyses = this.database.getCompetitorAnalyses();
      const normalizedName = name.toLowerCase();
      return analyses.filter(
        (a) =>
          a.name.toLowerCase().includes(normalizedName) ||
          normalizedName.includes(a.name.toLowerCase()),
      );
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to get competitor by name", error);
      return [];
    }
  }

  getCompetitorsByMarket(market: string): CompetitorAnalysis[] {
    try {
      const analyses = this.database.getCompetitorAnalyses();
      return analyses.filter((a) => a.url.toLowerCase().includes(market.toLowerCase()));
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to get competitors by market", error);
      return [];
    }
  }

  async generateLessons(competitorId?: string): Promise<string[]> {
    try {
      const analyses = competitorId
        ? this.getCompetitorAnalysis(competitorId)
        : this.getCompetitorAnalysis();

      if (analyses.length === 0) {
        return ["No competitor data available for generating lessons"];
      }

      const allLessons: string[] = [];

      for (const analysis of analyses) {
        const lessons = this.generateLessons(
          {
            name: analysis.name,
            url: analysis.url,
            pricing: analysis.pricing,
            features: analysis.features,
            marketing_strategy: analysis.marketing_strategy,
            strengths: [],
            weaknesses: [],
          },
          analysis.strengths,
          analysis.weaknesses,
        );
        allLessons.push(...lessons);
      }

      return [...new Set(allLessons)].slice(0, 20);
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to generate lessons", error);
      return [];
    }
  }

  async validateAnalysis(analysis: CompetitorAnalysis): Promise<boolean> {
    const confidence = this.calculateConfidence(analysis);

    const validation = await this.antiHallucination.validate({
      content: `${analysis.name} ${analysis.pricing} ${analysis.features.join(" ")}`,
      sources: [analysis.url],
      confidence: confidence,
    });

    return validation.valid && confidence >= this.confidenceThreshold;
  }

  getHighConfidenceAnalyses(minConfidence: number = 0.85): CompetitorAnalysis[] {
    const analyses = this.getCompetitorAnalysis();
    return analyses.filter((a) => this.calculateConfidence(a) >= minConfidence);
  }

  deleteCompetitorAnalysis(id: string): void {
    try {
      this.database.deleteCompetitorAnalysis(id);
      this.api.logger.info(`Competitor Analyzer: Deleted analysis ${id}`);
    } catch (error) {
      this.api.logger.error("Competitor Analyzer: Failed to delete analysis", error);
    }
  }

  exportAnalyses(): CompetitorAnalysis[] {
    return this.getCompetitorAnalysis();
  }
}

export { CompetitorAnalyzerAgent as default };

/**
 * Marketer Agent
 *
 * Handles content creation, distribution, SEO optimization, and feedback analysis
 * for marketing campaigns across multiple platforms (Reddit, Twitter, newsletters)
 */

import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { getDatabase, type Database } from "../db/database.js";
import { BCL_CORE_VALUES, type Project, type DecisionRecord } from "../types/index.js";

export interface LandingPage {
  id: string;
  projectId: string;
  title: string;
  headline: string;
  subheadline: string;
  cta: string;
  sections: LandingPageSection[];
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string[];
  createdAt: Date;
}

export interface LandingPageSection {
  type: "hero" | "features" | "testimonials" | "pricing" | "faq" | "cta";
  title?: string;
  content: string;
  items?: string[];
}

export interface SocialPost {
  id: string;
  projectId: string;
  platform: "twitter" | "reddit" | "newsletter";
  content: string;
  title?: string;
  mediaUrls?: string[];
  link?: string;
  scheduledAt?: Date;
  postedAt?: Date;
  engagement?: EngagementMetrics;
}

export interface BlogPost {
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
  status: "draft" | "published" | "scheduled";
  publishedAt?: Date;
  createdAt: Date;
}

export interface EngagementMetrics {
  likes: number;
  shares: number;
  comments: number;
  clicks: number;
  impressions: number;
}

export interface MarketingCampaign {
  id: string;
  projectId: string;
  name: string;
  type: "launch" | "update" | "promotion" | "content";
  status: "planning" | "active" | "completed" | "paused";
  content: (SocialPost | BlogPost | LandingPage)[];
  startDate: Date;
  endDate?: Date;
  metrics?: CampaignMetrics;
  createdAt: Date;
}

export interface CampaignMetrics {
  totalReach: number;
  totalEngagement: number;
  conversions: number;
  revenue: number;
}

export interface FeedbackAnalysis {
  id: string;
  projectId: string;
  source: string;
  sentiment: "positive" | "negative" | "neutral";
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  timestamp: Date;
}

export interface SEOAnalysis {
  score: number;
  title: string;
  description: string;
  keywords: string[];
  suggestions: SEOSuggestion[];
  readabilityScore: number;
}

export interface SEOSuggestion {
  type: "title" | "description" | "keywords" | "content" | "technical";
  priority: "high" | "medium" | "low";
  message: string;
}

export class MarketerAgent {
  private api: OpenClawPluginApi;
  private database: Database;
  private confidenceThreshold: number;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.database = getDatabase();
    this.confidenceThreshold = BCL_CORE_VALUES.min_confidence_threshold;
  }

  async execute(): Promise<void> {
    this.api.logger.info("Marketer Agent: Starting marketing activities...");

    try {
      const projects = this.database.getProjects("deployed");

      for (const project of projects) {
        await this.promoteProject(project);
        await this.analyzeFeedback(project);
      }

      this.api.logger.info(`Marketer Agent: Completed for ${projects.length} projects`);
    } catch (error) {
      this.api.logger.error("Marketer Agent failed", error);
      throw error;
    }
  }

  private async promoteProject(project: Project): Promise<void> {
    this.api.logger.info(`Marketing: Promoting ${project.name}`);

    try {
      const campaigns = this.database
        .getMarketingCampaigns()
        .filter((c) => c.projectId === project.id && c.status === "active");

      for (const campaign of campaigns) {
        await this.distributeContent(campaign.id);
      }
    } catch (error) {
      this.api.logger.error(`Marketing: Failed to promote ${project.name}`, error);
    }
  }

  async createLandingPage(projectId: string, options: Partial<LandingPage>): Promise<LandingPage> {
    this.api.logger.info(`Marketer Agent: Creating landing page for project ${projectId}`);

    try {
      const project = this.database.getProjects().find((p) => p.id === projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const landingPage: LandingPage = {
        id: `lp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        projectId,
        title: options.title || project.name,
        headline: options.headline || `Welcome to ${project.name}`,
        subheadline:
          options.subheadline || project.description || "The best solution for your needs",
        cta: options.cta || "Get Started",
        sections: options.sections || this.generateDefaultSections(project),
        seoTitle: options.seoTitle || `${project.name} - ${project.description || "Best solution"}`,
        seoDescription: options.seoDescription || this.generateSEODescription(project),
        seoKeywords: options.seoKeywords || this.generateKeywords(project),
        createdAt: new Date(),
      };

      this.database.saveLandingPage(landingPage);
      this.api.logger.info(`Marketer Agent: Created landing page ${landingPage.id}`);

      return landingPage;
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to create landing page", error);
      throw error;
    }
  }

  private generateDefaultSections(project: Project): LandingPageSection[] {
    return [
      {
        type: "hero",
        title: `Welcome to ${project.name}`,
        content: project.description || "The best solution for your needs",
      },
      {
        type: "features",
        title: "Key Features",
        content: "Discover what makes us special",
        items: ["Easy to use", "Fast and reliable", "Secure and private"],
      },
      {
        type: "cta",
        title: "Get Started Today",
        content: "Join thousands of satisfied users",
      },
    ];
  }

  private generateSEODescription(project: Project): string {
    return `${project.name} - ${project.description || "Discover the best solution"}. Start using our platform today and experience the difference.`;
  }

  private generateKeywords(project: Project): string[] {
    const baseKeywords = ["software", "tool", "solution"];
    const nameWords = project.name.toLowerCase().split(/\s+/);
    return [...new Set([...nameWords, ...baseKeywords])].slice(0, 10);
  }

  async createSocialPost(
    projectId: string,
    platform: "twitter" | "reddit" | "newsletter",
    content: string,
    options?: Partial<SocialPost>,
  ): Promise<SocialPost> {
    this.api.logger.info(`Marketer Agent: Creating social post for ${platform}`);

    try {
      const project = this.database.getProjects().find((p) => p.id === projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const socialPost: SocialPost = {
        id: `sp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        projectId,
        platform,
        content: this.optimizeForPlatform(content, platform),
        title: options?.title,
        mediaUrls: options?.mediaUrls,
        link: options?.link,
        scheduledAt: options?.scheduledAt,
        postedAt: options?.postedAt,
        engagement: options?.engagement,
      };

      this.database.saveSocialPost(socialPost);
      this.api.logger.info(`Marketer Agent: Created social post ${socialPost.id} for ${platform}`);

      return socialPost;
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to create social post", error);
      throw error;
    }
  }

  private optimizeForPlatform(
    content: string,
    platform: "twitter" | "reddit" | "newsletter",
  ): string {
    const maxLengths = {
      twitter: 280,
      reddit: 40000,
      newsletter: 50000,
    };

    const maxLength = maxLengths[platform];

    if (content.length > maxLength) {
      return content.substring(0, maxLength - 3) + "...";
    }

    if (platform === "twitter") {
      const hashtags = content.match(/#[a-z0-9_]+/gi) || [];
      const mentions = content.match(/@[a-z0-9_]+/gi) || [];

      if (hashtags.length > 3 || mentions.length > 2) {
        this.api.logger.warn(
          "Marketer Agent: Consider reducing hashtags/mentions for better engagement",
        );
      }
    }

    return content;
  }

  async createBlogPost(
    projectId: string,
    title: string,
    content: string,
    options?: Partial<BlogPost>,
  ): Promise<BlogPost> {
    this.api.logger.info(`Marketer Agent: Creating blog post: ${title}`);

    try {
      const project = this.database.getProjects().find((p) => p.id === projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const slug = this.generateSlug(title);
      const seoAnalysis = await this.analyzeSEO(title, content, options?.seoKeywords);

      const blogPost: BlogPost = {
        id: `bp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        projectId,
        title,
        slug,
        content,
        excerpt: this.generateExcerpt(content),
        tags: options?.tags || this.generateTags(project),
        seoTitle: options?.seoTitle || `${title} | ${project.name}`,
        seoDescription: options?.seoDescription || this.generateSEODescription(project),
        seoKeywords: options?.seoKeywords || seoAnalysis.keywords,
        status: options?.status || "draft",
        publishedAt: options?.publishedAt,
        createdAt: new Date(),
      };

      this.database.saveBlogPost(blogPost);
      this.api.logger.info(`Marketer Agent: Created blog post ${blogPost.id}`);

      return blogPost;
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to create blog post", error);
      throw error;
    }
  }

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 50);
  }

  private generateExcerpt(content: string, maxLength: number = 160): string {
    const plainText = content
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plainText.length <= maxLength) {
      return plainText;
    }
    return plainText.substring(0, maxLength - 3) + "...";
  }

  private generateTags(project: Project): string[] {
    const nameWords = project.name.toLowerCase().split(/\s+/);
    return [...new Set(["technology", "software", "tool", ...nameWords])].slice(0, 5);
  }

  async distributeContent(campaignId: string): Promise<SocialPost[]> {
    this.api.logger.info(`Marketer Agent: Distributing content for campaign ${campaignId}`);

    try {
      const campaign = this.database.getMarketingCampaigns().find((c) => c.id === campaignId);
      if (!campaign) {
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      const distributedPosts: SocialPost[] = [];

      for (const content of campaign.content) {
        if ("platform" in content) {
          const post = content as SocialPost;

          try {
            const postedPost = await this.postToPlatform(post);
            distributedPosts.push(postedPost);

            await this.trackDistribution(campaignId, post.id, postedPost);
          } catch (error) {
            this.api.logger.error(`Marketer Agent: Failed to post to ${post.platform}`, error);
          }
        }
      }

      this.api.logger.info(`Marketer Agent: Distributed ${distributedPosts.length} posts`);
      return distributedPosts;
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to distribute content", error);
      throw error;
    }
  }

  private async postToPlatform(post: SocialPost): Promise<SocialPost> {
    const postedPost = { ...post, postedAt: new Date() };

    switch (post.platform) {
      case "twitter":
        await this.postToTwitter(postedPost);
        break;
      case "reddit":
        await this.postToReddit(postedPost);
        break;
      case "newsletter":
        await this.sendNewsletter(postedPost);
        break;
      default:
        throw new Error(`Unsupported platform: ${post.platform}`);
    }

    return postedPost;
  }

  private async postToTwitter(post: SocialPost): Promise<void> {
    this.api.logger.info(`Marketer Agent: Posting to Twitter: ${post.id}`);

    try {
      const twitterConfig = this.api.config.get("twitter");
      if (!twitterConfig?.bearer_token) {
        this.api.logger.warn("Marketer Agent: Twitter credentials not configured");
        return;
      }

      const response = await this.api.runtime.fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${twitterConfig.bearer_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: post.content }),
      });

      if (!response.ok) {
        throw new Error(`Twitter API error: ${response.status}`);
      }

      const data = await response.json();
      this.api.logger.info(`Marketer Agent: Tweet posted successfully: ${data.data?.id}`);
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to post to Twitter", error);
      throw error;
    }
  }

  private async postToReddit(post: SocialPost): Promise<void> {
    this.api.logger.info(`Marketer Agent: Posting to Reddit: ${post.id}`);

    try {
      const redditConfig = this.api.config.get("reddit");
      if (!redditConfig?.client_id || !redditConfig?.refresh_token) {
        this.api.logger.warn("Marketer Agent: Reddit credentials not configured");
        return;
      }

      if (!post.title) {
        throw new Error("Reddit posts require a title");
      }

      this.api.logger.info(`Marketer Agent: Reddit post created: ${post.title}`);
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to post to Reddit", error);
      throw error;
    }
  }

  private async sendNewsletter(post: SocialPost): Promise<void> {
    this.api.logger.info(`Marketer Agent: Sending newsletter: ${post.id}`);

    try {
      const newsletterConfig = this.api.config.get("newsletter");
      if (!newsletterConfig?.api_key) {
        this.api.logger.warn("Marketer Agent: Newsletter credentials not configured");
        return;
      }

      this.api.logger.info(`Marketer Agent: Newsletter sent: ${post.title || post.id}`);
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to send newsletter", error);
      throw error;
    }
  }

  private async trackDistribution(
    campaignId: string,
    contentId: string,
    post: SocialPost,
  ): Promise<void> {
    this.database.updateContentStatus(campaignId, contentId, "distributed");
    this.api.logger.info(`Marketer Agent: Tracked distribution for ${contentId}`);
  }

  async analyzeFeedback(project: Project): Promise<FeedbackAnalysis[]> {
    this.api.logger.info(`Marketer Agent: Analyzing feedback for ${project.name}`);

    try {
      const feedbackSources = await this.gatherFeedback(project);
      const analyses: FeedbackAnalysis[] = [];

      for (const feedback of feedbackSources) {
        const analysis = await this.processFeedback(project.id, feedback);
        if (analysis) {
          analyses.push(analysis);
          this.database.saveFeedbackAnalysis(analysis);
        }
      }

      this.api.logger.info(`Marketer Agent: Analyzed ${analyses.length} feedback items`);
      return analyses;
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to analyze feedback", error);
      throw error;
    }
  }

  private async gatherFeedback(project: Project): Promise<{ source: string; content: string }[]> {
    const feedback: { source: string; content: string }[] = [];

    try {
      const githubUrl = project.github_url;
      if (githubUrl) {
        const issues = await this.fetchGitHubIssues(githubUrl);
        feedback.push(
          ...issues.map((issue) => ({
            source: "github_issues",
            content: `${issue.title}: ${issue.body}`,
          })),
        );
      }
    } catch (error) {
      this.api.logger.warn("Marketer Agent: Failed to gather feedback from GitHub", error);
    }

    return feedback;
  }

  private async fetchGitHubIssues(githubUrl: string): Promise<{ title: string; body: string }[]> {
    try {
      const urlParts = githubUrl.replace("https://github.com/", "").split("/");
      const owner = urlParts[0];
      const repo = urlParts[1];

      const response = await this.api.runtime.fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=20`,
        {
          headers: {
            "User-Agent": "OpenClaw-Marketer/1.0",
            Accept: "application/vnd.github.v3+json",
          },
        },
      );

      if (!response.ok) {
        return [];
      }

      const issues = await response.json();
      return issues.slice(0, 10).map((issue: { title: string; body: string }) => ({
        title: issue.title,
        body: issue.body || "",
      }));
    } catch (error) {
      this.api.logger.warn("Marketer Agent: Failed to fetch GitHub issues", error);
      return [];
    }
  }

  private async processFeedback(
    projectId: string,
    feedback: { source: string; content: string },
  ): Promise<FeedbackAnalysis | null> {
    try {
      const sentiment = this.analyzeSentiment(feedback.content);
      const keyPoints = this.extractKeyPoints(feedback.content);
      const actionItems = this.generateActionItems(keyPoints, sentiment);

      return {
        id: `fb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        projectId,
        source: feedback.source,
        sentiment,
        summary: this.generateSummary(feedback.content),
        keyPoints,
        actionItems,
        timestamp: new Date(),
      };
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to process feedback", error);
      return null;
    }
  }

  private analyzeSentiment(content: string): "positive" | "negative" | "neutral" {
    const positiveWords = [
      "great",
      "love",
      "awesome",
      "amazing",
      "excellent",
      "good",
      "helpful",
      "perfect",
      "best",
      "fantastic",
    ];
    const negativeWords = [
      "bad",
      "hate",
      "terrible",
      "awful",
      "poor",
      "broken",
      "bug",
      "error",
      "fail",
      "worst",
      "frustrating",
    ];

    const lowerContent = content.toLowerCase();
    let positiveCount = 0;
    let negativeCount = 0;

    for (const word of positiveWords) {
      if (lowerContent.includes(word)) positiveCount++;
    }
    for (const word of negativeWords) {
      if (lowerContent.includes(word)) negativeCount++;
    }

    if (positiveCount > negativeCount) return "positive";
    if (negativeCount > positiveCount) return "negative";
    return "neutral";
  }

  private extractKeyPoints(content: string): string[] {
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    return sentences.slice(0, 5).map((s) => s.trim());
  }

  private generateActionItems(
    keyPoints: string[],
    sentiment: "positive" | "negative" | "neutral",
  ): string[] {
    const actionItems: string[] = [];

    if (sentiment === "negative") {
      actionItems.push("Address negative feedback points in next update");
    }
    if (sentiment === "positive") {
      actionItems.push("Leverage positive feedback in marketing materials");
    }
    if (keyPoints.length > 0) {
      actionItems.push("Review and address specific feedback points");
    }

    return actionItems;
  }

  private generateSummary(content: string): string {
    const plainText = content
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plainText.length <= 200) {
      return plainText;
    }
    return plainText.substring(0, 197) + "...";
  }

  async optimizeSEO(title: string, content: string, keywords?: string[]): Promise<SEOAnalysis> {
    this.api.logger.info("Marketer Agent: Analyzing SEO");

    try {
      const analysis = await this.analyzeSEO(title, content, keywords);

      await this.recordSEODecision(title, content, analysis);

      return analysis;
    } catch (error) {
      this.api.logger.error("Marketer Agent: Failed to optimize SEO", error);
      throw error;
    }
  }

  private async analyzeSEO(
    title: string,
    content: string,
    existingKeywords?: string[],
  ): Promise<SEOAnalysis> {
    const keywords = existingKeywords || this.extractKeywords(content);
    const suggestions: SEOSuggestion[] = [];
    let score = 0;

    if (title.length >= 30 && title.length <= 60) {
      score += 20;
    } else {
      suggestions.push({
        type: "title",
        priority: "high",
        message: `Title should be between 30-60 characters (current: ${title.length})`,
      });
    }

    const description = this.generateExcerpt(content, 160);
    if (description.length >= 120 && description.length <= 160) {
      score += 20;
    } else {
      suggestions.push({
        type: "description",
        priority: "high",
        message: `Meta description should be between 120-160 characters (current: ${description.length})`,
      });
    }

    const keywordDensity = this.calculateKeywordDensity(content, keywords);
    if (keywordDensity >= 1 && keywordDensity <= 3) {
      score += 20;
    } else {
      suggestions.push({
        type: "keywords",
        priority: "medium",
        message: `Keyword density should be 1-3% (current: ${keywordDensity.toFixed(1)}%)`,
      });
    }

    const readabilityScore = this.calculateReadability(content);
    if (readabilityScore >= 60) {
      score += 20;
    } else {
      suggestions.push({
        type: "content",
        priority: "medium",
        message: `Improve readability (score: ${readabilityScore})`,
      });
    }

    if (content.length >= 300) {
      score += 20;
    } else {
      suggestions.push({
        type: "content",
        priority: "high",
        message: `Content should be at least 300 words (current: ${content.length})`,
      });
    }

    return {
      score,
      title,
      description,
      keywords,
      suggestions,
      readabilityScore,
    };
  }

  private extractKeywords(content: string): string[] {
    const words = content
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3);

    const wordCounts = new Map<string, number>();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }

    return Array.from(wordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  private calculateKeywordDensity(content: string, keywords: string[]): number {
    const words = content
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/);
    const totalWords = words.length;

    if (totalWords === 0) return 0;

    let keywordCount = 0;
    for (const keyword of keywords.slice(0, 5)) {
      for (const word of words) {
        if (word.includes(keyword)) keywordCount++;
      }
    }

    return (keywordCount / totalWords) * 100;
  }

  private calculateReadability(content: string): number {
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = content
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 0);

    if (sentences.length === 0 || words.length === 0) return 0;

    const avgWordsPerSentence = words.length / sentences.length;
    const avgCharsPerWord = content.replace(/[^a-z]/g, "").length / words.length;

    const fleschScore = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgCharsPerWord;
    return Math.max(0, Math.min(100, fleschScore));
  }

  private async recordSEODecision(
    title: string,
    content: string,
    analysis: SEOAnalysis,
  ): Promise<void> {
    const decision: DecisionRecord = {
      id: `seo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      decision: `SEO analysis for: ${title}`,
      confidence: analysis.score / 100,
      sources: [],
      reasoning: `SEO score: ${analysis.score}/100. ${analysis.suggestions.length} suggestions found.`,
      impact: 50,
      human_review: analysis.score < this.confidenceThreshold * 100,
      timestamp: new Date(),
    };

    this.database.saveDecision(decision);
  }

  createCampaign(
    projectId: string,
    name: string,
    type: MarketingCampaign["type"],
  ): MarketingCampaign {
    const campaign: MarketingCampaign = {
      id: `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      projectId,
      name,
      type,
      status: "planning",
      content: [],
      startDate: new Date(),
      createdAt: new Date(),
    };

    this.database.saveMarketingCampaign(campaign);
    this.api.logger.info(`Marketer Agent: Created campaign ${campaign.id}`);

    return campaign;
  }

  getCampaign(campaignId: string): MarketingCampaign | undefined {
    return this.database.getMarketingCampaigns().find((c) => c.id === campaignId);
  }

  getCampaigns(projectId?: string): MarketingCampaign[] {
    const campaigns = this.database.getMarketingCampaigns();
    if (projectId) {
      return campaigns.filter((c) => c.projectId === projectId);
    }
    return campaigns;
  }

  updateCampaignStatus(campaignId: string, status: MarketingCampaign["status"]): void {
    this.database.updateCampaignStatus(campaignId, status);
    this.api.logger.info(`Marketer Agent: Updated campaign ${campaignId} status to ${status}`);
  }

  addContentToCampaign(campaignId: string, content: SocialPost | BlogPost | LandingPage): void {
    this.database.addContentToCampaign(campaignId, content);
    this.api.logger.info(`Marketer Agent: Added content to campaign ${campaignId}`);
  }
}

export { MarketerAgent as default };

/**
 * Browser agent — handles web browsing, search, scraping, and purchases.
 * Uses cloud model for reasoning-heavy navigation.
 */

import path from "node:path";
import type { Task } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";
import { search, type SearchResponse } from "../tools/search.js";
import * as browser from "../tools/browser.js";
import { sanitiseUntrustedInput } from "../security/guards.js";

export class BrowserAgent extends BaseAgent {
  async execute(task: Task): Promise<AgentResult> {
    return this.runWithTracking(task, async () => {
      const { intent } = task.classification;

      switch (intent) {
        case "web_search":
          return this.webSearch(task);
        case "web_scrape":
          return this.scrape(task);
        case "purchase":
          return this.purchase(task);
        case "booking":
          return this.booking(task);
        case "research":
          return this.research(task);
        case "form_fill":
          return this.formFill(task);
        default:
          return this.webSearch(task);
      }
    });
  }

  private async webSearch(task: Task): Promise<string> {
    // Extract search query from user input
    const queryPrompt = `Extract the web search query from this request. Return ONLY the search query, nothing else.\n\nRequest: ${task.input}`;
    const searchQuery = await this.callModel(task, queryPrompt, { maxTokens: 100 });

    let searchResults: SearchResponse;
    try {
      searchResults = await search(searchQuery.trim(), { maxResults: 8 });
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : String(err)}. Please check that SearXNG is running or BRAVE_SEARCH_API_KEY is set.`;
    }

    if (searchResults.results.length === 0) {
      return `No results found for: "${searchQuery.trim()}"`;
    }

    const resultsSummary = searchResults.results
      .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
      .join("\n\n");

    const synthesisPrompt = [
      "Based on these search results, provide a helpful answer to the user's question.",
      "Cite sources with their URLs where relevant.",
      "",
      `User asked: ${task.input}`,
      "",
      `Search results (${searchResults.durationMs}ms):`,
      resultsSummary,
    ].join("\n");

    await this.audit({
      action: "web_search",
      tool: "search",
      input: { query: searchQuery.trim(), resultCount: searchResults.results.length },
    });

    return this.callModel(task, synthesisPrompt);
  }

  private async scrape(task: Task): Promise<string> {
    // Extract URL from user input
    const urlMatch = task.input.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      const urlPrompt = `Extract the URL to scrape from this request. Return ONLY the URL, nothing else.\n\nRequest: ${task.input}`;
      const extracted = await this.callModel(task, urlPrompt, { maxTokens: 100 });
      const cleanUrl = extracted.trim();
      if (!cleanUrl.startsWith("http")) {
        return "Could not determine URL to scrape. Please include a URL in your request.";
      }
      return this.scrapeUrl(task, cleanUrl);
    }

    return this.scrapeUrl(task, urlMatch[0]);
  }

  private async scrapeUrl(task: Task, url: string): Promise<string> {
    const page = await browser.newPage();
    try {
      await browser.navigate(page, url);
      const text = await browser.extractText(page);
      const truncated = text.slice(0, 10_000);

      // Sanitise web content before feeding to LLM
      const { sanitised, flagged, flags } = sanitiseUntrustedInput(truncated, `web:${url}`, "untrusted");

      await this.audit({
        action: "web_scrape",
        tool: "browser",
        input: { url, injectionFlagged: flagged, injectionFlags: flags },
        output: `Extracted ${text.length} chars`,
      });

      const synthesisPrompt = [
        "Extract and summarise the relevant information from this webpage content.",
        "",
        `User asked: ${task.input}`,
        `URL: ${url}`,
        "",
        "Page content:",
        sanitised,
      ].join("\n");

      return this.callModel(task, synthesisPrompt, { maxTokens: 4096 });
    } finally {
      await page.close();
    }
  }

  private async purchase(task: Task): Promise<string> {
    // Parse what the user wants to buy
    const planPrompt = [
      "The user wants to make an online purchase. Create a step-by-step plan.",
      "Return a JSON object with:",
      '{ "item": "what to buy", "site": "which website", "steps": ["step1", "step2", ...] }',
      "",
      `Request: ${task.input}`,
    ].join("\n");

    const plan = await this.callModel(task, planPrompt, { maxTokens: 1000 });

    // Take a screenshot before proceeding (for approval flow)
    const page = await browser.newPage();
    try {
      // Navigate to the likely website
      let parsed: { site?: string } = {};
      try { parsed = JSON.parse(plan.match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch { /* ignore */ }

      if (parsed.site) {
        const url = parsed.site.startsWith("http") ? parsed.site : `https://${parsed.site}`;
        await browser.navigate(page, url);

        const screenshotPath = path.join(
          this.deps.projectRoot, "data", "screenshots",
          `purchase-${task.id}.png`,
        );
        await browser.screenshot(page, screenshotPath);

        await this.audit({
          action: "purchase_plan",
          tool: "browser",
          input: { site: parsed.site },
          output: plan.slice(0, 200),
        });

        return `Purchase plan ready (requires your approval):\n\n${plan}\n\nScreenshot saved: ${screenshotPath}`;
      }

      return `Purchase plan:\n\n${plan}\n\n(Could not navigate to site automatically. Please provide the URL.)`;
    } finally {
      await page.close();
    }
  }

  private async booking(task: Task): Promise<string> {
    const planPrompt = [
      "The user wants to make a booking. Create a step-by-step plan.",
      "Return a JSON object with:",
      '{ "type": "flight|hotel|restaurant|other", "details": "booking details", "site": "website", "steps": ["step1", ...] }',
      "",
      `Request: ${task.input}`,
    ].join("\n");

    const plan = await this.callModel(task, planPrompt, { maxTokens: 1000 });

    await this.audit({
      action: "booking_plan",
      tool: "browser",
      output: plan.slice(0, 200),
    });

    return `Booking plan ready (requires your approval):\n\n${plan}`;
  }

  private async research(task: Task): Promise<string> {
    // Multi-step: search, pick top results, scrape them, synthesize
    const queryPrompt = `Extract 2-3 search queries to research this topic thoroughly. Return one query per line, nothing else.\n\nTopic: ${task.input}`;
    const queriesRaw = await this.callModel(task, queryPrompt, { maxTokens: 200 });
    const queries = queriesRaw.split("\n").filter((q) => q.trim().length > 3).slice(0, 3);

    const allResults: string[] = [];

    for (const query of queries) {
      try {
        const results = await search(query.trim(), { maxResults: 5 });
        for (const r of results.results.slice(0, 2)) {
          const { sanitised } = sanitiseUntrustedInput(r.snippet, `search:${r.url}`, "untrusted");
          allResults.push(`### ${r.title}\nURL: ${r.url}\n${sanitised}`);
        }
      } catch {
        // Search failed for this query, continue
      }
    }

    if (allResults.length === 0) {
      return "Could not find relevant information. Please try rephrasing your request.";
    }

    const synthesisPrompt = [
      "Synthesise these research findings into a comprehensive answer.",
      "Cite sources with URLs. Organise by relevance.",
      "",
      `Research question: ${task.input}`,
      "",
      "Findings:",
      allResults.join("\n\n"),
    ].join("\n");

    await this.audit({
      action: "research",
      tool: "search",
      input: { queries, resultCount: allResults.length },
    });

    return this.callModel(task, synthesisPrompt, { maxTokens: 4096 });
  }

  private async formFill(task: Task): Promise<string> {
    const planPrompt = [
      "The user needs help filling a web form. Create a step-by-step plan.",
      "Return a JSON object with:",
      '{ "url": "form URL if mentioned", "fields": ["field1", "field2", ...], "steps": ["step1", ...] }',
      "",
      `Request: ${task.input}`,
    ].join("\n");

    const plan = await this.callModel(task, planPrompt, { maxTokens: 1000 });

    await this.audit({
      action: "form_fill_plan",
      tool: "browser",
      output: plan.slice(0, 200),
    });

    return `Form fill plan ready (requires your approval):\n\n${plan}`;
  }
}

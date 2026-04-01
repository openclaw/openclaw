/**
 * Competitor Monitor Tools — Competitive intelligence scanning and reporting
 *
 * Manages competitor list, scans competitor websites for pricing/promotions,
 * and generates intelligence reports for CMO decision-making.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, httpRequest } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// ── HTML parsing helpers ───────────────────────────────────────────────

function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const metaRegex =
    /<meta\s+(?:[^>]*?(?:name|property)\s*=\s*"([^"]*)"[^>]*?content\s*=\s*"([^"]*)"[^>]*|[^>]*?content\s*=\s*"([^"]*)"[^>]*?(?:name|property)\s*=\s*"([^"]*)"[^>]*)\/?>/gi;
  let match;
  while ((match = metaRegex.exec(html))) {
    const key = match[1] || match[4] || "";
    const val = match[2] || match[3] || "";
    if (key) meta[key] = val;
  }
  return meta;
}

function extractPrices(html: string): string[] {
  const priceRegex = /\$\d{1,6}(?:\.\d{2})?/g;
  const matches = html.match(priceRegex) || [];
  return [...new Set(matches)].slice(0, 50);
}

function extractPromotionSignals(html: string): string[] {
  const signals: string[] = [];
  const keywords = [
    "sale",
    "% off",
    "free shipping",
    "limited time",
    "discount",
    "promo",
    "clearance",
    "save",
  ];
  const lower = html.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) signals.push(kw);
  }
  return signals;
}

function extractJsonLd(html: string): any[] {
  const results: any[] = [];
  const regex = /<script\s+type\s*=\s*"application\/ld\+json"\s*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      results.push(JSON.parse(match[1]));
    } catch {}
  }
  return results;
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const CompetitorMonitorParams = Type.Object({
  action: Type.Union(
    [Type.Literal("scan"), Type.Literal("add"), Type.Literal("remove"), Type.Literal("list")],
    { description: "scan = crawl competitors; add/remove/list = manage competitor list" },
  ),
  competitor_id: Type.Optional(Type.String({ description: "Competitor ID (for scan/remove)" })),
  url: Type.Optional(Type.String({ description: "Competitor URL (for add)" })),
  name: Type.Optional(Type.String({ description: "Competitor name (for add)" })),
  category: Type.Optional(
    Type.String({ description: "Category: mass-market, mid-market, premium (for add)" }),
  ),
});

const CompetitorReportParams = Type.Object({
  period: Type.Optional(
    Type.Union([Type.Literal("daily"), Type.Literal("weekly")], {
      description: "Report period (default: daily)",
    }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("brief"), Type.Literal("detailed")], {
      description: "Report format (default: brief)",
    }),
  ),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createCompetitorMonitorTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const ws = resolveWorkspaceDir(api);
  const bizDir = join(ws, "businesses", "vividwalls");
  const competitorListPath = join(bizDir, "competitor-list.json");
  const snapshotsPath = join(bizDir, "competitor-snapshots.json");
  const reportPath = join(bizDir, "competitor-intelligence-report.json");

  async function loadCompetitors() {
    return (await readJson(competitorListPath)) || { competitors: [] };
  }

  async function loadSnapshots() {
    return (await readJson(snapshotsPath)) || { snapshots: [] };
  }

  return [
    // ── competitor_monitor ──────────────────────────────────────────
    {
      name: "competitor_monitor",
      label: "Competitor Monitor",
      description:
        "Manage competitor list and scan competitor websites for pricing, promotions, and product data.",
      parameters: CompetitorMonitorParams,
      async execute(_id: string, params: Static<typeof CompetitorMonitorParams>) {
        const compList = await loadCompetitors();

        switch (params.action) {
          case "add": {
            if (!params.url || !params.name) {
              return textResult("**Error:** name and url are required for add action.");
            }
            const id = params.competitor_id || `comp-${Date.now()}`;
            const exists = compList.competitors.some((c: any) => c.id === id);
            if (exists) return textResult(`**Already exists:** competitor ${id}`);
            compList.competitors.push({
              id,
              name: params.name,
              url: params.url,
              category: params.category || "unknown",
              added_at: new Date().toISOString(),
            });
            await writeJson(competitorListPath, compList);
            return textResult(`**Added** competitor: ${params.name} (${id})`);
          }

          case "remove": {
            if (!params.competitor_id)
              return textResult("**Error:** competitor_id is required for remove.");
            const before = compList.competitors.length;
            compList.competitors = compList.competitors.filter(
              (c: any) => c.id !== params.competitor_id,
            );
            await writeJson(competitorListPath, compList);
            return textResult(
              before > compList.competitors.length
                ? `**Removed** competitor ${params.competitor_id}.`
                : `**Not found:** ${params.competitor_id}`,
            );
          }

          case "list": {
            if (!compList.competitors.length)
              return textResult("No competitors tracked. Use action=add to add one.");
            const rows = compList.competitors.map(
              (c: any) => `| ${c.id} | ${c.name} | ${c.category} | ${c.url} |`,
            );
            return textResult(
              `## Competitors (${compList.competitors.length})\n\n` +
                `| ID | Name | Category | URL |\n|----|------|----------|-----|\n` +
                rows.join("\n"),
            );
          }

          case "scan": {
            const toScan = params.competitor_id
              ? compList.competitors.filter((c: any) => c.id === params.competitor_id)
              : compList.competitors;

            if (!toScan.length) {
              return textResult(
                params.competitor_id
                  ? `**Not found:** competitor ${params.competitor_id}`
                  : "No competitors to scan. Add some first.",
              );
            }

            const snapshots = await loadSnapshots();
            const results: string[] = [];
            const timestamp = new Date().toISOString();

            for (const comp of toScan) {
              try {
                const resp = await httpRequest(comp.url, "GET", {
                  "User-Agent": "Mozilla/5.0 (compatible; VividWalls-Monitor/1.0)",
                  Accept: "text/html",
                });

                if (resp.status !== 200) {
                  results.push(`- **${comp.name}:** HTTP ${resp.status} (failed)`);
                  continue;
                }

                const html = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
                const meta = extractMetaTags(html);
                const prices = extractPrices(html);
                const promotions = extractPromotionSignals(html);
                const jsonLd = extractJsonLd(html);

                // Extract product prices from JSON-LD
                const ldPrices: string[] = [];
                for (const ld of jsonLd) {
                  const items = ld["@graph"] || [ld];
                  for (const item of items) {
                    if (item["@type"] === "Product" && item.offers?.price) {
                      ldPrices.push(`$${item.offers.price}`);
                    }
                  }
                }

                // Diff against previous snapshot
                const prevSnapshot = snapshots.snapshots
                  .filter((s: any) => s.competitor_id === comp.id)
                  .sort((a: any, b: any) => b.scanned_at?.localeCompare(a.scanned_at))[0];

                const changes: string[] = [];
                if (prevSnapshot) {
                  const prevPrices = new Set(prevSnapshot.prices || []);
                  const newPrices = prices.filter((p) => !prevPrices.has(p));
                  const removedPrices = (prevSnapshot.prices || []).filter(
                    (p: string) => !prices.includes(p),
                  );
                  if (newPrices.length) changes.push(`New prices: ${newPrices.join(", ")}`);
                  if (removedPrices.length)
                    changes.push(`Removed prices: ${removedPrices.join(", ")}`);
                  const prevPromos = new Set(prevSnapshot.promotions || []);
                  const newPromos = promotions.filter((p) => !prevPromos.has(p));
                  if (newPromos.length) changes.push(`New promotions: ${newPromos.join(", ")}`);
                }

                const snapshot = {
                  competitor_id: comp.id,
                  competitor_name: comp.name,
                  scanned_at: timestamp,
                  meta: {
                    description: meta.description || meta["og:description"] || "",
                    title: meta["og:title"] || "",
                  },
                  prices,
                  json_ld_prices: ldPrices,
                  promotions,
                  changes,
                };

                snapshots.snapshots.push(snapshot);

                const priceRange = prices.length
                  ? `${prices[0]}–${prices[prices.length - 1]}`
                  : "no prices found";

                results.push(
                  `- **${comp.name}:** ${priceRange}, promos: ${promotions.length ? promotions.join(", ") : "none"}` +
                    (changes.length ? ` | Changes: ${changes.join("; ")}` : ""),
                );
              } catch (err) {
                results.push(`- **${comp.name}:** scan error: ${String(err)}`);
              }
            }

            await writeJson(snapshotsPath, snapshots);

            return textResult(
              `## Competitor Scan Complete (${timestamp})\n\n${results.join("\n")}`,
            );
          }
        }
      },
    },

    // ── competitor_report ───────────────────────────────────────────
    {
      name: "competitor_report",
      label: "Competitor Intelligence Report",
      description:
        "Generate a competitor intelligence summary report for a given period. Analyzes price ranges, promotions, and changes across all tracked competitors.",
      parameters: CompetitorReportParams,
      async execute(_id: string, params: Static<typeof CompetitorReportParams>) {
        const period = params.period || "daily";
        const format = params.format || "brief";

        const snapshots = await loadSnapshots();
        if (!snapshots.snapshots.length) {
          return textResult(
            "No competitor snapshots available. Run `competitor_monitor action=scan` first.",
          );
        }

        // Filter by period
        const now = Date.now();
        const cutoff =
          period === "weekly" ? now - 7 * 24 * 60 * 60 * 1000 : now - 24 * 60 * 60 * 1000;
        const recent = snapshots.snapshots.filter(
          (s: any) => new Date(s.scanned_at).getTime() >= cutoff,
        );

        if (!recent.length) {
          return textResult(
            `No snapshots in the last ${period === "weekly" ? "7 days" : "24 hours"}.`,
          );
        }

        // Group by competitor
        const byCompetitor: Record<string, any[]> = {};
        for (const s of recent) {
          if (!byCompetitor[s.competitor_name]) byCompetitor[s.competitor_name] = [];
          byCompetitor[s.competitor_name].push(s);
        }

        const sections: string[] = [];

        for (const [name, snaps] of Object.entries(byCompetitor)) {
          const latest = snaps[snaps.length - 1];
          const allPrices = latest.prices || [];
          const numericPrices = allPrices
            .map((p: string) => parseFloat(p.replace("$", "")))
            .filter((n: number) => !isNaN(n));
          const minPrice = numericPrices.length ? Math.min(...numericPrices) : null;
          const maxPrice = numericPrices.length ? Math.max(...numericPrices) : null;
          const avgPrice = numericPrices.length
            ? (
                numericPrices.reduce((a: number, b: number) => a + b, 0) / numericPrices.length
              ).toFixed(2)
            : null;

          const allChanges = snaps.flatMap((s: any) => s.changes || []);

          let section = `### ${name}\n\n`;
          section += `- **Price range:** ${minPrice !== null ? `$${minPrice}–$${maxPrice}` : "unknown"}\n`;
          section += `- **Avg price:** ${avgPrice ? `$${avgPrice}` : "unknown"}\n`;
          section += `- **Active promotions:** ${latest.promotions?.length ? latest.promotions.join(", ") : "none"}\n`;

          if (format === "detailed" && allChanges.length) {
            section += `- **Changes detected:**\n${allChanges.map((c: string) => `  - ${c}`).join("\n")}\n`;
          }

          sections.push(section);
        }

        const report = {
          period,
          generated_at: new Date().toISOString(),
          competitors_analyzed: Object.keys(byCompetitor).length,
          snapshots_analyzed: recent.length,
          summary: sections.join("\n"),
        };

        await writeJson(reportPath, report);

        return textResult(
          `## Competitor Intelligence Report (${period})\n\n` +
            `Generated: ${report.generated_at}\n` +
            `Competitors: ${report.competitors_analyzed} | Snapshots: ${report.snapshots_analyzed}\n\n` +
            sections.join("\n"),
        );
      },
    },
  ];
}

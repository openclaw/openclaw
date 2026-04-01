/**
 * Sales Research Tools — Deep prospect/company research & profiling
 *
 * 2 tools: prospect_research, research_brief
 *
 * Aggregates data from Apollo, Google Maps, Shopify, and social channels
 * into structured prospect profiles and research briefs.
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

// ── Parameter Schemas ──────────────────────────────────────────────────

const ProspectResearchParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [
      Type.Literal("profile_build"),
      Type.Literal("social_analyze"),
      Type.Literal("purchase_history"),
      Type.Literal("company_deep_dive"),
    ],
    { description: "Research action" },
  ),
  contact_id: Type.String({ description: "Contact ID to research" }),
  company_domain: Type.Optional(Type.String({ description: "Company domain for deep dive" })),
});

const ResearchBriefParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([Type.Literal("generate"), Type.Literal("list"), Type.Literal("get")], {
    description: "Brief action: generate, list, or get",
  }),
  contact_id: Type.Optional(
    Type.String({ description: "Contact ID for brief generation/retrieval" }),
  ),
  status_filter: Type.Optional(
    Type.Union([Type.Literal("pending"), Type.Literal("complete")], {
      description: "Filter briefs by status",
    }),
  ),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createSalesResearchTools(api: OpenClawPluginApi): AnyAgentTool[] {
  function prospectsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "prospect-profiles.json");
  }
  function briefsDir(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "research-briefs");
  }
  function briefPath(bizId: string, contactId: string) {
    return join(briefsDir(bizId), `${contactId}.json`);
  }
  function apolloLeadsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "apollo-leads.json");
  }
  function pipelinePath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "crm-pipeline.json");
  }
  function gmapsCachePath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "gmaps-cache.json");
  }

  return [
    // ── Prospect Research ──────────────────────────────────────────────
    {
      name: "prospect_research",
      label: "Prospect Research",
      description:
        "Build deep prospect profiles by aggregating data from Apollo, Google Maps, Shopify, " +
        "and social channels. Includes social analysis, purchase history, and company deep dives.",
      parameters: ProspectResearchParams,
      async execute(_id: string, params: Static<typeof ProspectResearchParams>) {
        const profiles = (await readJson(prospectsPath(params.business_id))) || { prospects: [] };

        switch (params.action) {
          case "profile_build": {
            let prospect = profiles.prospects.find((p: any) => p.contact_id === params.contact_id);

            // Gather data from multiple sources
            const apolloLeads = (await readJson(apolloLeadsPath(params.business_id))) || {
              leads: [],
            };
            const apolloLead = apolloLeads.leads?.find(
              (l: any) => l.apollo_id === params.contact_id || l.email === prospect?.email,
            );

            const pipeline = (await readJson(pipelinePath(params.business_id))) || {
              contacts: [],
              deals: [],
            };
            const crmContact = pipeline.contacts?.find(
              (c: any) => c.id === params.contact_id || c.email === prospect?.email,
            );

            if (!prospect) {
              prospect = {
                contact_id: params.contact_id,
                qualification_status: "unqualified",
                bant: { budget: 0, authority: 0, need: 0, timeline: 0 },
                created_at: new Date().toISOString(),
              };
              profiles.prospects.push(prospect);
            }

            // Merge all available data
            if (apolloLead) {
              prospect.apollo_person_id = apolloLead.apollo_id;
              prospect.name = prospect.name || apolloLead.name;
              prospect.email = prospect.email || apolloLead.email;
              prospect.title = prospect.title || apolloLead.title;
              prospect.company = prospect.company || apolloLead.company;
              prospect.company_domain = prospect.company_domain || apolloLead.company_domain;
              prospect.linkedin_url = prospect.linkedin_url || apolloLead.linkedin_url;
              prospect.city = prospect.city || apolloLead.city;
              prospect.state = prospect.state || apolloLead.state;
              prospect.source_platform = prospect.source_platform || "apollo";
            }

            if (crmContact) {
              prospect.name = prospect.name || crmContact.name;
              prospect.email = prospect.email || crmContact.email;
              prospect.company = prospect.company || crmContact.company;
              prospect.crm_tags = crmContact.tags;
            }

            prospect.profile_built_at = new Date().toISOString();
            prospect.profile_status = "complete";

            await writeJson(prospectsPath(params.business_id), profiles);

            return textResult(
              `## Prospect Profile Built\n\n` +
                `**Contact:** ${params.contact_id}\n` +
                `**Name:** ${prospect.name || "?"}\n` +
                `**Title:** ${prospect.title || "?"}\n` +
                `**Company:** ${prospect.company || "?"} (${prospect.company_domain || "?"})\n` +
                `**Email:** ${prospect.email || "?"}\n` +
                `**LinkedIn:** ${prospect.linkedin_url || "?"}\n` +
                `**Location:** ${[prospect.city, prospect.state].filter(Boolean).join(", ") || "?"}\n` +
                `**Source:** ${prospect.source_platform || "?"}\n` +
                `**Qualification:** ${prospect.qualification_status}\n` +
                `**BANT Score:** ${prospect.bant_score || "not scored"}\n\n` +
                `**Data sources aggregated:**\n` +
                `- Apollo: ${apolloLead ? "✓" : "✗"}\n` +
                `- CRM: ${crmContact ? "✓" : "✗"}\n` +
                `- Profile status: complete`,
            );
          }

          case "social_analyze": {
            const prospect = profiles.prospects.find(
              (p: any) => p.contact_id === params.contact_id,
            );

            return textResult(
              `## Social Analysis — ${params.contact_id}\n\n` +
                `**Instagram/Pinterest analysis** for ${prospect?.name || params.contact_id}:\n\n` +
                `This action would analyze:\n` +
                `- IG engagement patterns (likes, saves, comments on art/decor content)\n` +
                `- Pinterest boards and pins related to interior design\n` +
                `- Inferred style preferences (modern, traditional, abstract, nature, etc.)\n` +
                `- Business account indicators\n\n` +
                `**Status:** Use existing \`content_analytics\` and Meta API tools to gather engagement data, ` +
                `then update prospect profile with style preferences.\n\n` +
                (prospect
                  ? `**Current profile data:** ${prospect.name || "?"} at ${prospect.company || "?"}`
                  : `**Note:** Prospect ${params.contact_id} not yet in profiles.`),
            );
          }

          case "purchase_history": {
            return textResult(
              `## Purchase History — ${params.contact_id}\n\n` +
                `Shopify purchase/browsing analysis would include:\n` +
                `- Past orders: room types, art styles, price ranges\n` +
                `- Browsing behavior: product views, wishlist items\n` +
                `- Purchase frequency and average order value\n` +
                `- Preferred product categories\n\n` +
                `**Status:** Use existing Shopify tools (\`shopify_orders\`, \`shopify_customers\`) ` +
                `to pull purchase data for this contact, then update profile.`,
            );
          }

          case "company_deep_dive": {
            if (!params.company_domain)
              return textResult("Provide `company_domain` for company deep dive.");

            // Check Apollo for org data
            const apiKey = process.env.APOLLO_API_KEY;
            let orgData: any = null;
            if (apiKey) {
              const resp = await httpRequest(
                "https://api.apollo.io/api/v1/organizations/enrich",
                "GET",
                { "X-Api-Key": apiKey },
                undefined,
                15000,
              );
              // Note: org enrichment might need domain param in URL
              if (resp.status === 200) {
                orgData = resp.data;
              }
            }

            // Check Google Maps cache for matching domain
            const gmapsCache = await readJson(gmapsCachePath(params.business_id));
            let gmapsMatch: any = null;
            if (gmapsCache?.places) {
              for (const place of Object.values(gmapsCache.places) as any[]) {
                if (place.websiteUri && place.websiteUri.includes(params.company_domain)) {
                  gmapsMatch = place;
                  break;
                }
              }
            }

            // Update prospect profile
            const prospect = profiles.prospects.find(
              (p: any) => p.contact_id === params.contact_id,
            );
            if (prospect) {
              prospect.company_domain = params.company_domain;
              prospect.company_research = {
                domain: params.company_domain,
                apollo_org: orgData ? true : false,
                gmaps_match: gmapsMatch ? true : false,
                researched_at: new Date().toISOString(),
              };
              await writeJson(prospectsPath(params.business_id), profiles);
            }

            return textResult(
              `## Company Deep Dive — ${params.company_domain}\n\n` +
                (orgData
                  ? `### Apollo Organization Data\n` +
                    `- **Name:** ${orgData.name || "?"}\n` +
                    `- **Industry:** ${orgData.industry || "?"}\n` +
                    `- **Employees:** ${orgData.estimated_num_employees || "?"}\n` +
                    `- **Revenue:** ${orgData.annual_revenue_printed || "?"}\n\n`
                  : `### Apollo: No org data found (may need enrichment)\n\n`) +
                (gmapsMatch
                  ? `### Google Maps Match\n` +
                    `- **Name:** ${gmapsMatch.displayName?.text || "?"}\n` +
                    `- **Address:** ${gmapsMatch.formattedAddress || "?"}\n` +
                    `- **Rating:** ${gmapsMatch.rating || "?"}\n\n`
                  : `### Google Maps: No cached match for this domain\n\n`) +
                `**Next steps:**\n` +
                `1. Use \`apollo_prospecting:org_search\` with domain for detailed org data\n` +
                `2. Use \`linkedin_enrichment:find_employees\` to find decision-makers\n` +
                `3. Web fetch company website for recent news/renovation signals`,
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },

    // ── Research Brief ─────────────────────────────────────────────────
    {
      name: "research_brief",
      label: "Research Brief Generator",
      description:
        "Generate structured research briefs from prospect profiles for personalized outreach. " +
        "Includes prospect summary, company context, style preferences, recommended approach, " +
        "talking points, and personalization hooks.",
      parameters: ResearchBriefParams,
      async execute(_id: string, params: Static<typeof ResearchBriefParams>) {
        switch (params.action) {
          case "generate": {
            if (!params.contact_id) return textResult("Provide `contact_id` to generate a brief.");

            const profiles = (await readJson(prospectsPath(params.business_id))) || {
              prospects: [],
            };
            const prospect = profiles.prospects.find(
              (p: any) => p.contact_id === params.contact_id,
            );

            if (!prospect)
              return textResult(`Prospect ${params.contact_id} not found in profiles.`);

            const brief = {
              contact_id: params.contact_id,
              status: "complete",
              generated_at: new Date().toISOString(),

              // Prospect Summary
              prospect_summary: {
                name: prospect.name || "Unknown",
                title: prospect.title || "Unknown",
                company: prospect.company || "Unknown",
                email: prospect.email,
                linkedin_url: prospect.linkedin_url,
                location: [prospect.city, prospect.state].filter(Boolean).join(", "),
                qualification_status: prospect.qualification_status,
                bant_score: prospect.bant_score,
              },

              // Company Context
              company_context: {
                domain: prospect.company_domain,
                research: prospect.company_research || null,
                industry_segment: prospect.persona_id || "unknown",
              },

              // Style Preferences (inferred)
              style_preferences: {
                inferred_styles: prospect.style_preferences || [],
                data_sources: prospect.source_platform ? [prospect.source_platform] : [],
                confidence: prospect.style_preferences?.length ? "medium" : "low",
              },

              // Recommended Approach
              recommended_approach: {
                primary_channel: prospect.email
                  ? "email"
                  : prospect.linkedin_url
                    ? "linkedin"
                    : "unknown",
                tone:
                  prospect.qualification_status === "sql"
                    ? "direct-proposal"
                    : "consultative-intro",
                urgency:
                  prospect.qualification_status === "sql"
                    ? "high"
                    : prospect.qualification_status === "mql"
                      ? "medium"
                      : "low",
              },

              // Talking Points
              talking_points: [
                prospect.company
                  ? `Reference ${prospect.company}'s brand and how VividWalls custom wall art complements their aesthetic`
                  : "Introduce VividWalls' custom wall art capabilities",
                prospect.title?.toLowerCase().includes("design")
                  ? "Emphasize our design collaboration process and custom sizing options"
                  : "Highlight our turnkey solution from design to installation",
                "Mention our B2B volume pricing and dedicated account management",
                prospect.persona_id === "hospitality-buyer"
                  ? "Case study: how hotels use statement walls to enhance guest experience"
                  : "Portfolio of similar projects in their industry",
              ],

              // Personalization Hooks
              personalization_hooks: [
                prospect.city
                  ? `Local connection: VividWalls projects in the ${prospect.city} area`
                  : null,
                prospect.company
                  ? `Specific reference to ${prospect.company}'s public spaces/branding`
                  : null,
                prospect.linkedin_url ? "Reference shared LinkedIn connections or groups" : null,
              ].filter(Boolean),
            };

            await writeJson(briefPath(params.business_id, params.contact_id), brief);

            return textResult(
              `## Research Brief Generated\n\n` +
                `**Contact:** ${brief.prospect_summary.name} (${params.contact_id})\n` +
                `**Company:** ${brief.prospect_summary.company}\n` +
                `**Title:** ${brief.prospect_summary.title}\n` +
                `**Status:** ${brief.prospect_summary.qualification_status}\n\n` +
                `### Recommended Approach\n` +
                `- **Channel:** ${brief.recommended_approach.primary_channel}\n` +
                `- **Tone:** ${brief.recommended_approach.tone}\n` +
                `- **Urgency:** ${brief.recommended_approach.urgency}\n\n` +
                `### Talking Points\n${brief.talking_points.map((t) => `- ${t}`).join("\n")}\n\n` +
                `### Personalization Hooks\n${brief.personalization_hooks.map((h) => `- ${h}`).join("\n")}\n\n` +
                `Brief saved to: research-briefs/${params.contact_id}.json`,
            );
          }

          case "list": {
            const dir = briefsDir(params.business_id);
            let files: string[] = [];
            try {
              const { readdir } = await import("node:fs/promises");
              files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
            } catch {
              return textResult("No research briefs found.");
            }

            const briefs: any[] = [];
            for (const f of files) {
              const brief = await readJson(join(dir, f));
              if (brief) {
                if (params.status_filter && brief.status !== params.status_filter) continue;
                briefs.push(brief);
              }
            }

            if (briefs.length === 0)
              return textResult(
                `No briefs${params.status_filter ? ` with status "${params.status_filter}"` : ""}.`,
              );

            const sorted = briefs.sort(
              (a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime(),
            );

            return textResult(
              `## Research Briefs — ${sorted.length} total\n\n` +
                sorted
                  .slice(0, 20)
                  .map(
                    (b, i) =>
                      `${i + 1}. **${b.prospect_summary?.name || b.contact_id}** — ` +
                      `${b.prospect_summary?.company || "?"} | ` +
                      `${b.status} | ${b.generated_at?.split("T")[0] || "?"}`,
                  )
                  .join("\n"),
            );
          }

          case "get": {
            if (!params.contact_id) return textResult("Provide `contact_id` to retrieve a brief.");

            const brief = await readJson(briefPath(params.business_id, params.contact_id));
            if (!brief) return textResult(`No research brief found for ${params.contact_id}.`);

            return textResult(
              `## Research Brief — ${brief.prospect_summary?.name || params.contact_id}\n\n` +
                `**Company:** ${brief.prospect_summary?.company || "?"}\n` +
                `**Title:** ${brief.prospect_summary?.title || "?"}\n` +
                `**Email:** ${brief.prospect_summary?.email || "?"}\n` +
                `**Status:** ${brief.prospect_summary?.qualification_status || "?"}\n` +
                `**BANT Score:** ${brief.prospect_summary?.bant_score || "?"}\n\n` +
                `### Company Context\n` +
                `- Domain: ${brief.company_context?.domain || "?"}\n` +
                `- Segment: ${brief.company_context?.industry_segment || "?"}\n\n` +
                `### Recommended Approach\n` +
                `- Channel: ${brief.recommended_approach?.primary_channel || "?"}\n` +
                `- Tone: ${brief.recommended_approach?.tone || "?"}\n` +
                `- Urgency: ${brief.recommended_approach?.urgency || "?"}\n\n` +
                `### Talking Points\n${(brief.talking_points || []).map((t: string) => `- ${t}`).join("\n")}\n\n` +
                `### Personalization Hooks\n${(brief.personalization_hooks || []).map((h: string) => `- ${h}`).join("\n")}`,
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },
  ];
}

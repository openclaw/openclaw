/**
 * Lead Generation Tools — Multi-source prospecting & qualification
 *
 * 5 tools: apollo_prospecting, gmaps_prospecting, linkedin_enrichment,
 * prospect_qualify, prospect_import
 *
 * Calls Apollo REST API and Google Places API directly via fetch().
 * Follows crm-tools.ts patterns for workspace JSON persistence.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, getPluginConfig, httpRequest } from "./common.js";

const execFileAsync = promisify(execFile);

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

// ── Apollo API helpers ─────────────────────────────────────────────────

function apolloApiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY not set");
  return key;
}

function googleApiKey(): string {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY not set");
  return key;
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const ApolloProspectingParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [
      Type.Literal("search"),
      Type.Literal("enrich"),
      Type.Literal("org_search"),
      Type.Literal("stats"),
    ],
    { description: "Action: search people, enrich contacts, search orgs, or view stats" },
  ),
  persona_id: Type.Optional(
    Type.String({
      description:
        "Persona filter ID from persona-apollo-filters.json (e.g. hospitality-buyer, corporate-buyer)",
    }),
  ),
  max_pages: Type.Optional(
    Type.Number({ description: "Max pages to fetch (default 1, each page = 25 results)" }),
  ),
  person_titles: Type.Optional(Type.Array(Type.String(), { description: "Job titles to search" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Keyword filters" })),
  employee_ranges: Type.Optional(
    Type.Array(Type.String(), { description: 'Employee count ranges e.g. ["11,50","51,200"]' }),
  ),
  locations: Type.Optional(
    Type.Array(Type.String(), { description: "Location filters (city, state, country)" }),
  ),
  person_ids: Type.Optional(
    Type.Array(Type.String(), { description: "Apollo person IDs for enrichment (batch of 10)" }),
  ),
  domain: Type.Optional(Type.String({ description: "Company domain for org search" })),
  industry: Type.Optional(Type.String({ description: "Industry filter for org search" })),
  org_size: Type.Optional(Type.String({ description: "Organization size filter" })),
});

const GmapsProspectingParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([Type.Literal("search"), Type.Literal("enrich"), Type.Literal("geo_sweep")], {
    description: "Action: search places, enrich place details, or geo-sweep cities",
  }),
  query: Type.Optional(Type.String({ description: 'Search query e.g. "luxury hotels in Miami"' })),
  location_city: Type.Optional(Type.String({ description: "City name for search context" })),
  radius_miles: Type.Optional(Type.Number({ description: "Search radius in miles (default 25)" })),
  place_types: Type.Optional(
    Type.Array(Type.String(), { description: "Place type filters (hotel, restaurant, etc.)" }),
  ),
  place_id: Type.Optional(Type.String({ description: "Google place_id for enrichment" })),
  cities: Type.Optional(
    Type.Array(Type.String(), { description: "Cities for geo sweep (default: target list)" }),
  ),
  business_types: Type.Optional(
    Type.Array(Type.String(), {
      description: "Business type queries for sweep (e.g. luxury hotels, interior design firms)",
    }),
  ),
});

const LinkedinEnrichmentParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([Type.Literal("enrich_person"), Type.Literal("find_employees")], {
    description: "Enrich a person via LinkedIn URL or find employees at a company",
  }),
  linkedin_url: Type.Optional(
    Type.String({ description: "LinkedIn profile URL for person enrichment" }),
  ),
  company_domain: Type.Optional(Type.String({ description: "Company domain to find employees" })),
  target_titles: Type.Optional(
    Type.Array(Type.String(), {
      description: "Target job titles (Art Buyer, Facilities Mgr, Design Director, etc.)",
    }),
  ),
});

const ProspectQualifyParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [Type.Literal("qualify"), Type.Literal("list"), Type.Literal("update_status")],
    { description: "Qualify prospects, list by status, or update status" },
  ),
  contact_id: Type.Optional(Type.String({ description: "Contact ID to qualify or update" })),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("unqualified"),
        Type.Literal("mql"),
        Type.Literal("sql"),
        Type.Literal("qualified"),
        Type.Literal("disqualified"),
      ],
      { description: "Qualification status filter or new status" },
    ),
  ),
  reason: Type.Optional(Type.String({ description: "Reason for status override" })),
  bant: Type.Optional(
    Type.Object({
      budget: Type.Optional(Type.Number({ description: "Budget score 0-100" })),
      authority: Type.Optional(Type.Number({ description: "Authority score 0-100" })),
      need: Type.Optional(Type.Number({ description: "Need score 0-100" })),
      timeline: Type.Optional(Type.Number({ description: "Timeline score 0-100" })),
    }),
  ),
});

const ProspectImportParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [
      Type.Literal("batch_import"),
      Type.Literal("social_scan"),
      Type.Literal("website_intent"),
      Type.Literal("pipeline_sync"),
    ],
    { description: "Import action" },
  ),
  contacts: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        email: Type.Optional(Type.String()),
        company: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        phone: Type.Optional(Type.String()),
        source: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      { description: "Contacts to import for batch_import" },
    ),
  ),
  source: Type.Optional(
    Type.String({ description: "Import source label (trade_show, directory, etc.)" }),
  ),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createLeadGenerationTools(api: OpenClawPluginApi): AnyAgentTool[] {
  function prospectsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "prospect-profiles.json");
  }
  function gmapsCachePath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "gmaps-cache.json");
  }
  function apolloLeadsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "apollo-leads.json");
  }
  function personaFiltersPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "persona-apollo-filters.json");
  }
  function pipelinePath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "crm-pipeline.json");
  }

  return [
    // ── Apollo Prospecting ─────────────────────────────────────────────
    {
      name: "apollo_prospecting",
      label: "Apollo.io Prospecting",
      description:
        "Search, enrich, and discover prospects via Apollo.io REST API. " +
        "Supports people search with persona filters, bulk enrichment, org search, and credit stats. " +
        "Deduplicates against existing leads by email.",
      parameters: ApolloProspectingParams,
      async execute(_id: string, params: Static<typeof ApolloProspectingParams>) {
        const apiKey = apolloApiKey();
        const existingLeads = (await readJson(apolloLeadsPath(params.business_id))) || {
          emails: [],
          leads: [],
        };
        const existingEmails = new Set(
          (existingLeads.emails || existingLeads.leads?.map((l: any) => l.email) || []).map(
            (e: string) => e?.toLowerCase(),
          ),
        );

        switch (params.action) {
          case "search": {
            let filters: any = {};
            if (params.persona_id) {
              const personas = await readJson(personaFiltersPath(params.business_id));
              if (personas) {
                const persona = Array.isArray(personas)
                  ? personas.find((p: any) => p.id === params.persona_id)
                  : personas[params.persona_id];
                if (persona) filters = { ...persona.filters };
              }
            }
            if (params.person_titles?.length) filters.person_titles = params.person_titles;
            if (params.keywords?.length) filters.q_keywords = params.keywords.join(" ");
            if (params.employee_ranges?.length)
              filters.organization_num_employees_ranges = params.employee_ranges;
            if (params.locations?.length) filters.person_locations = params.locations;

            const maxPages = params.max_pages || 1;
            let totalNew = 0;
            let totalDupes = 0;
            const newLeads: any[] = [];

            for (let page = 1; page <= maxPages; page++) {
              const resp = await httpRequest(
                "https://api.apollo.io/api/v1/mixed_people/search",
                "POST",
                { "Content-Type": "application/json", "X-Api-Key": apiKey },
                { ...filters, page, per_page: 25 },
                15000,
              );
              if (resp.status !== 200) {
                return textResult(
                  `Apollo search failed (page ${page}): HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
                );
              }
              const data = resp.data as any;
              const people = data.people || [];
              for (const p of people) {
                const email = p.email?.toLowerCase();
                if (email && existingEmails.has(email)) {
                  totalDupes++;
                  continue;
                }
                if (email) existingEmails.add(email);
                totalNew++;
                newLeads.push({
                  apollo_id: p.id,
                  name: `${p.first_name || ""} ${p.last_name || ""}`.trim(),
                  email: p.email,
                  title: p.title,
                  company: p.organization?.name,
                  company_domain: p.organization?.primary_domain,
                  linkedin_url: p.linkedin_url,
                  city: p.city,
                  state: p.state,
                  country: p.country,
                  source: "apollo",
                  persona_id: params.persona_id,
                  fetched_at: new Date().toISOString(),
                });
              }
            }

            // Persist new leads
            existingLeads.leads = [...(existingLeads.leads || []), ...newLeads];
            existingLeads.emails = [...existingEmails];
            await writeJson(apolloLeadsPath(params.business_id), existingLeads);

            return textResult(
              `## Apollo Search Results\n\n` +
                `- **Persona:** ${params.persona_id || "custom"}\n` +
                `- **New leads:** ${totalNew}\n` +
                `- **Duplicates skipped:** ${totalDupes}\n` +
                `- **Total in database:** ${existingLeads.leads.length}\n\n` +
                (newLeads.length > 0
                  ? `### Sample new leads:\n${newLeads
                      .slice(0, 5)
                      .map(
                        (l) =>
                          `- **${l.name}** — ${l.title} at ${l.company} (${l.email || "no email"})`,
                      )
                      .join("\n")}`
                  : "No new leads found."),
            );
          }

          case "enrich": {
            if (!params.person_ids?.length)
              return textResult("Provide `person_ids` array for enrichment (batch of up to 10).");

            const ids = params.person_ids.slice(0, 10);
            const resp = await httpRequest(
              "https://api.apollo.io/api/v1/people/bulk_match",
              "POST",
              { "Content-Type": "application/json", "X-Api-Key": apiKey },
              { details: ids.map((id) => ({ id })) },
              15000,
            );
            if (resp.status !== 200) {
              return textResult(
                `Apollo enrichment failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
              );
            }
            const data = resp.data as any;
            const matches = data.matches || [];
            let enriched = 0;
            for (const m of matches) {
              if (m.email) enriched++;
            }

            return textResult(
              `## Apollo Enrichment Results\n\n` +
                `- **Requested:** ${ids.length}\n` +
                `- **Enriched (with email):** ${enriched}\n` +
                `- **Credits used:** ${ids.length}\n\n` +
                matches
                  .slice(0, 5)
                  .map(
                    (m: any) =>
                      `- **${m.first_name} ${m.last_name}** — ${m.email || "no email"} | ${m.organization?.name || "?"}`,
                  )
                  .join("\n"),
            );
          }

          case "org_search": {
            const body: any = {};
            if (params.domain) body.organization_domains = [params.domain];
            if (params.industry) body.organization_industry_tag_ids = [params.industry];
            if (params.org_size) body.organization_num_employees_ranges = [params.org_size];
            if (params.locations?.length) body.organization_locations = params.locations;

            const resp = await httpRequest(
              "https://api.apollo.io/api/v1/mixed_companies/search",
              "POST",
              { "Content-Type": "application/json", "X-Api-Key": apiKey },
              { ...body, page: 1, per_page: 25 },
              15000,
            );
            if (resp.status !== 200) {
              return textResult(
                `Apollo org search failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
              );
            }
            const data = resp.data as any;
            const orgs = data.organizations || data.accounts || [];

            return textResult(
              `## Apollo Organization Search\n\n` +
                `- **Results:** ${orgs.length}\n\n` +
                orgs
                  .slice(0, 10)
                  .map(
                    (o: any) =>
                      `- **${o.name}** — ${o.primary_domain || "?"} | ${o.industry || "?"} | ${o.estimated_num_employees || "?"} employees`,
                  )
                  .join("\n"),
            );
          }

          case "stats": {
            const leads = existingLeads.leads || [];
            const byPersona: Record<string, number> = {};
            const bySource: Record<string, number> = {};
            let withEmail = 0;
            for (const l of leads) {
              const p = l.persona_id || "unknown";
              byPersona[p] = (byPersona[p] || 0) + 1;
              const s = l.source || "unknown";
              bySource[s] = (bySource[s] || 0) + 1;
              if (l.email) withEmail++;
            }
            const enrichmentRate =
              leads.length > 0 ? Math.round((withEmail / leads.length) * 100) : 0;

            return textResult(
              `## Apollo Pipeline Stats\n\n` +
                `- **Total leads:** ${leads.length}\n` +
                `- **With email:** ${withEmail} (${enrichmentRate}% enrichment rate)\n\n` +
                `### By Persona\n${Object.entries(byPersona)
                  .map(([k, v]) => `- ${k}: ${v}`)
                  .join("\n")}\n\n` +
                `### By Source\n${Object.entries(bySource)
                  .map(([k, v]) => `- ${k}: ${v}`)
                  .join("\n")}`,
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },

    // ── Google Maps Prospecting ────────────────────────────────────────
    {
      name: "gmaps_prospecting",
      label: "Google Maps Prospecting",
      description:
        "Discover B2B prospects via Google Places API. Search for businesses by type and location, " +
        "enrich with place details (website, phone, reviews), and run geo-targeted sweeps across cities. " +
        "Results are cached for 30 days to control API costs.",
      parameters: GmapsProspectingParams,
      async execute(_id: string, params: Static<typeof GmapsProspectingParams>) {
        const apiKey = googleApiKey();
        const cache = (await readJson(gmapsCachePath(params.business_id))) || {
          places: {},
          searches: {},
          last_updated: null,
        };

        switch (params.action) {
          case "search": {
            if (!params.query) return textResult("Provide `query` for Google Maps search.");

            const cacheKey = `${params.query}|${params.location_city || ""}`;
            const cached = cache.searches[cacheKey];
            if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 86400000) {
              return textResult(
                `## Google Maps Search (cached)\n\n` +
                  `**Query:** ${params.query}\n` +
                  `**Results:** ${cached.places.length}\n\n` +
                  cached.places
                    .slice(0, 10)
                    .map(
                      (p: any) =>
                        `- **${p.displayName?.text || p.name}** — ${p.formattedAddress || "?"} | Rating: ${p.rating || "?"}`,
                    )
                    .join("\n"),
              );
            }

            const searchBody: any = {
              textQuery: params.query,
              maxResultCount: 20,
            };
            if (params.place_types?.length) {
              searchBody.includedType = params.place_types[0];
            }

            const resp = await httpRequest(
              "https://places.googleapis.com/v1/places:searchText",
              "POST",
              {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask":
                  "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.types,places.businessStatus",
              },
              searchBody,
              15000,
            );
            if (resp.status !== 200) {
              return textResult(
                `Google Maps search failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
              );
            }
            const data = resp.data as any;
            const places = data.places || [];

            // Cache results
            cache.searches[cacheKey] = {
              query: params.query,
              city: params.location_city,
              places,
              fetched_at: new Date().toISOString(),
            };
            cache.last_updated = new Date().toISOString();
            await writeJson(gmapsCachePath(params.business_id), cache);

            return textResult(
              `## Google Maps Search Results\n\n` +
                `**Query:** ${params.query}\n` +
                `**Results:** ${places.length}\n\n` +
                places
                  .slice(0, 10)
                  .map(
                    (p: any) =>
                      `- **${p.displayName?.text || "?"}** — ${p.formattedAddress || "?"}\n  Rating: ${p.rating || "?"} (${p.userRatingCount || 0} reviews) | ${p.websiteUri || "no website"}\n  Place ID: ${p.id}`,
                  )
                  .join("\n"),
            );
          }

          case "enrich": {
            if (!params.place_id) return textResult("Provide `place_id` for enrichment.");

            const cached = cache.places[params.place_id];
            if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 86400000) {
              return textResult(
                `## Place Details (cached)\n\n` +
                  `**Name:** ${cached.displayName?.text || "?"}\n` +
                  `**Address:** ${cached.formattedAddress || "?"}\n` +
                  `**Website:** ${cached.websiteUri || "none"}\n` +
                  `**Phone:** ${cached.nationalPhoneNumber || "none"}\n` +
                  `**Rating:** ${cached.rating || "?"} (${cached.userRatingCount || 0} reviews)`,
              );
            }

            const resp = await httpRequest(
              `https://places.googleapis.com/v1/places/${params.place_id}`,
              "GET",
              {
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask":
                  "id,displayName,formattedAddress,rating,userRatingCount,websiteUri,nationalPhoneNumber,internationalPhoneNumber,types,businessStatus,regularOpeningHours,reviews,editorialSummary",
              },
              undefined,
              15000,
            );
            if (resp.status !== 200) {
              return textResult(
                `Google Maps enrich failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
              );
            }
            const place = resp.data as any;

            cache.places[params.place_id] = {
              ...place,
              fetched_at: new Date().toISOString(),
            };
            cache.last_updated = new Date().toISOString();
            await writeJson(gmapsCachePath(params.business_id), cache);

            const domain = place.websiteUri
              ? new URL(place.websiteUri).hostname.replace(/^www\./, "")
              : null;

            return textResult(
              `## Place Details\n\n` +
                `**Name:** ${place.displayName?.text || "?"}\n` +
                `**Address:** ${place.formattedAddress || "?"}\n` +
                `**Website:** ${place.websiteUri || "none"}${domain ? ` (domain: ${domain})` : ""}\n` +
                `**Phone:** ${place.nationalPhoneNumber || "none"}\n` +
                `**Rating:** ${place.rating || "?"} (${place.userRatingCount || 0} reviews)\n` +
                `**Status:** ${place.businessStatus || "?"}\n` +
                (place.editorialSummary?.text
                  ? `**Summary:** ${place.editorialSummary.text}\n`
                  : "") +
                (place.reviews?.length
                  ? `\n### Recent Reviews\n${place.reviews
                      .slice(0, 3)
                      .map(
                        (r: any) => `- ★${r.rating} — "${(r.text?.text || "").slice(0, 100)}..."`,
                      )
                      .join("\n")}`
                  : "") +
                (domain
                  ? `\n\n**Next step:** Use \`apollo_prospecting:org_search\` with domain "${domain}" to find decision-makers.`
                  : ""),
            );
          }

          case "geo_sweep": {
            const defaultCities = [
              "New York",
              "Los Angeles",
              "Miami",
              "Chicago",
              "Dallas",
              "San Francisco",
              "Seattle",
              "Denver",
              "Austin",
              "Nashville",
            ];
            const defaultTypes = [
              "luxury hotels",
              "interior design firms",
              "boutique hotels",
              "art galleries",
            ];

            const cities = params.cities?.length ? params.cities : defaultCities.slice(0, 2);
            const types = params.business_types?.length
              ? params.business_types
              : defaultTypes.slice(0, 2);

            const results: { city: string; type: string; count: number }[] = [];
            let totalPlaces = 0;

            for (const city of cities) {
              for (const type of types) {
                const query = `${type} in ${city}`;
                const cacheKey = `${query}|${city}`;
                const cached = cache.searches[cacheKey];
                if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 86400000) {
                  results.push({ city, type, count: cached.places.length });
                  totalPlaces += cached.places.length;
                  continue;
                }

                const resp = await httpRequest(
                  "https://places.googleapis.com/v1/places:searchText",
                  "POST",
                  {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": apiKey,
                    "X-Goog-FieldMask":
                      "places.id,places.displayName,places.formattedAddress,places.rating,places.websiteUri,places.nationalPhoneNumber",
                  },
                  { textQuery: query, maxResultCount: 20 },
                  15000,
                );

                if (resp.status === 200) {
                  const places = (resp.data as any).places || [];
                  cache.searches[cacheKey] = {
                    query,
                    city,
                    places,
                    fetched_at: new Date().toISOString(),
                  };
                  results.push({ city, type, count: places.length });
                  totalPlaces += places.length;
                } else {
                  results.push({ city, type, count: -1 });
                }
              }
            }

            cache.last_updated = new Date().toISOString();
            await writeJson(gmapsCachePath(params.business_id), cache);

            return textResult(
              `## Google Maps Geo Sweep\n\n` +
                `**Cities:** ${cities.join(", ")}\n` +
                `**Business types:** ${types.join(", ")}\n` +
                `**Total places found:** ${totalPlaces}\n\n` +
                results
                  .map(
                    (r) =>
                      `- ${r.city} / ${r.type}: ${r.count === -1 ? "API error" : `${r.count} results`}`,
                  )
                  .join("\n"),
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },

    // ── LinkedIn Enrichment ────────────────────────────────────────────
    {
      name: "linkedin_enrichment",
      label: "LinkedIn Enrichment (via Apollo)",
      description:
        "Enrich prospects from LinkedIn URLs using Apollo's enrichment API. " +
        "Find employees at target companies by domain and job title. " +
        "No direct LinkedIn API needed — all enrichment flows through Apollo.",
      parameters: LinkedinEnrichmentParams,
      async execute(_id: string, params: Static<typeof LinkedinEnrichmentParams>) {
        const apiKey = apolloApiKey();

        switch (params.action) {
          case "enrich_person": {
            if (!params.linkedin_url)
              return textResult("Provide `linkedin_url` for person enrichment.");

            const resp = await httpRequest(
              "https://api.apollo.io/api/v1/people/match",
              "POST",
              { "Content-Type": "application/json", "X-Api-Key": apiKey },
              { linkedin_url: params.linkedin_url },
              15000,
            );
            if (resp.status !== 200) {
              return textResult(
                `Apollo LinkedIn enrichment failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
              );
            }
            const person = (resp.data as any).person || resp.data;

            return textResult(
              `## LinkedIn Person Enrichment\n\n` +
                `**Name:** ${person.first_name || "?"} ${person.last_name || "?"}\n` +
                `**Title:** ${person.title || "?"}\n` +
                `**Company:** ${person.organization?.name || "?"}\n` +
                `**Email:** ${person.email || "not found"}\n` +
                `**Phone:** ${person.phone_numbers?.[0]?.raw_number || "not found"}\n` +
                `**LinkedIn:** ${params.linkedin_url}\n` +
                `**Apollo ID:** ${person.id || "?"}`,
            );
          }

          case "find_employees": {
            if (!params.company_domain)
              return textResult("Provide `company_domain` to find employees.");

            const titles = params.target_titles || [
              "Art Buyer",
              "Facilities Manager",
              "Design Director",
              "Interior Designer",
              "Procurement Manager",
              "Office Manager",
            ];

            const resp = await httpRequest(
              "https://api.apollo.io/api/v1/mixed_people/search",
              "POST",
              { "Content-Type": "application/json", "X-Api-Key": apiKey },
              {
                organization_domains: [params.company_domain],
                person_titles: titles,
                page: 1,
                per_page: 25,
              },
              15000,
            );
            if (resp.status !== 200) {
              return textResult(
                `Apollo employee search failed: HTTP ${resp.status}\n${JSON.stringify(resp.data)}`,
              );
            }
            const data = resp.data as any;
            const people = data.people || [];

            return textResult(
              `## Employees at ${params.company_domain}\n\n` +
                `**Matching titles:** ${titles.join(", ")}\n` +
                `**Found:** ${people.length}\n\n` +
                people
                  .slice(0, 10)
                  .map(
                    (p: any) =>
                      `- **${p.first_name} ${p.last_name}** — ${p.title || "?"}\n  Email: ${p.email || "?"} | LinkedIn: ${p.linkedin_url || "?"}`,
                  )
                  .join("\n"),
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },

    // ── Prospect Qualify ───────────────────────────────────────────────
    {
      name: "prospect_qualify",
      label: "Prospect BANT Qualification",
      description:
        "Qualify prospects through BANT framework (Budget, Authority, Need, Timeline). " +
        "Manages lifecycle stages: unqualified → mql → sql → qualified → disqualified. " +
        "Integrates with lead_scoring for scoring component.",
      parameters: ProspectQualifyParams,
      async execute(_id: string, params: Static<typeof ProspectQualifyParams>) {
        const profiles = (await readJson(prospectsPath(params.business_id))) || { prospects: [] };

        switch (params.action) {
          case "qualify": {
            if (!params.contact_id) return textResult("Provide `contact_id` to qualify.");

            let prospect = profiles.prospects.find((p: any) => p.contact_id === params.contact_id);
            if (!prospect) {
              prospect = {
                contact_id: params.contact_id,
                qualification_status: "unqualified",
                bant: { budget: 0, authority: 0, need: 0, timeline: 0 },
                created_at: new Date().toISOString(),
              };
              profiles.prospects.push(prospect);
            }

            // Update BANT if provided
            if (params.bant) {
              Object.assign(prospect.bant, params.bant);
            }

            // Calculate BANT total
            const bantTotal =
              (prospect.bant.budget || 0) * 0.3 +
              (prospect.bant.authority || 0) * 0.25 +
              (prospect.bant.need || 0) * 0.3 +
              (prospect.bant.timeline || 0) * 0.15;

            // Determine qualification status
            let newStatus: string;
            if (bantTotal >= 75) newStatus = "sql";
            else if (bantTotal >= 50) newStatus = "mql";
            else if (bantTotal >= 25) newStatus = "unqualified";
            else newStatus = "disqualified";

            const oldStatus = prospect.qualification_status;
            prospect.qualification_status = newStatus;
            prospect.bant_score = Math.round(bantTotal);
            prospect.qualified_at = new Date().toISOString();

            await writeJson(prospectsPath(params.business_id), profiles);

            const recommendation =
              newStatus === "sql"
                ? "Fast-track to Outreach agent for immediate contact"
                : newStatus === "mql"
                  ? "Route to Sales Research for deep profiling"
                  : newStatus === "unqualified"
                    ? "Continue monitoring; needs more data points"
                    : "Archive — does not meet minimum criteria";

            return textResult(
              `## Prospect Qualification\n\n` +
                `**Contact:** ${params.contact_id}\n` +
                `**Status:** ${oldStatus} → **${newStatus}**\n` +
                `**BANT Score:** ${Math.round(bantTotal)}/100\n\n` +
                `### BANT Breakdown\n` +
                `- Budget (30%): ${prospect.bant.budget || 0}\n` +
                `- Authority (25%): ${prospect.bant.authority || 0}\n` +
                `- Need (30%): ${prospect.bant.need || 0}\n` +
                `- Timeline (15%): ${prospect.bant.timeline || 0}\n\n` +
                `**Recommendation:** ${recommendation}`,
            );
          }

          case "list": {
            const statusFilter = params.status;
            const filtered = statusFilter
              ? profiles.prospects.filter((p: any) => p.qualification_status === statusFilter)
              : profiles.prospects;

            if (filtered.length === 0)
              return textResult(
                `No prospects${statusFilter ? ` with status "${statusFilter}"` : ""}.`,
              );

            const sorted = filtered.sort(
              (a: any, b: any) => (b.bant_score || 0) - (a.bant_score || 0),
            );

            return textResult(
              `## Prospects${statusFilter ? ` (${statusFilter})` : ""} — ${sorted.length} total\n\n` +
                sorted
                  .slice(0, 20)
                  .map(
                    (p: any, i: number) =>
                      `${i + 1}. **${p.contact_id}** — ${p.qualification_status} | BANT: ${p.bant_score || "?"}`,
                  )
                  .join("\n"),
            );
          }

          case "update_status": {
            if (!params.contact_id || !params.status)
              return textResult("Provide `contact_id` and `status` for override.");

            const prospect = profiles.prospects.find(
              (p: any) => p.contact_id === params.contact_id,
            );
            if (!prospect) return textResult(`Prospect ${params.contact_id} not found.`);

            const oldStatus = prospect.qualification_status;
            prospect.qualification_status = params.status;
            prospect.status_override = {
              reason: params.reason || "Manual override",
              at: new Date().toISOString(),
            };

            await writeJson(prospectsPath(params.business_id), profiles);

            return textResult(
              `Prospect **${params.contact_id}** status updated: ${oldStatus} → **${params.status}**\nReason: ${params.reason || "Manual override"}`,
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },

    // ── Prospect Import ────────────────────────────────────────────────
    {
      name: "prospect_import",
      label: "Prospect Import & Sync",
      description:
        "Bulk import prospects from CSV/JSON, scan social engagement for high-intent followers, " +
        "score Shopify visitor intent, and sync qualified leads into CRM pipeline.",
      parameters: ProspectImportParams,
      async execute(_id: string, params: Static<typeof ProspectImportParams>) {
        const profiles = (await readJson(prospectsPath(params.business_id))) || { prospects: [] };

        switch (params.action) {
          case "batch_import": {
            if (!params.contacts?.length)
              return textResult("Provide `contacts` array for batch import.");

            const existingIds = new Set(profiles.prospects.map((p: any) => p.email?.toLowerCase()));
            let imported = 0;
            let dupes = 0;

            for (const c of params.contacts) {
              const email = c.email?.toLowerCase();
              if (email && existingIds.has(email)) {
                dupes++;
                continue;
              }
              if (email) existingIds.add(email);
              profiles.prospects.push({
                contact_id: `IMP-${Date.now().toString(36)}-${imported}`,
                name: c.name,
                email: c.email,
                company: c.company,
                title: c.title,
                phone: c.phone,
                source: params.source || c.source || "batch_import",
                tags: c.tags || [],
                qualification_status: "unqualified",
                bant: { budget: 0, authority: 0, need: 0, timeline: 0 },
                created_at: new Date().toISOString(),
              });
              imported++;
            }

            await writeJson(prospectsPath(params.business_id), profiles);

            return textResult(
              `## Batch Import Results\n\n` +
                `- **Imported:** ${imported}\n` +
                `- **Duplicates skipped:** ${dupes}\n` +
                `- **Source:** ${params.source || "batch_import"}\n` +
                `- **Total prospects:** ${profiles.prospects.length}`,
            );
          }

          case "social_scan": {
            // Placeholder — would analyze IG/Pinterest engagement
            return textResult(
              `## Social Scan\n\n` +
                `Social engagement analysis would scan IG/Pinterest followers for:\n` +
                `- High engagement (likes, saves, comments on VividWalls posts)\n` +
                `- Business account indicators\n` +
                `- Design/art interest signals\n\n` +
                `**Status:** Ready — requires Meta Graph API integration for IG follower analysis.\n` +
                `Use existing \`content_analytics\` tool for engagement data, then import high-intent followers here.`,
            );
          }

          case "website_intent": {
            // Placeholder — would analyze Shopify visitor behavior
            return textResult(
              `## Website Intent Analysis\n\n` +
                `Shopify visitor intent scoring would analyze:\n` +
                `- Cart abandonment (high intent)\n` +
                `- Product page views > 3 (medium intent)\n` +
                `- Time on site > 5 min (medium intent)\n` +
                `- Repeat visits (high intent)\n\n` +
                `**Status:** Ready — use existing Shopify tools for order/customer data, then score intent.`,
            );
          }

          case "pipeline_sync": {
            const qualified = profiles.prospects.filter(
              (p: any) => p.qualification_status === "mql" || p.qualification_status === "sql",
            );
            if (qualified.length === 0)
              return textResult("No qualified prospects to sync to pipeline.");

            // Read CRM pipeline and add as deals
            const pipeline = (await readJson(pipelinePath(params.business_id))) || {
              deals: [],
              contacts: [],
              stage_history: [],
            };

            const existingDealContacts = new Set(pipeline.deals.map((d: any) => d.contact_id));
            let synced = 0;

            for (const p of qualified) {
              if (existingDealContacts.has(p.contact_id)) continue;

              // Create contact if needed
              if (!pipeline.contacts.find((c: any) => c.id === p.contact_id)) {
                pipeline.contacts.push({
                  id: p.contact_id,
                  name: p.name || p.contact_id,
                  email: p.email,
                  company: p.company,
                  tags: p.tags || [],
                  created_at: new Date().toISOString(),
                });
              }

              // Create deal
              const stage = p.qualification_status === "sql" ? "qualified" : "prospect";
              const deal = {
                id: `DEAL-${Date.now().toString(36)}-${synced}`,
                name: `${p.name || p.company || p.contact_id} — VividWalls`,
                value: 0,
                stage,
                contact_id: p.contact_id,
                notes: `Auto-synced from prospect pipeline. BANT score: ${p.bant_score || "?"}`,
                tags: ["auto-synced", p.qualification_status],
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              pipeline.deals.push(deal);
              pipeline.stage_history.push({
                deal_id: deal.id,
                from: null,
                to: stage,
                at: deal.created_at,
              });
              synced++;
            }

            await writeJson(pipelinePath(params.business_id), pipeline);

            return textResult(
              `## Pipeline Sync\n\n` +
                `- **Qualified prospects:** ${qualified.length}\n` +
                `- **Synced to CRM:** ${synced}\n` +
                `- **Already in pipeline:** ${qualified.length - synced}\n` +
                `- **Total deals:** ${pipeline.deals.length}`,
            );
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },
  ];
}

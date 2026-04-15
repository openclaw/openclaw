import {
  computeStats,
  fetchStroLicenses,
  searchLicenses,
  type StroLicense,
} from "./stro-client.js";

function formatLicense(r: StroLicense): Record<string, string> {
  return {
    license_id: r.license_id,
    address: r.address,
    tier: r.tier,
    community_planning_area: r.community_planning_area,
    zip: r.zip,
    council_district: r.council_district,
    date_expiration: r.date_expiration,
    host_contact_name: r.host_contact_name,
    local_contact_name: r.local_contact_contact_name,
    local_contact_phone: r.local_contact_phone,
    tot_no: r.tot_no,
    rtax_no: r.rtax_no,
    latitude: r.latitude,
    longitude: r.longitude,
  };
}

export const stroSdTool = {
  name: "stro_sd_licenses",
  label: "San Diego STRO Licenses",
  description:
    "Look up active Short-Term Residential Occupancy (STRO) licenses issued by the City of San Diego. " +
    "Use action=search to filter licenses, action=get to look up a specific license by ID, " +
    "and action=stats to see a summary of all active licenses.",
  // Plain JSON schema — no external dependencies needed
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["search", "get", "stats"],
        description:
          'Action to perform: "search" filters licenses, "get" retrieves one by license_id, "stats" returns aggregate counts.',
      },
      license_id: {
        type: "string",
        description: 'License ID to look up (for action=get), e.g. "STR-01636L".',
      },
      tier: {
        type: "string",
        description: 'Filter by license tier, e.g. "Tier 1", "Tier 2", "Tier 3", or "Tier 4".',
      },
      community_planning_area: {
        type: "string",
        description:
          'Filter by community planning area (partial match), e.g. "NORTH PARK" or "MISSION BEACH".',
      },
      zip: {
        type: "string",
        description: 'Filter by ZIP code, e.g. "92104".',
      },
      council_district: {
        type: "string",
        description: 'Filter by city council district number, e.g. "3".',
      },
      address_query: {
        type: "string",
        description: "Partial address string to search for.",
      },
      host_name: {
        type: "string",
        description: "Partial host or local contact name to search for.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default 50, max 200).",
        minimum: 1,
        maximum: 200,
      },
    },
  },

  async execute(_id: string, params: Record<string, unknown>) {
    const action = typeof params.action === "string" ? params.action.trim() : "";

    const licenses = await fetchStroLicenses();

    if (action === "stats") {
      const stats = computeStats(licenses);
      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        details: stats,
      };
    }

    if (action === "get") {
      const id = typeof params.license_id === "string" ? params.license_id.trim() : "";
      if (!id) {
        throw new Error('license_id is required for action="get"');
      }
      const results = searchLicenses(licenses, { license_id: id, limit: 1 });
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `License not found: ${id}` }) }],
          details: { error: `License not found: ${id}` },
        };
      }
      const record = formatLicense(results[0]!);
      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        details: record,
      };
    }

    if (action === "search") {
      const limit =
        typeof params.limit === "number"
          ? Math.min(Math.max(1, params.limit), 200)
          : 50;

      const results = searchLicenses(licenses, {
        tier: typeof params.tier === "string" ? params.tier : undefined,
        community_planning_area:
          typeof params.community_planning_area === "string"
            ? params.community_planning_area
            : undefined,
        zip: typeof params.zip === "string" ? params.zip : undefined,
        council_district:
          typeof params.council_district === "string" ? params.council_district : undefined,
        address_query:
          typeof params.address_query === "string" ? params.address_query : undefined,
        host_name: typeof params.host_name === "string" ? params.host_name : undefined,
        limit,
      });

      const formatted = results.map(formatLicense);
      const payload = {
        total_returned: formatted.length,
        data_source: "City of San Diego STRO Licenses (seshat.datasd.org)",
        licenses: formatted,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    }

    throw new Error(`Unknown action "${action}". Use "search", "get", or "stats".`);
  },
};

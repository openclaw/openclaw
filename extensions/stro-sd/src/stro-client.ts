const STRO_CSV_URL =
  "https://seshat.datasd.org/stro_licenses/stro_licenses_datasd.csv";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export type StroLicense = {
  license_id: string;
  address: string;
  street_number: string;
  street_number_fraction: string;
  street_direction: string;
  street_name: string;
  street_type: string;
  unit_type: string;
  unit_number: string;
  city: string;
  state: string;
  zip: string;
  tier: string;
  community_planning_area: string;
  date_expiration: string;
  rtax_no: string;
  tot_no: string;
  longitude: string;
  latitude: string;
  local_contact_contact_name: string;
  local_contact_phone: string;
  host_contact_name: string;
  council_district: string;
};

type CacheEntry = {
  records: StroLicense[];
  fetchedAt: number;
};

let cache: CacheEntry | null = null;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote inside quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(text: string): StroLicense[] {
  // Strip UTF-8 BOM if present
  const cleaned = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0] ?? "").map((h) => h.trim());
  const records: StroLicense[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i] ?? "");
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j] ?? ""] = values[j]?.trim() ?? "";
    }
    records.push(record as unknown as StroLicense);
  }

  return records;
}

export async function fetchStroLicenses(): Promise<StroLicense[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.records;
  }

  const response = await fetch(STRO_CSV_URL, {
    headers: { "User-Agent": "openclaw-stro-sd-plugin/1.0" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch STRO licenses: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  const records = parseCsv(text);
  cache = { records, fetchedAt: now };
  return records;
}

export type StroSearchParams = {
  license_id?: string;
  tier?: string;
  community_planning_area?: string;
  zip?: string;
  council_district?: string;
  address_query?: string;
  host_name?: string;
  limit?: number;
};

export function searchLicenses(
  records: StroLicense[],
  params: StroSearchParams,
): StroLicense[] {
  let results = records;

  if (params.license_id) {
    const id = params.license_id.trim().toUpperCase();
    results = results.filter((r) => r.license_id.toUpperCase() === id);
  }

  if (params.tier) {
    const tier = params.tier.trim().toLowerCase();
    results = results.filter((r) => r.tier.toLowerCase().includes(tier));
  }

  if (params.community_planning_area) {
    const area = params.community_planning_area.trim().toLowerCase();
    results = results.filter((r) =>
      r.community_planning_area.toLowerCase().includes(area),
    );
  }

  if (params.zip) {
    const zip = params.zip.trim();
    results = results.filter((r) => r.zip === zip);
  }

  if (params.council_district) {
    const district = params.council_district.trim();
    results = results.filter((r) => r.council_district === district);
  }

  if (params.address_query) {
    const query = params.address_query.trim().toLowerCase();
    results = results.filter((r) => r.address.toLowerCase().includes(query));
  }

  if (params.host_name) {
    const name = params.host_name.trim().toLowerCase();
    results = results.filter(
      (r) =>
        r.host_contact_name.toLowerCase().includes(name) ||
        r.local_contact_contact_name.toLowerCase().includes(name),
    );
  }

  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 50;
  return results.slice(0, limit);
}

export type StroStats = {
  total: number;
  by_tier: Record<string, number>;
  by_council_district: Record<string, number>;
  top_community_planning_areas: Array<{ area: string; count: number }>;
};

export function computeStats(records: StroLicense[]): StroStats {
  const byTier: Record<string, number> = {};
  const byDistrict: Record<string, number> = {};
  const byArea: Record<string, number> = {};

  for (const r of records) {
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    byDistrict[r.council_district] = (byDistrict[r.council_district] ?? 0) + 1;
    byArea[r.community_planning_area] =
      (byArea[r.community_planning_area] ?? 0) + 1;
  }

  const topAreas = Object.entries(byArea)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([area, count]) => ({ area, count }));

  return {
    total: records.length,
    by_tier: byTier,
    by_council_district: byDistrict,
    top_community_planning_areas: topAreas,
  };
}

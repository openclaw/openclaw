/**
 * Cloudflare DNS & Zone Tools — Manage zones, DNS records, and cache purging
 *
 * Reads credentials from integrations.json → "cloudflare-dns" entry.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { httpRequest, textResult, resolveWorkspaceDir } from "./common.js";

// ── Credential loader ──────────────────────────────────────────────────

interface CloudflareCreds {
  apiToken: string;
  accountId: string;
}

async function loadCloudflareCreds(api: OpenClawPluginApi): Promise<CloudflareCreds | null> {
  const ws = resolveWorkspaceDir(api);
  const paths = [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ];
  for (const p of paths) {
    try {
      const data = JSON.parse(await readFile(p, "utf-8"));
      const entry = (data.integrations || []).find(
        (i: any) => i.id === "cloudflare-dns" && i.enabled,
      );
      if (entry?.api_key) {
        return {
          apiToken: entry.api_key,
          accountId: entry.metadata?.account_id || "",
        };
      }
    } catch {}
  }
  return null;
}

function cfHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const CF_BASE = "https://api.cloudflare.com/client/v4";

// ── Parameter Schemas ──────────────────────────────────────────────────

const ListZonesParams = Type.Object({
  name: Type.Optional(Type.String({ description: "Filter by domain name" })),
  page: Type.Optional(Type.Number({ description: "Page number (default 1)" })),
  per_page: Type.Optional(Type.Number({ description: "Results per page (default 20, max 50)" })),
});

const ListDnsParams = Type.Object({
  zone_id: Type.String({ description: "Cloudflare zone ID" }),
  type: Type.Optional(
    Type.String({ description: "DNS record type filter (A, AAAA, CNAME, MX, TXT, etc.)" }),
  ),
  name: Type.Optional(Type.String({ description: "Filter by record name" })),
  page: Type.Optional(Type.Number()),
  per_page: Type.Optional(Type.Number()),
});

const AddDnsParams = Type.Object({
  zone_id: Type.String({ description: "Cloudflare zone ID" }),
  type: Type.String({ description: "Record type: A, AAAA, CNAME, MX, TXT, SRV, NS" }),
  name: Type.String({ description: "DNS record name (e.g. subdomain.example.com)" }),
  content: Type.String({ description: "Record content (IP, hostname, text value)" }),
  ttl: Type.Optional(Type.Number({ description: "TTL in seconds (1 = auto)" })),
  proxied: Type.Optional(
    Type.Boolean({ description: "Whether to proxy through Cloudflare (default false)" }),
  ),
  priority: Type.Optional(Type.Number({ description: "MX priority (required for MX records)" })),
});

const UpdateDnsParams = Type.Object({
  zone_id: Type.String({ description: "Cloudflare zone ID" }),
  record_id: Type.String({ description: "DNS record ID to update" }),
  type: Type.Optional(Type.String({ description: "Record type" })),
  name: Type.Optional(Type.String({ description: "Record name" })),
  content: Type.Optional(Type.String({ description: "Record content" })),
  ttl: Type.Optional(Type.Number({ description: "TTL in seconds" })),
  proxied: Type.Optional(Type.Boolean({ description: "Proxy through Cloudflare" })),
});

const DeleteDnsParams = Type.Object({
  zone_id: Type.String({ description: "Cloudflare zone ID" }),
  record_id: Type.String({ description: "DNS record ID to delete" }),
});

const PurgeCacheParams = Type.Object({
  zone_id: Type.String({ description: "Cloudflare zone ID" }),
  purge_everything: Type.Optional(
    Type.Boolean({ description: "Purge all cached files (default false)" }),
  ),
  files: Type.Optional(Type.Array(Type.String(), { description: "Specific URLs to purge" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Cache tags to purge" })),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createCloudflareTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "cloudflare_list_zones",
      label: "Cloudflare List Zones",
      description: "List all DNS zones (domains) in the Cloudflare account.",
      parameters: ListZonesParams,
      async execute(_id: string, params: Static<typeof ListZonesParams>) {
        const creds = await loadCloudflareCreds(api);
        if (!creds)
          return textResult("Cloudflare not configured. Add cloudflare-dns to integrations.json.");

        const qs = new URLSearchParams();
        if (params.name) qs.set("name", params.name);
        qs.set("page", String(params.page || 1));
        qs.set("per_page", String(params.per_page || 20));

        const res = await httpRequest(
          `${CF_BASE}/zones?${qs.toString()}`,
          "GET",
          cfHeaders(creds.apiToken),
          undefined,
          10000,
        );

        if (res.status !== 200) {
          return textResult(`Cloudflare error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const body = res.data as any;
        const zones = body.result || [];
        if (zones.length === 0) return textResult("No zones found.");

        const list = zones
          .map(
            (z: any, i: number) =>
              `${i + 1}. **${z.name}** | ID: \`${z.id}\` | Status: ${z.status} | Plan: ${z.plan?.name || "N/A"}`,
          )
          .join("\n");
        return textResult(
          `## Cloudflare Zones (${body.result_info?.total_count || zones.length})\n\n${list}`,
        );
      },
    },

    {
      name: "cloudflare_list_dns",
      label: "Cloudflare List DNS Records",
      description: "List DNS records for a specific zone. Optionally filter by type or name.",
      parameters: ListDnsParams,
      async execute(_id: string, params: Static<typeof ListDnsParams>) {
        const creds = await loadCloudflareCreds(api);
        if (!creds) return textResult("Cloudflare not configured.");

        const qs = new URLSearchParams();
        if (params.type) qs.set("type", params.type);
        if (params.name) qs.set("name", params.name);
        qs.set("page", String(params.page || 1));
        qs.set("per_page", String(params.per_page || 50));

        const res = await httpRequest(
          `${CF_BASE}/zones/${encodeURIComponent(params.zone_id)}/dns_records?${qs.toString()}`,
          "GET",
          cfHeaders(creds.apiToken),
          undefined,
          10000,
        );

        if (res.status !== 200) {
          return textResult(`Cloudflare error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const body = res.data as any;
        const records = body.result || [];
        if (records.length === 0) return textResult("No DNS records found.");

        const list = records
          .map(
            (r: any, i: number) =>
              `${i + 1}. **${r.type}** \`${r.name}\` -> \`${r.content}\` | TTL: ${r.ttl === 1 ? "auto" : r.ttl} | Proxied: ${r.proxied ? "yes" : "no"} | ID: \`${r.id}\``,
          )
          .join("\n");
        return textResult(
          `## DNS Records (${body.result_info?.total_count || records.length})\n\n${list}`,
        );
      },
    },

    {
      name: "cloudflare_add_dns",
      label: "Cloudflare Add DNS Record",
      description: "Add a new DNS record to a zone (A, AAAA, CNAME, MX, TXT, etc.).",
      parameters: AddDnsParams,
      async execute(_id: string, params: Static<typeof AddDnsParams>) {
        const creds = await loadCloudflareCreds(api);
        if (!creds) return textResult("Cloudflare not configured.");

        const payload: Record<string, unknown> = {
          type: params.type,
          name: params.name,
          content: params.content,
          ttl: params.ttl || 1,
          proxied: params.proxied ?? false,
        };
        if (params.priority != null) payload.priority = params.priority;

        const res = await httpRequest(
          `${CF_BASE}/zones/${encodeURIComponent(params.zone_id)}/dns_records`,
          "POST",
          cfHeaders(creds.apiToken),
          payload,
          10000,
        );

        if (res.status === 200) {
          const r = (res.data as any).result;
          return textResult(
            `DNS record created:\n- **${r.type}** \`${r.name}\` -> \`${r.content}\`\n- ID: \`${r.id}\`\n- TTL: ${r.ttl === 1 ? "auto" : r.ttl}`,
          );
        }
        return textResult(`Cloudflare error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "cloudflare_update_dns",
      label: "Cloudflare Update DNS Record",
      description: "Update an existing DNS record in a zone.",
      parameters: UpdateDnsParams,
      async execute(_id: string, params: Static<typeof UpdateDnsParams>) {
        const creds = await loadCloudflareCreds(api);
        if (!creds) return textResult("Cloudflare not configured.");

        const payload: Record<string, unknown> = {};
        if (params.type) payload.type = params.type;
        if (params.name) payload.name = params.name;
        if (params.content) payload.content = params.content;
        if (params.ttl != null) payload.ttl = params.ttl;
        if (params.proxied != null) payload.proxied = params.proxied;

        const res = await httpRequest(
          `${CF_BASE}/zones/${encodeURIComponent(params.zone_id)}/dns_records/${encodeURIComponent(params.record_id)}`,
          "PATCH",
          cfHeaders(creds.apiToken),
          payload,
          10000,
        );

        if (res.status === 200) {
          const r = (res.data as any).result;
          return textResult(
            `DNS record updated:\n- **${r.type}** \`${r.name}\` -> \`${r.content}\`\n- ID: \`${r.id}\``,
          );
        }
        return textResult(`Cloudflare error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "cloudflare_delete_dns",
      label: "Cloudflare Delete DNS Record",
      description: "Delete a DNS record from a zone. This action is irreversible.",
      parameters: DeleteDnsParams,
      async execute(_id: string, params: Static<typeof DeleteDnsParams>) {
        const creds = await loadCloudflareCreds(api);
        if (!creds) return textResult("Cloudflare not configured.");

        const res = await httpRequest(
          `${CF_BASE}/zones/${encodeURIComponent(params.zone_id)}/dns_records/${encodeURIComponent(params.record_id)}`,
          "DELETE",
          cfHeaders(creds.apiToken),
          undefined,
          10000,
        );

        if (res.status === 200) {
          return textResult(
            `DNS record \`${params.record_id}\` deleted from zone \`${params.zone_id}\`.`,
          );
        }
        return textResult(`Cloudflare error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "cloudflare_purge_cache",
      label: "Cloudflare Purge Cache",
      description:
        "Purge the Cloudflare cache for a zone. Can purge everything, specific URLs, or cache tags.",
      parameters: PurgeCacheParams,
      async execute(_id: string, params: Static<typeof PurgeCacheParams>) {
        const creds = await loadCloudflareCreds(api);
        if (!creds) return textResult("Cloudflare not configured.");

        const payload: Record<string, unknown> = {};
        if (params.purge_everything) {
          payload.purge_everything = true;
        } else if (params.files?.length) {
          payload.files = params.files;
        } else if (params.tags?.length) {
          payload.tags = params.tags;
        } else {
          return textResult("Specify purge_everything, files, or tags.");
        }

        const res = await httpRequest(
          `${CF_BASE}/zones/${encodeURIComponent(params.zone_id)}/purge_cache`,
          "POST",
          cfHeaders(creds.apiToken),
          payload,
          10000,
        );

        if (res.status === 200) {
          if (params.purge_everything) {
            return textResult(`Full cache purge initiated for zone \`${params.zone_id}\`.`);
          }
          return textResult(
            `Cache purge initiated for ${params.files?.length || params.tags?.length || 0} item(s).`,
          );
        }
        return textResult(`Cloudflare error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },
  ];
}

/**
 * GoDaddy DNS Tools — Domain listing and DNS record management
 *
 * Reads credentials from integrations.json → "godaddy-dns" entry.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { httpRequest, textResult, resolveWorkspaceDir } from "./common.js";

// ── Credential loader ──────────────────────────────────────────────────

interface GoDaddyCreds {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
}

async function loadGoDaddyCreds(api: OpenClawPluginApi): Promise<GoDaddyCreds | null> {
  const ws = resolveWorkspaceDir(api);
  const paths = [
    join(ws, "businesses", "vividwalls", "integrations.json"),
    join(ws, "integrations.json"),
  ];
  for (const p of paths) {
    try {
      const data = JSON.parse(await readFile(p, "utf-8"));
      const entry = (data.integrations || []).find((i: any) => i.id === "godaddy-dns" && i.enabled);
      if (entry?.api_key && entry?.metadata?.api_secret) {
        return {
          apiKey: entry.api_key,
          apiSecret: entry.metadata.api_secret,
          baseUrl: (entry.base_url || "https://api.godaddy.com").replace(/\/$/, ""),
        };
      }
    } catch {}
  }
  return null;
}

function gdHeaders(key: string, secret: string) {
  return { Authorization: `sso-key ${key}:${secret}` };
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const ListDomainsParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max domains to return (default 100)" })),
  status: Type.Optional(Type.String({ description: "Filter by status: ACTIVE, CANCELLED, etc." })),
});

const ListDnsParams = Type.Object({
  domain: Type.String({ description: "Domain name (e.g. example.com)" }),
  type: Type.Optional(
    Type.String({ description: "Record type filter: A, AAAA, CNAME, MX, TXT, NS, SRV" }),
  ),
  name: Type.Optional(Type.String({ description: "Record name filter" })),
});

const AddDnsParams = Type.Object({
  domain: Type.String({ description: "Domain name" }),
  type: Type.String({ description: "Record type: A, AAAA, CNAME, MX, TXT, NS, SRV" }),
  name: Type.String({ description: "Record name (e.g. @ or subdomain)" }),
  data: Type.String({ description: "Record data (IP, hostname, text value)" }),
  ttl: Type.Optional(Type.Number({ description: "TTL in seconds (default 3600)" })),
  priority: Type.Optional(Type.Number({ description: "Priority (required for MX/SRV)" })),
});

const UpdateDnsParams = Type.Object({
  domain: Type.String({ description: "Domain name" }),
  type: Type.String({ description: "Record type to update" }),
  name: Type.String({ description: "Record name to update" }),
  records: Type.Array(
    Type.Object({
      data: Type.String({ description: "Record data" }),
      ttl: Type.Optional(Type.Number({ description: "TTL in seconds" })),
      priority: Type.Optional(Type.Number()),
    }),
    { description: "Replacement records for this type+name" },
  ),
});

const DeleteDnsParams = Type.Object({
  domain: Type.String({ description: "Domain name" }),
  type: Type.String({ description: "Record type to delete" }),
  name: Type.String({ description: "Record name to delete" }),
});

// ── Tool Factory ───────────────────────────────────────────────────────

export function createGoDaddyTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "godaddy_list_domains",
      label: "GoDaddy List Domains",
      description: "List all domains in the GoDaddy account.",
      parameters: ListDomainsParams,
      async execute(_id: string, params: Static<typeof ListDomainsParams>) {
        const creds = await loadGoDaddyCreds(api);
        if (!creds)
          return textResult("GoDaddy not configured. Add godaddy-dns to integrations.json.");

        const qs = new URLSearchParams();
        qs.set("limit", String(params.limit || 100));
        if (params.status) qs.set("statuses", params.status);

        const res = await httpRequest(
          `${creds.baseUrl}/v1/domains?${qs.toString()}`,
          "GET",
          gdHeaders(creds.apiKey, creds.apiSecret),
          undefined,
          10000,
        );

        if (res.status !== 200) {
          return textResult(`GoDaddy error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const domains = res.data as any[];
        if (!domains?.length) return textResult("No domains found.");

        const list = domains
          .map(
            (d: any, i: number) =>
              `${i + 1}. **${d.domain}** | Status: ${d.status} | Expires: ${d.expires || "N/A"} | Auto-renew: ${d.renewAuto ? "yes" : "no"}`,
          )
          .join("\n");
        return textResult(`## GoDaddy Domains (${domains.length})\n\n${list}`);
      },
    },

    {
      name: "godaddy_list_dns",
      label: "GoDaddy List DNS Records",
      description: "List DNS records for a domain. Optionally filter by type and name.",
      parameters: ListDnsParams,
      async execute(_id: string, params: Static<typeof ListDnsParams>) {
        const creds = await loadGoDaddyCreds(api);
        if (!creds) return textResult("GoDaddy not configured.");

        let url = `${creds.baseUrl}/v1/domains/${encodeURIComponent(params.domain)}/records`;
        if (params.type) {
          url += `/${encodeURIComponent(params.type)}`;
          if (params.name) url += `/${encodeURIComponent(params.name)}`;
        }

        const res = await httpRequest(
          url,
          "GET",
          gdHeaders(creds.apiKey, creds.apiSecret),
          undefined,
          10000,
        );

        if (res.status !== 200) {
          return textResult(`GoDaddy error (${res.status}): ${JSON.stringify(res.data)}`);
        }

        const records = res.data as any[];
        if (!records?.length) return textResult("No DNS records found.");

        const list = records
          .map(
            (r: any, i: number) =>
              `${i + 1}. **${r.type}** \`${r.name}\` -> \`${r.data}\` | TTL: ${r.ttl}${r.priority != null ? ` | Priority: ${r.priority}` : ""}`,
          )
          .join("\n");
        return textResult(`## DNS Records for ${params.domain} (${records.length})\n\n${list}`);
      },
    },

    {
      name: "godaddy_add_dns",
      label: "GoDaddy Add DNS Record",
      description: "Add a new DNS record to a domain.",
      parameters: AddDnsParams,
      async execute(_id: string, params: Static<typeof AddDnsParams>) {
        const creds = await loadGoDaddyCreds(api);
        if (!creds) return textResult("GoDaddy not configured.");

        const record: Record<string, unknown> = {
          type: params.type,
          name: params.name,
          data: params.data,
          ttl: params.ttl || 3600,
        };
        if (params.priority != null) record.priority = params.priority;

        const res = await httpRequest(
          `${creds.baseUrl}/v1/domains/${encodeURIComponent(params.domain)}/records`,
          "PATCH",
          gdHeaders(creds.apiKey, creds.apiSecret),
          [record],
          10000,
        );

        if (res.status === 200 || res.status === 204) {
          return textResult(
            `DNS record added to ${params.domain}:\n- **${params.type}** \`${params.name}\` -> \`${params.data}\` (TTL: ${params.ttl || 3600})`,
          );
        }
        return textResult(`GoDaddy error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "godaddy_update_dns",
      label: "GoDaddy Update DNS Records",
      description:
        "Replace all DNS records for a given type+name on a domain. " +
        "This replaces existing records of that type/name with the provided records.",
      parameters: UpdateDnsParams,
      async execute(_id: string, params: Static<typeof UpdateDnsParams>) {
        const creds = await loadGoDaddyCreds(api);
        if (!creds) return textResult("GoDaddy not configured.");

        const records = params.records.map((r) => ({
          data: r.data,
          ttl: r.ttl || 3600,
          ...(r.priority != null ? { priority: r.priority } : {}),
        }));

        const res = await httpRequest(
          `${creds.baseUrl}/v1/domains/${encodeURIComponent(params.domain)}/records/${encodeURIComponent(params.type)}/${encodeURIComponent(params.name)}`,
          "PUT",
          gdHeaders(creds.apiKey, creds.apiSecret),
          records,
          10000,
        );

        if (res.status === 200 || res.status === 204) {
          return textResult(
            `DNS records updated for ${params.domain}: **${params.type}** \`${params.name}\` (${records.length} record(s))`,
          );
        }
        return textResult(`GoDaddy error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },

    {
      name: "godaddy_delete_dns",
      label: "GoDaddy Delete DNS Record",
      description: "Delete all DNS records matching a type+name from a domain.",
      parameters: DeleteDnsParams,
      async execute(_id: string, params: Static<typeof DeleteDnsParams>) {
        const creds = await loadGoDaddyCreds(api);
        if (!creds) return textResult("GoDaddy not configured.");

        const res = await httpRequest(
          `${creds.baseUrl}/v1/domains/${encodeURIComponent(params.domain)}/records/${encodeURIComponent(params.type)}/${encodeURIComponent(params.name)}`,
          "DELETE",
          gdHeaders(creds.apiKey, creds.apiSecret),
          undefined,
          10000,
        );

        if (res.status === 200 || res.status === 204) {
          return textResult(
            `DNS records deleted from ${params.domain}: **${params.type}** \`${params.name}\``,
          );
        }
        return textResult(`GoDaddy error (${res.status}): ${JSON.stringify(res.data)}`);
      },
    },
  ];
}

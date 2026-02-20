"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Globe,
  Loader2,
  Plug,
  RefreshCw,
  Server,
  TerminalSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface PluginMcpServer {
  name: string;
  type: string;
  url?: string;
  command?: string;
}

interface PluginEntry {
  id: string;
  name: string;
  version: string;
  scope: "official" | "local";
  mcpServers: PluginMcpServer[];
}

interface PluginCatalog {
  plugins: PluginEntry[];
  totalMcpServers: number;
  scannedAt: string;
}

interface McpServerRow {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  pluginScope: "official" | "local";
  serverName: string;
  serverType: string;
  url?: string;
  command?: string;
}

function typeIcon(type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "http" || normalized === "sse") {
    return <Globe className="w-4 h-4 text-sky-400" />;
  }
  return <TerminalSquare className="w-4 h-4 text-violet-400" />;
}

export function MCPServersView() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [query, setQuery] = useState("");

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plugins");
      const data = (await res.json()) as PluginCatalog & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setCatalog(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP servers");
      setCatalog(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  const rows = useMemo<McpServerRow[]>(() => {
    if (!catalog) return [];
    const flattened: McpServerRow[] = [];
    for (const plugin of catalog.plugins) {
      for (const server of plugin.mcpServers || []) {
        flattened.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          pluginScope: plugin.scope,
          serverName: server.name,
          serverType: server.type || "unknown",
          url: server.url,
          command: server.command,
        });
      }
    }
    return flattened;
  }, [catalog]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => {
      const haystack = [
        row.serverName,
        row.serverType,
        row.pluginName,
        row.pluginId,
        row.url || "",
        row.command || "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, query]);

  const stats = useMemo(() => {
    const plugins = new Set(rows.map((row) => row.pluginId));
    const byType = rows.reduce<Record<string, number>>((acc, row) => {
      const key = row.serverType.toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      serverCount: rows.length,
      pluginCount: plugins.size,
      httpCount: byType.http || 0,
      stdioCount: byType.stdio || 0,
      sseCount: byType.sse || 0,
    };
  }, [rows]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">MCP Servers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Registry of all MCP server connections discovered from installed plugins.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-full sm:w-80 relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search MCP servers..."
              className="w-full h-10 px-3 rounded-lg border border-border bg-background/60 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50 transition-all"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              void fetchCatalog();
            }}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Servers</div>
          <div className="text-xl font-semibold mt-1">{stats.serverCount}</div>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Plugins</div>
          <div className="text-xl font-semibold mt-1">{stats.pluginCount}</div>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">HTTP</div>
          <div className="text-xl font-semibold mt-1">{stats.httpCount}</div>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">STDIO</div>
          <div className="text-xl font-semibold mt-1">{stats.stdioCount}</div>
        </div>
        <div className="glass-panel rounded-xl p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">SSE</div>
          <div className="text-xl font-semibold mt-1">{stats.sseCount}</div>
        </div>
      </div>

      {loading ? (
        <div className="glass-panel rounded-xl p-10 text-center text-sm text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Loading MCP servers...
        </div>
      ) : error ? (
        <div className="glass-panel rounded-xl p-6 border border-destructive/30 bg-destructive/5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive mt-0.5" />
            <div>
              <div className="font-medium text-destructive">Unable to load MCP server registry</div>
              <div className="text-sm text-muted-foreground mt-1">{error}</div>
            </div>
          </div>
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="glass-panel rounded-xl p-10 text-center text-sm text-muted-foreground">
          No MCP servers found.
        </div>
      ) : (
        <div className="space-y-2">
          {filteredRows.map((row) => (
            <div
              key={`${row.pluginId}:${row.serverName}:${row.serverType}`}
              className="glass-panel rounded-xl p-4 border border-border/60"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold truncate">{row.serverName}</h3>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {row.serverType}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {row.pluginScope}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    From plugin <span className="font-mono">{row.pluginName}</span>{" "}
                    <span className="font-mono">v{row.pluginVersion}</span>
                  </div>
                </div>
                <div className="shrink-0">{typeIcon(row.serverType)}</div>
              </div>

              <div className="mt-3 grid gap-2 text-xs">
                {row.url && (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2">
                    <Plug className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="font-mono truncate">{row.url}</span>
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-primary hover:underline inline-flex items-center gap-1 shrink-0"
                    >
                      Open <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}
                {row.command && (
                  <div className="rounded-md border border-border bg-background/40 px-2.5 py-2 font-mono truncate">
                    {row.command}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {catalog?.scannedAt && (
        <div className="text-[11px] text-muted-foreground">
          Last scanned: {new Date(catalog.scannedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

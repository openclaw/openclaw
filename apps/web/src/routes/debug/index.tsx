"use client";

import * as React from "react";
import { createFileRoute, Navigate, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/useUIStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bug,
  RefreshCw,
  Play,
  Pause,
  Download,
  Search,
  Activity,
  LayoutGrid,
  Cpu,
  HardDrive,
  Clock,
  Terminal as TerminalIcon,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { useGatewayClient } from "@/providers";
import type { HealthResponse, StatusResponse, ModelsListResponse } from "@/lib/api";

import { RouteErrorFallback } from "@/components/composed";
export const Route = createFileRoute("/debug/")({
  component: DebugPage,
  errorComponent: RouteErrorFallback,
});

// Log levels
const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type LogLevel = (typeof logLevels)[number];

interface EventEntry {
  id: string;
  timestamp: Date | null;
  type: string;
  data: Record<string, unknown>;
}

interface LogEntry {
  id: string;
  raw: string;
  message: string;
  level: LogLevel;
  time?: string;
  subsystem?: string;
  meta?: Record<string, unknown>;
}

interface HeartbeatPayload {
  ts: number;
  status: string;
  to?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
  channel?: string;
  silent?: boolean;
  indicatorType?: string;
}

const LOG_BUFFER_LIMIT = 2000;
const logLevelSet = new Set<LogLevel>(logLevels);

function parseMaybeJsonString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  const lowered = value.toLowerCase() as LogLevel;
  return logLevelSet.has(lowered) ? lowered : null;
}

function parseLogLine(line: string, fallbackId: string): LogEntry {
  if (!line.trim()) {
    return { id: fallbackId, raw: line, message: line, level: "info" };
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const meta =
      obj && typeof obj._meta === "object" && obj._meta !== null
        ? (obj._meta as Record<string, unknown>)
        : null;
    const time =
      typeof obj.time === "string"
        ? obj.time
        : typeof meta?.date === "string"
          ? meta?.date
          : undefined;
    const level = normalizeLevel(meta?.logLevelName ?? meta?.level) ?? "info";

    const contextCandidate =
      typeof obj["0"] === "string" ? obj["0"] : typeof meta?.name === "string" ? meta?.name : null;
    const contextObj = parseMaybeJsonString(contextCandidate);
    let subsystem: string | undefined;
    if (contextObj) {
      if (typeof contextObj.subsystem === "string") {
        subsystem = contextObj.subsystem;
      } else if (typeof contextObj.module === "string") {
        subsystem = contextObj.module;
      }
    }
    if (!subsystem && contextCandidate && contextCandidate.length < 120) {
      subsystem = contextCandidate;
    }

    let message: string | null = null;
    if (typeof obj["1"] === "string") {
      message = obj["1"];
    } else if (!contextObj && typeof obj["0"] === "string") {
      message = obj["0"];
    } else if (typeof obj.message === "string") {
      message = obj.message;
    }

    return {
      id: fallbackId,
      raw: line,
      time,
      level,
      subsystem,
      message: message ?? line,
      meta: meta ?? undefined,
    };
  } catch {
    return { id: fallbackId, raw: line, message: line, level: "info" };
  }
}

function DebugPage() {
  const powerUserMode = useUIStore((s) => s.powerUserMode);

  if (!powerUserMode) {
    return <Navigate to="/" />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <Bug className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">
                Debug Console
              </h1>
              <p className="text-muted-foreground">
                System diagnostics and debugging tools
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="secondary" size="sm" className="gap-2">
              <Link to="/debug/terminal">
                <TerminalIcon className="h-4 w-4" />
                Terminal
              </Link>
            </Button>
            <Button asChild variant="secondary" size="sm" className="gap-2">
              <Link to="/debug/graph">
                <Activity className="h-4 w-4" />
                Graph
              </Link>
            </Button>
            <Button asChild variant="secondary" size="sm" className="gap-2">
              <Link to="/debug/workbench">
                <LayoutGrid className="h-4 w-4" />
                Workbench
              </Link>
            </Button>
          </div>
        </motion.div>

        {/* Tabs */}
        <Tabs defaultValue="health" className="space-y-6">
          <TabsList className="grid w-full grid-cols-4 lg:w-auto lg:inline-grid">
            <TabsTrigger value="health">Health</TabsTrigger>
            <TabsTrigger value="rpc">RPC</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="health">
            <HealthTab />
          </TabsContent>

          <TabsContent value="rpc">
            <RPCTab />
          </TabsContent>

          <TabsContent value="events">
            <EventsTab />
          </TabsContent>

          <TabsContent value="logs">
            <LogsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// Health Tab Component
function HealthTab() {
  const client = useGatewayClient();
  const [services, setServices] = React.useState<
    Array<{
      id: string;
      name: string;
      status: "healthy" | "degraded" | "unhealthy" | "unknown";
      detail?: string;
      lastCheck?: string;
    }>
  >([]);
  const [models, setModels] = React.useState<ModelsListResponse["models"]>([]);
  const [heartbeat, setHeartbeat] = React.useState<HeartbeatPayload | null>(null);
  const [statusData, setStatusData] = React.useState<StatusResponse | null>(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleRefresh = React.useCallback(async () => {
    if (!client) {
      setError("Gateway is not connected.");
      return;
    }
    setIsRefreshing(true);
    setError(null);
    try {
      const [status, health, modelResponse, heartbeatResponse] = await Promise.all([
        client.request<StatusResponse>("status", {}),
        client.request<HealthResponse>("health", {}),
        client.request<ModelsListResponse>("models.list", {}),
        client.request<HeartbeatPayload | null>("last-heartbeat", {}),
      ]);

      setStatusData(status);
      setModels(Array.isArray(modelResponse?.models) ? modelResponse.models : []);
      setHeartbeat(heartbeatResponse);

      const channelStatuses = Object.values(status.channels ?? {});
      const configuredChannels = channelStatuses.filter((channel) => channel.configured).length;
      const connectedChannels = channelStatuses.filter((channel) => channel.connected).length;

      const channelStatus =
        configuredChannels === 0
          ? "degraded"
          : connectedChannels === configuredChannels
            ? "healthy"
            : connectedChannels === 0
              ? "unhealthy"
              : "degraded";

      const authConfigured = status.auth?.configured ?? false;
      const authProviders = status.auth?.providers ?? [];

      setServices([
        {
          id: "gateway",
          name: "Gateway",
          status: health.ok ? "healthy" : "unhealthy",
          detail: health.version
            ? `v${health.version}${health.uptime ? ` • ${Math.round(health.uptime / 60)}m uptime` : ""}`
            : "No version data",
          lastCheck: new Date().toISOString(),
        },
        {
          id: "channels",
          name: "Channels",
          status: channelStatus,
          detail: `${connectedChannels}/${configuredChannels} connected`,
          lastCheck: new Date().toISOString(),
        },
        {
          id: "auth",
          name: "Auth",
          status: authConfigured ? "healthy" : "degraded",
          detail: authProviders.length ? authProviders.join(", ") : "No providers configured",
          lastCheck: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsRefreshing(false);
    }
  }, [client]);

  React.useEffect(() => {
    void handleRefresh();
  }, [handleRefresh]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "healthy":
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "degraded":
        return <AlertCircle className="h-4 w-4 text-warning" />;
      case "unhealthy":
        return <XCircle className="h-4 w-4 text-destructive" />;
      default:
        return null;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "healthy":
        return <Badge variant="success">Healthy</Badge>;
      case "degraded":
        return <Badge variant="warning">Degraded</Badge>;
      case "unhealthy":
        return <Badge variant="error">Unhealthy</Badge>;
      default:
        return <Badge variant="secondary">Unknown</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Refresh Button */}
      <div className="flex justify-between items-center">
        {error ? (
          <Badge variant="error">{error}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">
            {client ? "Live gateway data" : "Gateway disconnected"}
          </span>
        )}
        <Button
          variant="outline"
          onClick={handleRefresh}
          disabled={isRefreshing || !client}
          className="gap-2"
        >
          <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Service Status Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {services.map((service) => (
          <Card key={service.id}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {getStatusIcon(service.status)}
                  <CardTitle className="text-lg">{service.name}</CardTitle>
                </div>
                {getStatusBadge(service.status)}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Detail</span>
                <span className="font-medium text-right">{service.detail ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Check</span>
                <span className="font-medium">
                  {service.lastCheck ? new Date(service.lastCheck).toLocaleTimeString() : "—"}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Models + Heartbeat */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-lg">Models</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium">{models.length}</span>
            </div>
            <div className="text-xs text-muted-foreground line-clamp-2">
              {models.length
                ? models.slice(0, 3).map((model) => model.id).join(", ")
                : "No models returned"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-lg">Heartbeat</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Status</span>
              <span className="font-medium">{heartbeat?.status ?? "No heartbeat"}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {heartbeat?.ts
                ? `Last: ${new Date(heartbeat.ts).toLocaleString()}`
                : "No heartbeat event recorded"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-lg">Gateway Status</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Running</span>
              <span className="font-medium">
                {statusData?.gateway?.running ? "Yes" : "No"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {statusData?.gateway?.version
                ? `Version ${statusData.gateway.version}`
                : "No gateway version available"}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// RPC Tab Component
function RPCTab() {
  const client = useGatewayClient();
  const [selectedMethod, setSelectedMethod] = React.useState("status");
  const [params, setParams] = React.useState("{}");
  const [response, setResponse] = React.useState<string | null>(null);
  const [timing, setTiming] = React.useState<number | null>(null);
  const [isExecuting, setIsExecuting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleExecute = async () => {
    if (!client) {
      setError("Gateway is not connected.");
      return;
    }
    setIsExecuting(true);
    setError(null);
    const startTime = performance.now();

    try {
      const parsedParams = params.trim() ? (JSON.parse(params) as unknown) : {};
      const result = await client.request(selectedMethod.trim(), parsedParams);

      const endTime = performance.now();
      setTiming(Math.round(endTime - startTime));
      setResponse(JSON.stringify(result, null, 2));
    } catch (err) {
      setError(String(err));
      setResponse(null);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Request Panel */}
      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
          <CardDescription>Configure and execute RPC methods</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Method</Label>
            <Input
              value={selectedMethod}
              onChange={(e) => setSelectedMethod(e.target.value)}
              placeholder="status"
              className="font-mono"
            />
          </div>

          <div className="space-y-2">
            <Label>Parameters (JSON)</Label>
            <Textarea
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder='{"key": "value"}'
              className="font-mono text-sm min-h-[200px]"
            />
          </div>

          <Button
            onClick={handleExecute}
            disabled={isExecuting || !client}
            className="w-full gap-2"
          >
            {isExecuting ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Executing...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Execute
              </>
            )}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {/* Response Panel */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Response</CardTitle>
              <CardDescription>Method execution result</CardDescription>
            </div>
            {timing !== null && (
              <Badge variant="secondary" className="gap-1">
                <Clock className="h-3 w-3" />
                {timing}ms
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[300px] rounded-lg border bg-muted/30 p-4">
            {response ? (
              <pre className="text-sm font-mono whitespace-pre-wrap">
                {response}
              </pre>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Execute a method to see the response
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// Events Tab Component
function EventsTab() {
  const client = useGatewayClient();
  const [events, setEvents] = React.useState<EventEntry[]>([]);
  const [isPaused, setIsPaused] = React.useState(false);
  const [selectedType, setSelectedType] = React.useState("all");

  const isPausedRef = React.useRef(isPaused);
  React.useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  React.useEffect(() => {
    if (!client) {
      return;
    }

    const unsubscribe = client.subscribe("*", (event) => {
      if (isPausedRef.current) {
        return;
      }
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : { value: event.payload };
      const timestamp =
        typeof (payload as { ts?: number }).ts === "number"
          ? new Date((payload as { ts?: number }).ts as number)
          : new Date();
      const entry: EventEntry = {
        id: `${event.seq ?? "event"}-${Date.now()}`,
        timestamp: Number.isNaN(timestamp.getTime()) ? null : timestamp,
        type: event.event,
        data: payload,
      };
      setEvents((prev) => [entry, ...prev].slice(0, 250));
    });

    return unsubscribe;
  }, [client]);

  const eventTypes = React.useMemo(() => {
    const unique = new Set(events.map((event) => event.type));
    return Array.from(unique).sort();
  }, [events]);

  const filteredEvents =
    selectedType === "all" ? events : events.filter((event) => event.type === selectedType);

  const getEventTypeColor = (type: string) => {
    if (type.includes("error")) {return "destructive";}
    if (type.includes("completed")) {return "success";}
    if (type.includes("started")) {return "default";}
    return "secondary";
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-4">
              <Button
                variant={isPaused ? "default" : "outline"}
                onClick={() => setIsPaused(!isPaused)}
                className="gap-2"
              >
                {isPaused ? (
                  <>
                    <Play className="h-4 w-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-4 w-4" />
                    Pause
                  </>
                )}
              </Button>
              <span className="text-sm text-muted-foreground">
                {filteredEvents.length} events
              </span>
            </div>

            <Select
              value={selectedType}
              onValueChange={setSelectedType}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Filter events" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Events</SelectItem>
                {eventTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Event Stream */}
      <Card>
        <CardHeader>
          <CardTitle>Event Stream</CardTitle>
          <CardDescription>Real-time system events</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            <div className="space-y-2">
              {filteredEvents.length === 0 ? (
                <div className="flex items-center justify-center h-[200px] text-muted-foreground">
                  Waiting for events...
                </div>
              ) : (
                filteredEvents.map((event) => (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex flex-col gap-1 flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={getEventTypeColor(event.type) as "default" | "secondary" | "destructive"}>
                          {event.type}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {event.timestamp ? event.timestamp.toLocaleTimeString() : "—"}
                        </span>
                      </div>
                      <pre className="text-xs font-mono text-muted-foreground truncate">
                        {JSON.stringify(event.data)}
                      </pre>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// Logs Tab Component
function LogsTab() {
  const client = useGatewayClient();
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [selectedLevel, setSelectedLevel] = React.useState<LogLevel | "all">("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [tailMode, setTailMode] = React.useState(true);
  const [logsError, setLogsError] = React.useState<string | null>(null);
  const [logsLoading, setLogsLoading] = React.useState(false);
  const [logsCursor, setLogsCursor] = React.useState<number | null>(null);
  const [logsFile, setLogsFile] = React.useState<string | null>(null);
  const [logsTruncated, setLogsTruncated] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const loadLogs = React.useCallback(
    async (opts?: { reset?: boolean; quiet?: boolean }) => {
      if (!client) {
        setLogsError("Gateway is not connected.");
        return;
      }
      if (logsLoading && !opts?.quiet) {
        return;
      }
      if (!opts?.quiet) {
        setLogsLoading(true);
      }
      setLogsError(null);
      try {
        const response = await client.request<{
          file?: string;
          cursor?: number;
          size?: number;
          lines?: unknown;
          truncated?: boolean;
          reset?: boolean;
        }>("logs.tail", {
          cursor: opts?.reset ? undefined : logsCursor ?? undefined,
          limit: 200,
          maxBytes: 250000,
        });
        const lines = Array.isArray(response.lines)
          ? response.lines.filter((line) => typeof line === "string")
          : [];
        const entries = lines.map((line, index) =>
          parseLogLine(line, `log-${response.cursor ?? logsCursor ?? Date.now()}-${index}`)
        );
        const shouldReset = Boolean(opts?.reset || response.reset || logsCursor == null);
        setLogs((prev) =>
          (shouldReset ? entries : [...prev, ...entries]).slice(-LOG_BUFFER_LIMIT)
        );
        if (typeof response.cursor === "number") {
          setLogsCursor(response.cursor);
        }
        if (typeof response.file === "string") {
          setLogsFile(response.file);
        }
        setLogsTruncated(Boolean(response.truncated));
      } catch (err) {
        setLogsError(String(err));
      } finally {
        if (!opts?.quiet) {
          setLogsLoading(false);
        }
      }
    },
    [client, logsCursor, logsLoading]
  );

  React.useEffect(() => {
    void loadLogs({ reset: true });
  }, [loadLogs]);

  React.useEffect(() => {
    if (!tailMode) {
      return;
    }
    const interval = setInterval(() => {
      void loadLogs({ quiet: true });
    }, 2000);
    return () => clearInterval(interval);
  }, [loadLogs, tailMode]);

  // Auto-scroll in tail mode
  React.useEffect(() => {
    if (tailMode && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, tailMode]);

  const filteredLogs = logs.filter((log) => {
    if (selectedLevel !== "all" && log.level !== selectedLevel) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const messageMatch = log.message.toLowerCase().includes(query);
      const subsystemMatch = log.subsystem?.toLowerCase().includes(query);
      if (!messageMatch && !subsystemMatch) {
        return false;
      }
    }
    return true;
  });

  const handleExport = () => {
    const content = filteredLogs
      .map((log) => {
        const time = log.time ?? new Date().toISOString();
        const subsystem = log.subsystem ?? "unknown";
        return `[${time}] [${log.level.toUpperCase()}] [${subsystem}] ${log.message}`;
      })
      .join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getLevelColor = (level: LogLevel) => {
    switch (level) {
      case "trace":
        return "text-muted-foreground";
      case "debug":
        return "text-blue-500";
      case "info":
        return "text-green-500";
      case "warn":
        return "text-yellow-500";
      case "error":
        return "text-red-500";
      case "fatal":
        return "text-red-700 font-bold";
      default:
        return "text-foreground";
    }
  };

  const getLevelBadge = (level: LogLevel) => {
    switch (level) {
      case "trace":
      case "debug":
        return "secondary";
      case "info":
        return "success";
      case "warn":
        return "warning";
      case "error":
      case "fatal":
        return "error";
      default:
        return "secondary";
    }
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search logs..."
                className="pl-10"
              />
            </div>

            <Select
              value={selectedLevel}
              onValueChange={(v) => setSelectedLevel(v as LogLevel | "all")}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Log level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                {logLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Switch
                id="tail-mode"
                checked={tailMode}
                onCheckedChange={setTailMode}
              />
              <Label htmlFor="tail-mode" className="text-sm">
                Tail Mode
              </Label>
            </div>

            <Button
              variant="outline"
              onClick={handleExport}
              className="gap-2"
              disabled={!filteredLogs.length}
            >
              <Download className="h-4 w-4" />
              Export
            </Button>

            <Button
              variant="outline"
              onClick={() => loadLogs({ reset: true })}
              className="gap-2"
              disabled={logsLoading || !client}
            >
              <RefreshCw className={cn("h-4 w-4", logsLoading && "animate-spin")} />
              Refresh
            </Button>
          </div>
          {logsError ? (
            <p className="mt-3 text-sm text-destructive">{logsError}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Log Entries */}
      <Card>
        <CardHeader>
          <CardTitle>Log Entries</CardTitle>
          <CardDescription>
            Showing {filteredLogs.length} of {logs.length} entries
            {logsFile ? ` • ${logsFile}` : ""}
            {logsTruncated ? " • truncated" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]" ref={scrollRef}>
            <div className="selectable-text space-y-1 font-mono text-sm">
              {filteredLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-2 p-2 rounded hover:bg-muted/50 transition-colors"
                >
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {log.time ? new Date(log.time).toLocaleTimeString() : "—"}
                  </span>
                  <Badge
                    variant={getLevelBadge(log.level) as "secondary" | "success" | "warning" | "error"}
                    className="text-xs uppercase"
                  >
                    {log.level}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    [{log.subsystem ?? "unknown"}]
                  </span>
                  <span className={cn("flex-1", getLevelColor(log.level))}>
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

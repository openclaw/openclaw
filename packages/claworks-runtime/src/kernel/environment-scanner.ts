/**
 * environment-scanner.ts — ClaWorks 环境感知引擎
 *
 * 感知维度（L1 增强）：
 *   - 环境变量扫描（IM Token、API Key、数据库 URL）
 *   - 文件系统扫描（配置文件、行为规范文档、项目文件）
 *   - 网络服务探测（常见服务端口）
 *   - OpenClaw 安装检测
 *
 * 事件发布：
 *   environment.new_resource_detected — 发现新资源
 *   environment.scan_completed       — 扫描完成摘要
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type DiscoveredResourceType =
  | "file_system"
  | "network_service"
  | "iot_device"
  | "im_channel"
  | "ai_agent"
  | "database"
  | "api_endpoint"
  | "config_file"
  | "behavior_doc";

export type DiscoveredResource = {
  id: string;
  type: DiscoveredResourceType;
  name: string;
  location: string;
  status: "available" | "unreachable" | "requires_auth";
  autoConnectable: boolean;
  suggestedConnector?: string;
  metadata?: Record<string, unknown>;
  discoveredAt: Date;
};

export type EnvVarHint = {
  key: string;
  type:
    | "im_token"
    | "api_key"
    | "database_url"
    | "openclaw_config"
    | "claworks_config"
    | "other_credential";
  hint: string;
  suggestedService?: string;
};

export type ScanScope = {
  /** 传 false 禁用文件系统扫描，传对象则启用并指定扫描参数 */
  fileSystem?: false | { paths?: string[]; maxDepth?: number; patterns?: string[] };
  network?: { ports?: number[]; hosts?: string[]; timeoutMs?: number };
  environment?: boolean;
  processes?: boolean;
  knownServices?: boolean;
};

export type NetworkProbeResult = {
  reachable: boolean;
  host: string;
  port: number;
  banner?: string;
  latencyMs?: number;
};

export type OpenClawDetectionResult = {
  found: boolean;
  configPath?: string;
  version?: string;
  agentCount?: number;
};

export type ScanResult = {
  resources: DiscoveredResource[];
  envVars: EnvVarHint[];
  openClaw: OpenClawDetectionResult;
  scannedAt: Date;
  durationMs: number;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/** OrioSearch / Tavily-compatible base URL (CLAWORKS_ORIOSEARCH_URL → ORIOSEARCH_URL). */
export function resolveOriosearchBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAWORKS_ORIOSEARCH_URL?.trim() || env.ORIOSEARCH_URL?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\/$/, "");
}

export type EnvironmentScanner = {
  scan(scope?: ScanScope): Promise<ScanResult>;
  scanEnvVars(): Promise<EnvVarHint[]>;
  scanFileSystem(
    paths: string[],
    opts?: { patterns?: string[]; maxDepth?: number },
  ): Promise<DiscoveredResource[]>;
  probeNetworkService(host: string, port: number, timeoutMs?: number): Promise<NetworkProbeResult>;
  detectOpenClaw(): Promise<OpenClawDetectionResult>;
  /** 搜索互联网（按优先级：SearXNG → Brave Search → Serper）。无可用搜索服务时返回空数组。 */
  webSearch(query: string, limit?: number): Promise<WebSearchResult[]>;
};

// ── 环境变量模式识别 ──────────────────────────────────────────────────────

const ENV_PATTERNS: Array<{
  pattern: RegExp;
  type: EnvVarHint["type"];
  hint: string;
  suggestedService?: string;
}> = [
  {
    pattern: /^FEISHU_(APP_ID|APP_SECRET|TOKEN|WEBHOOK)$/,
    type: "im_token",
    hint: "飞书 IM 凭证，可自动对接飞书渠道",
    suggestedService: "feishu",
  },
  {
    pattern: /^LARK_(APP_ID|APP_SECRET|TOKEN)$/,
    type: "im_token",
    hint: "Lark IM 凭证（飞书国际版），可自动对接",
    suggestedService: "feishu",
  },
  {
    pattern: /^WEIXIN_WORK_(CORPID|CORP_SECRET|TOKEN|AGENT_ID)$/,
    type: "im_token",
    hint: "企业微信凭证，可自动对接企微渠道",
    suggestedService: "weixin_work",
  },
  {
    pattern: /^DINGTALK_(APP_KEY|APP_SECRET|TOKEN|ROBOT_TOKEN)$/,
    type: "im_token",
    hint: "钉钉凭证，可自动对接钉钉渠道",
    suggestedService: "dingtalk",
  },
  {
    pattern: /^TELEGRAM_(BOT_TOKEN|TOKEN)$/,
    type: "im_token",
    hint: "Telegram Bot Token，可自动对接 Telegram",
    suggestedService: "telegram",
  },
  {
    pattern: /^OPENAI_API_KEY$/,
    type: "api_key",
    hint: "OpenAI API Key，可用于 LLM 推理",
    suggestedService: "openai",
  },
  {
    pattern: /^ANTHROPIC_API_KEY$/,
    type: "api_key",
    hint: "Anthropic API Key，可用于 Claude 推理",
    suggestedService: "anthropic",
  },
  {
    pattern: /^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|PG_URL)$/,
    type: "database_url",
    hint: "PostgreSQL 数据库 URL",
    suggestedService: "postgresql",
  },
  {
    pattern: /^MYSQL_URL$/,
    type: "database_url",
    hint: "MySQL 数据库 URL",
    suggestedService: "mysql",
  },
  {
    pattern: /^(REDIS_URL|REDIS_URI)$/,
    type: "database_url",
    hint: "Redis URL",
    suggestedService: "redis",
  },
  {
    pattern: /^MONGODB_(URL|URI)$/,
    type: "database_url",
    hint: "MongoDB URL",
    suggestedService: "mongodb",
  },
  {
    pattern: /^OPENCLAW_/,
    type: "openclaw_config",
    hint: "OpenClaw 配置变量，可自动同步",
    suggestedService: "openclaw",
  },
  {
    pattern: /^CLAWORKS_/,
    type: "claworks_config",
    hint: "ClaWorks 配置变量",
    suggestedService: "claworks",
  },
  {
    pattern: /(_TOKEN|_API_KEY|_SECRET|_PASSWORD|_CREDENTIAL)$/,
    type: "other_credential",
    hint: "可能是 API 凭证或密钥",
  },
];

// ── 文件类型识别 ──────────────────────────────────────────────────────────

const FILE_PATTERNS: Array<{
  pattern: RegExp;
  type: DiscoveredResourceType;
  name: string;
  autoConnectable: boolean;
  suggestedConnector?: string;
}> = [
  {
    pattern: /^ROBOT\.md$/i,
    type: "behavior_doc",
    name: "机器人行为规范",
    autoConnectable: true,
    suggestedConnector: "kb_ingest",
  },
  {
    pattern: /^AGENTS\.md$/i,
    type: "behavior_doc",
    name: "Agent 行为规范",
    autoConnectable: true,
    suggestedConnector: "kb_ingest",
  },
  {
    pattern: /^CLAUDE\.md$/i,
    type: "behavior_doc",
    name: "Claude 行为规范",
    autoConnectable: true,
    suggestedConnector: "kb_ingest",
  },
  {
    pattern: /^claworks\.robot\.json$/i,
    type: "config_file",
    name: "ClaWorks 机器人配置",
    autoConnectable: true,
    suggestedConnector: "robot_config_loader",
  },
  {
    pattern: /^openclaw\.json$/i,
    type: "config_file",
    name: "OpenClaw 配置",
    autoConnectable: true,
    suggestedConnector: "harness_sync",
  },
  {
    pattern: /\.openclaw\.fragment\.json$/i,
    type: "config_file",
    name: "OpenClaw 配置片段",
    autoConnectable: false,
  },
  {
    pattern: /^\.env$/,
    type: "config_file",
    name: "环境变量文件",
    autoConnectable: false,
  },
  {
    pattern: /\.ya?ml$/i,
    type: "config_file",
    name: "YAML 配置文件",
    autoConnectable: false,
  },
  {
    pattern: /^requirements\.txt$/i,
    type: "config_file",
    name: "Python 依赖清单",
    autoConnectable: false,
  },
  {
    pattern: /^package\.json$/i,
    type: "config_file",
    name: "Node.js 项目配置",
    autoConnectable: false,
  },
];

// ── 常见服务端口 ──────────────────────────────────────────────────────────

const KNOWN_SERVICES: Array<{
  port: number;
  name: string;
  type: DiscoveredResourceType;
  suggestedConnector?: string;
}> = [
  { port: 5432, name: "PostgreSQL", type: "database", suggestedConnector: "postgresql" },
  { port: 3306, name: "MySQL", type: "database", suggestedConnector: "mysql" },
  { port: 6379, name: "Redis", type: "database", suggestedConnector: "redis" },
  { port: 27017, name: "MongoDB", type: "database", suggestedConnector: "mongodb" },
  { port: 1883, name: "MQTT Broker", type: "iot_device", suggestedConnector: "mqtt" },
  { port: 8883, name: "MQTT Broker (TLS)", type: "iot_device", suggestedConnector: "mqtt" },
  { port: 4840, name: "OPC-UA Server", type: "iot_device", suggestedConnector: "opcua" },
  { port: 502, name: "Modbus TCP", type: "iot_device", suggestedConnector: "modbus" },
  { port: 11434, name: "Ollama LLM", type: "ai_agent", suggestedConnector: "openai_compatible" },
  { port: 8000, name: "ClaWorks/OpenClaw Gateway", type: "ai_agent" },
  { port: 18800, name: "ClaWorks Gateway (product)", type: "ai_agent" },
];

// ── 网络探测 ──────────────────────────────────────────────────────────────

function probePort(host: string, port: number, timeoutMs: number): Promise<NetworkProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reachable: false, host, port });
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ reachable: true, host, port, latencyMs });
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ reachable: false, host, port });
    });
  });
}

// ── OpenClaw 检测 ─────────────────────────────────────────────────────────

function detectOpenClawSync(): OpenClawDetectionResult {
  const candidates = [join(homedir(), ".openclaw"), join(homedir(), ".config", "openclaw")];

  for (const base of candidates) {
    if (!existsSync(base)) {
      continue;
    }

    const agentsDir = join(base, "agents");
    let agentCount = 0;

    if (existsSync(agentsDir)) {
      try {
        agentCount = readdirSync(agentsDir).filter((entry) => {
          const p = join(agentsDir, entry);
          return statSync(p).isDirectory();
        }).length;
      } catch {
        // ignore
      }
    }

    // 尝试找版本信息
    let version: string | undefined;
    const versionCandidates = [join(base, "version"), join(base, ".version")];
    for (const vp of versionCandidates) {
      if (existsSync(vp)) {
        try {
          version = readFileSync(vp, "utf8").trim();
        } catch {
          // ignore
        }
        break;
      }
    }

    return { found: true, configPath: base, version, agentCount };
  }

  // 环境变量检测
  const envAgentId = process.env.OPENCLAW_AGENT_ID;
  const envConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  if (envAgentId || envConfigPath) {
    return {
      found: true,
      configPath: envConfigPath ?? join(homedir(), ".openclaw"),
      version: process.env.OPENCLAW_VERSION,
    };
  }

  return { found: false };
}

// ── 文件系统扫描 ──────────────────────────────────────────────────────────

function scanDir(
  dirPath: string,
  patterns: RegExp[],
  maxDepth: number,
  currentDepth: number,
  results: DiscoveredResource[],
): void {
  if (currentDepth > maxDepth) {
    return;
  }
  if (!existsSync(dirPath)) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") && currentDepth > 0) {
      continue;
    }
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__") {
      continue;
    }

    const fullPath = join(dirPath, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      scanDir(fullPath, patterns, maxDepth, currentDepth + 1, results);
    } else if (stat.isFile()) {
      for (const fp of FILE_PATTERNS) {
        if (fp.pattern.test(entry)) {
          const id = `fs:${fullPath}`;
          if (!results.some((r) => r.id === id)) {
            results.push({
              id,
              type: fp.type,
              name: fp.name,
              location: fullPath,
              status: "available",
              autoConnectable: fp.autoConnectable,
              suggestedConnector: fp.suggestedConnector,
              metadata: { size: stat.size, mtime: stat.mtime.toISOString() },
              discoveredAt: new Date(),
            });
          }
          break;
        }
      }

      // 自定义 patterns
      for (const pat of patterns) {
        if (pat.test(entry)) {
          const id = `fs:${fullPath}`;
          if (!results.some((r) => r.id === id)) {
            results.push({
              id,
              type: "file_system",
              name: entry,
              location: fullPath,
              status: "available",
              autoConnectable: false,
              metadata: { size: stat.size, mtime: stat.mtime.toISOString() },
              discoveredAt: new Date(),
            });
          }
        }
      }
    }
  }
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createEnvironmentScanner(): EnvironmentScanner {
  return {
    async scanEnvVars(): Promise<EnvVarHint[]> {
      const hints: EnvVarHint[] = [];
      const seen = new Set<string>();

      for (const [key, value] of Object.entries(process.env)) {
        if (!value || seen.has(key)) {
          continue;
        }

        for (const pattern of ENV_PATTERNS) {
          if (pattern.pattern.test(key)) {
            hints.push({
              key,
              type: pattern.type,
              hint: pattern.hint,
              suggestedService: pattern.suggestedService,
            });
            seen.add(key);
            break;
          }
        }
      }

      return hints;
    },

    async scanFileSystem(
      paths: string[],
      opts?: { patterns?: string[]; maxDepth?: number },
    ): Promise<DiscoveredResource[]> {
      const results: DiscoveredResource[] = [];
      const maxDepth = opts?.maxDepth ?? 3;
      const customPatterns = (opts?.patterns ?? []).map((p) => new RegExp(p, "i"));

      for (const p of paths) {
        scanDir(p, customPatterns, maxDepth, 0, results);
      }

      return results;
    },

    async probeNetworkService(
      host: string,
      port: number,
      timeoutMs = 2000,
    ): Promise<NetworkProbeResult> {
      return probePort(host, port, timeoutMs);
    },

    async detectOpenClaw(): Promise<OpenClawDetectionResult> {
      return detectOpenClawSync();
    },

    async webSearch(query: string, limit = 5): Promise<WebSearchResult[]> {
      const oriosearch = resolveOriosearchBaseUrl();
      if (oriosearch) {
        try {
          const resp = await fetch(`${oriosearch}/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, max_results: limit }),
          });
          if (resp.ok) {
            const data = (await resp.json()) as {
              results?: Array<{ title?: string; url?: string; content?: string }>;
            };
            return (data.results ?? []).slice(0, limit).map((r) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
            }));
          }
        } catch {
          // fall through to other providers
        }
      }

      const searxng = process.env.SEARXNG_URL;
      const brave = process.env.BRAVE_SEARCH_API_KEY;
      const serper = process.env.SERPER_API_KEY;

      if (searxng) {
        try {
          const url = `${searxng}/search?q=${encodeURIComponent(query)}&format=json&results=${limit}`;
          const resp = (await fetch(url).then((r) => r.json())) as {
            results?: Array<{ title?: string; url?: string; content?: string }>;
          };
          return ((resp.results ?? []) as Array<{ title?: string; url?: string; content?: string }>)
            .slice(0, limit)
            .map((r) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.content ?? "",
            }));
        } catch {
          // fall through to next provider
        }
      }

      if (brave) {
        try {
          const resp = (await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
            { headers: { Accept: "application/json", "X-Subscription-Token": brave } },
          ).then((r) => r.json())) as {
            web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
          };
          return (
            (resp.web?.results ?? []) as Array<{
              title?: string;
              url?: string;
              description?: string;
            }>
          )
            .slice(0, limit)
            .map((r) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: r.description ?? "",
            }));
        } catch {
          // fall through
        }
      }

      if (serper) {
        try {
          const resp = (await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": serper, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: limit }),
          }).then((r) => r.json())) as {
            organic?: Array<{ title?: string; link?: string; snippet?: string }>;
          };
          return (
            (resp.organic ?? []) as Array<{ title?: string; link?: string; snippet?: string }>
          )
            .slice(0, limit)
            .map((r) => ({
              title: r.title ?? "",
              url: r.link ?? "",
              snippet: r.snippet ?? "",
            }));
        } catch {
          // fall through
        }
      }

      return [];
    },

    async scan(scope?: ScanScope): Promise<ScanResult> {
      const start = Date.now();
      const resources: DiscoveredResource[] = [];
      let envVars: EnvVarHint[] = [];

      // 环境变量扫描
      if (scope?.environment !== false) {
        envVars = await this.scanEnvVars();
      }

      // 文件系统扫描
      if (scope?.fileSystem !== false) {
        const paths = scope?.fileSystem?.paths ?? [process.cwd(), homedir()];
        const maxDepth = scope?.fileSystem?.maxDepth ?? 2;
        const patterns = scope?.fileSystem?.patterns;
        const fsResults = await this.scanFileSystem(paths, { maxDepth, patterns });
        resources.push(...fsResults);
      }

      // 常见服务探测
      if (scope?.knownServices !== false) {
        const host = "127.0.0.1";
        const timeoutMs = scope?.network?.timeoutMs ?? 1500;
        const probes = KNOWN_SERVICES.map(async (svc) => {
          const result = await probePort(host, svc.port, timeoutMs);
          if (result.reachable) {
            resources.push({
              id: `net:${host}:${svc.port}`,
              type: svc.type,
              name: svc.name,
              location: `${host}:${svc.port}`,
              status: "available",
              autoConnectable: !!svc.suggestedConnector,
              suggestedConnector: svc.suggestedConnector,
              metadata: { host, port: svc.port, latency_ms: result.latencyMs },
              discoveredAt: new Date(),
            });
          }
        });
        await Promise.all(probes);
      }

      // 自定义网络端口探测
      if (scope?.network?.ports && scope.network.hosts) {
        const timeoutMs = scope.network.timeoutMs ?? 1500;
        const probes = scope.network.hosts.flatMap((host) =>
          (scope.network?.ports ?? []).map(async (port) => {
            const result = await probePort(host, port, timeoutMs);
            if (result.reachable) {
              resources.push({
                id: `net:${host}:${port}`,
                type: "network_service",
                name: `${host}:${port}`,
                location: `${host}:${port}`,
                status: "available",
                autoConnectable: false,
                metadata: { host, port, latency_ms: result.latencyMs },
                discoveredAt: new Date(),
              });
            }
          }),
        );
        await Promise.all(probes);
      }

      const openClaw = await this.detectOpenClaw();

      return {
        resources,
        envVars,
        openClaw,
        scannedAt: new Date(),
        durationMs: Date.now() - start,
      };
    },
  };
}

/** 从扫描结果中提取服务摘要文本（用于通知） */
export function summarizeScanResult(result: ScanResult): string {
  const lines: string[] = [];

  if (result.envVars.length > 0) {
    const byType = new Map<string, string[]>();
    for (const ev of result.envVars) {
      const arr = byType.get(ev.type) ?? [];
      arr.push(ev.key);
      byType.set(ev.type, arr);
    }
    lines.push(`📡 环境变量资源 (${result.envVars.length} 个)：`);
    for (const [type, keys] of byType) {
      lines.push(`  - ${type}: ${keys.join(", ")}`);
    }
  }

  const networkResources = result.resources.filter((r) => r.id.startsWith("net:"));
  if (networkResources.length > 0) {
    lines.push(`🌐 网络服务 (${networkResources.length} 个)：`);
    for (const r of networkResources) {
      lines.push(`  - ${r.name} @ ${r.location}`);
    }
  }

  const fileResources = result.resources.filter((r) => r.id.startsWith("fs:"));
  if (fileResources.length > 0) {
    lines.push(`📁 文件资源 (${fileResources.length} 个)：`);
    for (const r of fileResources) {
      lines.push(`  - ${r.name}: ${r.location}`);
    }
  }

  if (result.openClaw.found) {
    lines.push(
      `🤖 OpenClaw：已发现${result.openClaw.version ? ` v${result.openClaw.version}` : ""}`,
    );
  }

  return lines.join("\n") || "未发现可用资源";
}

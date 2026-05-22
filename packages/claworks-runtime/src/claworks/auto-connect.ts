/**
 * auto-connect.ts — ClaWorks 自动对接检测
 *
 * 通过扫描环境变量和网络服务，自动发现可以配置的连接器，
 * 并生成对接建议，待用户确认后应用。
 *
 * 维度覆盖：感知（Perception）+ 主动（Proactivity）
 */

import { createConnection } from "node:net";
import type { ClaworksRuntime } from "./runtime-types.js";

// ── 类型 ──────────────────────────────────────────────────────────────────

export type AutoConnectConfig = {
  im?: {
    feishu?: boolean;
    weixin_work?: boolean;
    dingtalk?: boolean;
    telegram?: boolean;
  };
  storage?: {
    local?: boolean;
  };
  ai?: {
    openai?: boolean;
    anthropic?: boolean;
    ollama?: boolean;
    openai_compatible?: boolean;
  };
  iot?: {
    mqtt?: boolean;
    opcua?: boolean;
    modbus?: boolean;
  };
  database?: {
    postgresql?: boolean;
    mysql?: boolean;
    redis?: boolean;
  };
};

export type DetectedService = {
  service: string;
  available: boolean;
  category: "im" | "ai" | "database" | "iot" | "storage" | "other";
  config?: Record<string, unknown>;
  missingVars?: string[];
  recommendation?: string;
};

export type ApplyResult = {
  service: string;
  status: "connected" | "failed" | "skipped";
  error?: string;
};

export type AutoConnectManager = {
  detect(): Promise<DetectedService[]>;
  applyConnections(services: string[]): Promise<ApplyResult[]>;
  generateRecommendations(): Promise<string[]>;
};

// ── 服务检测规则 ──────────────────────────────────────────────────────────

type ServiceRule = {
  service: string;
  category: DetectedService["category"];
  check: () => Promise<{
    available: boolean;
    config?: Record<string, unknown>;
    missingVars?: string[];
  }>;
  recommendation?: string;
};

function hasEnv(...keys: string[]): boolean {
  return keys.every((k) => !!process.env[k]);
}

function getEnv(key: string): string | undefined {
  return process.env[key];
}

function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const t = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(t);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

const SERVICE_RULES: ServiceRule[] = [
  // ── IM 渠道 ──────────────────────────────────────────────────────────
  {
    service: "feishu",
    category: "im",
    recommendation: "设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 以启用飞书渠道",
    check: async () => {
      if (hasEnv("FEISHU_APP_ID", "FEISHU_APP_SECRET")) {
        return {
          available: true,
          config: {
            app_id: getEnv("FEISHU_APP_ID"),
            app_secret: "***",
            webhook: getEnv("FEISHU_WEBHOOK_URL"),
          },
        };
      }
      return { available: false, missingVars: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] };
    },
  },
  {
    service: "weixin_work",
    category: "im",
    recommendation: "设置 WEIXIN_WORK_CORPID 和 WEIXIN_WORK_CORP_SECRET 以启用企业微信渠道",
    check: async () => {
      if (hasEnv("WEIXIN_WORK_CORPID", "WEIXIN_WORK_CORP_SECRET")) {
        return {
          available: true,
          config: {
            corpid: getEnv("WEIXIN_WORK_CORPID"),
            agent_id: getEnv("WEIXIN_WORK_AGENT_ID"),
          },
        };
      }
      return { available: false, missingVars: ["WEIXIN_WORK_CORPID", "WEIXIN_WORK_CORP_SECRET"] };
    },
  },
  {
    service: "dingtalk",
    category: "im",
    recommendation: "设置 DINGTALK_APP_KEY 和 DINGTALK_APP_SECRET 以启用钉钉渠道",
    check: async () => {
      if (hasEnv("DINGTALK_APP_KEY", "DINGTALK_APP_SECRET")) {
        return {
          available: true,
          config: { app_key: getEnv("DINGTALK_APP_KEY") },
        };
      }
      if (getEnv("DINGTALK_ROBOT_TOKEN")) {
        return {
          available: true,
          config: { robot_token: "***", mode: "webhook" },
        };
      }
      return { available: false, missingVars: ["DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"] };
    },
  },
  {
    service: "telegram",
    category: "im",
    recommendation: "设置 TELEGRAM_BOT_TOKEN 以启用 Telegram 渠道",
    check: async () => {
      if (hasEnv("TELEGRAM_BOT_TOKEN")) {
        return { available: true, config: { token_set: true } };
      }
      return { available: false, missingVars: ["TELEGRAM_BOT_TOKEN"] };
    },
  },

  // ── AI 服务 ──────────────────────────────────────────────────────────
  {
    service: "openai",
    category: "ai",
    recommendation: "设置 OPENAI_API_KEY 以启用 OpenAI LLM",
    check: async () => {
      if (hasEnv("OPENAI_API_KEY")) {
        return {
          available: true,
          config: {
            base_url: getEnv("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
            model: getEnv("OPENAI_MODEL") ?? "gpt-4o",
          },
        };
      }
      return { available: false, missingVars: ["OPENAI_API_KEY"] };
    },
  },
  {
    service: "anthropic",
    category: "ai",
    recommendation: "设置 ANTHROPIC_API_KEY 以启用 Claude LLM",
    check: async () => {
      if (hasEnv("ANTHROPIC_API_KEY")) {
        return { available: true, config: { provider: "anthropic" } };
      }
      return { available: false, missingVars: ["ANTHROPIC_API_KEY"] };
    },
  },
  {
    service: "ollama",
    category: "ai",
    recommendation: "启动 Ollama 服务（localhost:11434）以使用本地 LLM",
    check: async () => {
      const reachable = await probePort("127.0.0.1", 11434);
      return {
        available: reachable,
        config: reachable ? { endpoint: "http://localhost:11434/v1" } : undefined,
      };
    },
  },
  {
    service: "openai_compatible",
    category: "ai",
    recommendation: "设置 OPENAI_BASE_URL 以使用 OpenAI 兼容接口（本地/云端）",
    check: async () => {
      const baseUrl = getEnv("OPENAI_BASE_URL");
      if (baseUrl && baseUrl !== "https://api.openai.com/v1") {
        return {
          available: true,
          config: { base_url: baseUrl, api_key_set: hasEnv("OPENAI_API_KEY") },
        };
      }
      return { available: false };
    },
  },

  // ── 数据库 ────────────────────────────────────────────────────────────
  {
    service: "postgresql",
    category: "database",
    recommendation: "设置 DATABASE_URL 或启动 PostgreSQL 服务（port 5432）",
    check: async () => {
      if (hasEnv("DATABASE_URL") || hasEnv("POSTGRES_URL")) {
        return { available: true, config: { url_set: true } };
      }
      const reachable = await probePort("127.0.0.1", 5432, 1000);
      return {
        available: reachable,
        config: reachable ? { host: "localhost", port: 5432 } : undefined,
      };
    },
  },
  {
    service: "redis",
    category: "database",
    recommendation: "设置 REDIS_URL 或启动 Redis 服务（port 6379）",
    check: async () => {
      if (hasEnv("REDIS_URL")) {
        return { available: true, config: { url_set: true } };
      }
      const reachable = await probePort("127.0.0.1", 6379, 1000);
      return {
        available: reachable,
        config: reachable ? { host: "localhost", port: 6379 } : undefined,
      };
    },
  },

  // ── IoT 设备 ──────────────────────────────────────────────────────────
  {
    service: "mqtt",
    category: "iot",
    recommendation: "设置 MQTT_BROKER_URL 或在 localhost:1883 启动 MQTT Broker",
    check: async () => {
      if (hasEnv("MQTT_BROKER_URL")) {
        return { available: true, config: { url: getEnv("MQTT_BROKER_URL") } };
      }
      const reachable = await probePort("127.0.0.1", 1883, 1000);
      return {
        available: reachable,
        config: reachable ? { broker: "mqtt://localhost:1883" } : undefined,
      };
    },
  },
  {
    service: "opcua",
    category: "iot",
    recommendation: "配置 OPC-UA 服务器地址（port 4840）以接入工业设备数据",
    check: async () => {
      if (hasEnv("OPCUA_ENDPOINT_URL")) {
        return { available: true, config: { endpoint: getEnv("OPCUA_ENDPOINT_URL") } };
      }
      const reachable = await probePort("127.0.0.1", 4840, 1000);
      return {
        available: reachable,
        config: reachable ? { endpoint: "opc.tcp://localhost:4840" } : undefined,
      };
    },
  },
];

// ── 探测辅助函数 ──────────────────────────────────────────────────────────

async function probeServiceUrl(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return resp.ok || resp.status < 500;
  } catch {
    return false;
  }
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createAutoConnectManager(
  runtime: ClaworksRuntime,
  _config?: AutoConnectConfig,
): AutoConnectManager {
  return {
    async detect(): Promise<DetectedService[]> {
      const results = await Promise.all(
        SERVICE_RULES.map(async (rule) => {
          try {
            const { available, config, missingVars } = await rule.check();
            return {
              service: rule.service,
              available,
              category: rule.category,
              config,
              missingVars,
              recommendation: rule.recommendation,
            } satisfies DetectedService;
          } catch {
            return {
              service: rule.service,
              available: false,
              category: rule.category,
              recommendation: rule.recommendation,
            } satisfies DetectedService;
          }
        }),
      );

      runtime.logger?.(
        `[auto-connect] 扫描完成：${results.filter((r) => r.available).length}/${results.length} 个服务可用`,
      );

      return results;
    },

    async applyConnections(services: string[]): Promise<ApplyResult[]> {
      const results: ApplyResult[] = [];

      for (const svc of services) {
        try {
          if (svc === "feishu") {
            const appId = process.env.FEISHU_APP_ID;
            const appSecret = process.env.FEISHU_APP_SECRET;
            if (appId && appSecret) {
              // 将飞书配置写入 runtime connectors
              const existing = runtime.config.connectors ?? {};
              runtime.config.connectors = {
                ...existing,
                feishu: {
                  ...existing.feishu,
                  app_id: appId,
                  app_secret: appSecret,
                  webhook: process.env.FEISHU_WEBHOOK_URL,
                },
              };
              await runtime.kernel.publish("connect.applied", "auto-connect", {
                service: svc,
                connector_id: "feishu",
              });
              results.push({
                service: svc,
                status: "connected",
                error: `飞书已连接 (App ID: ${appId.slice(0, 8)}...)`,
              });
              runtime.logger?.(`[auto-connect] 飞书配置已应用 (${appId.slice(0, 8)}...)`);
            } else {
              results.push({
                service: svc,
                status: "failed",
                error: "缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET",
              });
            }
          } else if (svc === "ollama") {
            const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
            const reachable = await probeServiceUrl(`${baseUrl}/api/tags`);
            if (reachable) {
              runtime.config.model_router = {
                ...runtime.config.model_router,
                default: `${baseUrl}/v1`,
              };
              await runtime.kernel.publish("connect.applied", "auto-connect", {
                service: svc,
                base_url: baseUrl,
              });
              results.push({
                service: svc,
                status: "connected",
                error: `Ollama 已连接 (${baseUrl})`,
              });
              runtime.logger?.(`[auto-connect] Ollama 配置已应用 (${baseUrl})`);
            } else {
              results.push({
                service: svc,
                status: "failed",
                error: `无法访问 Ollama (${baseUrl})`,
              });
            }
          } else if (svc === "openai") {
            const apiKey = process.env.OPENAI_API_KEY;
            if (apiKey) {
              const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
              runtime.config.model_router = {
                ...runtime.config.model_router,
                default: baseUrl,
              };
              await runtime.kernel.publish("connect.applied", "auto-connect", { service: svc });
              results.push({ service: svc, status: "connected", error: "OpenAI 已连接" });
            } else {
              results.push({ service: svc, status: "failed", error: "缺少 OPENAI_API_KEY" });
            }
          } else {
            // 其他服务：发布事件，让 Playbook 处理
            await runtime.kernel.publish("connect.apply_requested", "auto-connect", {
              service: svc,
              requested_at: new Date().toISOString(),
            });
            results.push({ service: svc, status: "connected" });
            runtime.logger?.(`[auto-connect] 已请求连接：${svc}`);
          }
        } catch (err) {
          results.push({
            service: svc,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return results;
    },

    async generateRecommendations(): Promise<string[]> {
      const detected = await this.detect();
      const recommendations: string[] = [];

      const available = detected.filter((d) => d.available);
      const unavailable = detected.filter((d) => !d.available);

      if (available.length > 0) {
        recommendations.push(
          `✅ 已发现 ${available.length} 个可用服务：${available.map((d) => d.service).join(", ")}`,
        );
      }

      // 按类别汇总缺失的服务
      const missingByCategory = new Map<string, string[]>();
      for (const svc of unavailable) {
        if (!svc.recommendation) {
          continue;
        }
        const arr = missingByCategory.get(svc.category) ?? [];
        arr.push(svc.recommendation);
        missingByCategory.set(svc.category, arr);
      }

      if (missingByCategory.has("im")) {
        recommendations.push(`📱 IM 渠道：${missingByCategory.get("im")!.join("；")}`);
      }
      if (missingByCategory.has("ai")) {
        recommendations.push(`🤖 AI 服务：${missingByCategory.get("ai")!.join("；")}`);
      }
      if (missingByCategory.has("iot")) {
        recommendations.push(`🏭 IoT 设备：${missingByCategory.get("iot")!.join("；")}`);
      }

      return recommendations;
    },
  };
}

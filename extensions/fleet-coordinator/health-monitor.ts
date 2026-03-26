/** Background health monitor — periodically checks all fleet services. */

import { setHeartbeat } from "./fleet-redis.js";
import { getActiveNodes } from "./fleet-registry.js";
import type { FleetConfig, FleetNodeConfig, HealthResult } from "./types.js";

const healthCache = new Map<string, HealthResult>();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

async function checkHttpHealth(
  url: string,
  timeoutMs = 5000,
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    // 401/403 are still "healthy" (service is running, just auth-gated)
    const healthy = resp.status < 400 || resp.status === 401 || resp.status === 403;
    return { healthy, latencyMs };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function checkTcpHealth(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const { createConnection } = await import("node:net");
    return new Promise((resolve) => {
      const socket = createConnection({ host, port, timeout: timeoutMs });
      socket.on("connect", () => {
        socket.destroy();
        resolve({ healthy: true, latencyMs: Date.now() - start });
      });
      socket.on("error", (err) => {
        socket.destroy();
        resolve({ healthy: false, latencyMs: Date.now() - start, error: err.message });
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve({ healthy: false, latencyMs: Date.now() - start, error: "timeout" });
      });
    });
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function checkNode(nodeName: string, node: FleetNodeConfig): Promise<HealthResult> {
  const services: Record<string, { healthy: boolean; latencyMs: number; error?: string }> = {};

  // Check node reachability (SSH port)
  const reachability = await checkTcpHealth(node.tailscaleIp, 22, 3000);

  // Check each service
  if (node.services) {
    for (const [svcName, svc] of Object.entries(node.services)) {
      if (svc.healthProtocol === "tcp") {
        services[svcName] = await checkTcpHealth(node.tailscaleIp, svc.port);
      } else if (svc.healthEndpoint) {
        const url = `http://${node.tailscaleIp}:${svc.port}${svc.healthEndpoint}`;
        services[svcName] = await checkHttpHealth(url);
      } else {
        const url = `http://${node.tailscaleIp}:${svc.port}/healthz`;
        services[svcName] = await checkHttpHealth(url);
      }
    }
  }

  const result: HealthResult = {
    node: nodeName,
    reachable: reachability.healthy,
    services,
    timestamp: Date.now(),
  };

  // Publish to Redis for distributed awareness
  const flatData: Record<string, string> = {
    reachable: String(result.reachable),
    timestamp: String(result.timestamp),
    services: JSON.stringify(services),
  };
  await setHeartbeat(`fleet:${nodeName}`, flatData, 120);

  return result;
}

export async function runHealthCheck(config: FleetConfig): Promise<Map<string, HealthResult>> {
  const nodes = getActiveNodes(config);
  const results = await Promise.allSettled(
    Object.entries(nodes).map(async ([name, node]) => {
      const result = await checkNode(name, node);
      healthCache.set(name, result);
      return [name, result] as const;
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      healthCache.set(r.value[0], r.value[1]);
    }
  }

  return healthCache;
}

export function getCachedHealth(): Map<string, HealthResult> {
  return healthCache;
}

export function getNodeHealth(nodeName: string): HealthResult | undefined {
  return healthCache.get(nodeName);
}

export function startHealthMonitor(config: FleetConfig, intervalMs = 60000): void {
  // Initial check
  runHealthCheck(config);

  monitorInterval = setInterval(() => runHealthCheck(config), intervalMs);
  if (monitorInterval && typeof monitorInterval === "object" && "unref" in monitorInterval) {
    (monitorInterval as NodeJS.Timeout).unref();
  }
}

export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

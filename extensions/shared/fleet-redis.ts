/**
 * Shared Redis client for fleet coordination.
 *
 * Lazy singleton using ioredis. Fail-open: if Redis is unreachable,
 * operations degrade gracefully (no locks acquired, heartbeats silently fail).
 *
 * Config via env vars:
 *   FLEET_REDIS_HOST (default: 100.93.214.109)
 *   FLEET_REDIS_PORT (default: 6380)
 *   FLEET_REDIS_DB   (default: 2)
 */

import Redis from "ioredis";

let client: Redis | null = null;
let connecting = false;

function getRedisConfig() {
	return {
		host: process.env.FLEET_REDIS_HOST || "100.93.214.109",
		port: Number(process.env.FLEET_REDIS_PORT || "6380"),
		db: Number(process.env.FLEET_REDIS_DB || "2"),
		retryStrategy: (times: number) => Math.min(times * 500, 5000),
		maxRetriesPerRequest: 1,
		enableReadyCheck: true,
		lazyConnect: true,
	};
}

export function getFleetRedis(): Redis | null {
	if (client) return client;
	if (connecting) return null;

	connecting = true;
	try {
		client = new Redis(getRedisConfig());
		client.on("error", (err) => {
			console.warn(`[fleet-redis] Connection error: ${err.message}`);
		});
		client.on("close", () => {
			client = null;
			connecting = false;
		});
		client.connect().catch(() => {
			client = null;
			connecting = false;
		});
	} catch {
		client = null;
		connecting = false;
	}
	return client;
}

/** Acquire a distributed lock via SETNX. Returns true if lock acquired. */
export async function acquireLock(key: string, holder: string, ttlSeconds = 300): Promise<boolean> {
	const redis = getFleetRedis();
	if (!redis) return false; // fail-open
	try {
		const result = await redis.set(`lock:${key}`, holder, "EX", ttlSeconds, "NX");
		return result === "OK";
	} catch {
		return false; // fail-open
	}
}

/** Release a distributed lock. Only releases if held by the specified holder. */
export async function releaseLock(key: string, holder: string): Promise<boolean> {
	const redis = getFleetRedis();
	if (!redis) return false;
	try {
		const current = await redis.get(`lock:${key}`);
		if (current === holder) {
			await redis.del(`lock:${key}`);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

/** Check who holds a lock. Returns holder string or null. */
export async function getLockHolder(key: string): Promise<string | null> {
	const redis = getFleetRedis();
	if (!redis) return null;
	try {
		return await redis.get(`lock:${key}`);
	} catch {
		return null;
	}
}

/** Set a heartbeat for an agent/node. */
export async function setHeartbeat(key: string, data: Record<string, string>, ttlSeconds = 120): Promise<void> {
	const redis = getFleetRedis();
	if (!redis) return;
	try {
		const pipeline = redis.pipeline();
		pipeline.hset(key, data);
		pipeline.expire(key, ttlSeconds);
		await pipeline.exec();
	} catch {
		// fail-open
	}
}

/** Get heartbeat data. Returns null if expired or missing. */
export async function getHeartbeat(key: string): Promise<Record<string, string> | null> {
	const redis = getFleetRedis();
	if (!redis) return null;
	try {
		const data = await redis.hgetall(key);
		return Object.keys(data).length > 0 ? data : null;
	} catch {
		return null;
	}
}

/** Gracefully close the Redis connection. */
export async function closeFleetRedis(): Promise<void> {
	if (client) {
		await client.quit().catch(() => {});
		client = null;
		connecting = false;
	}
}

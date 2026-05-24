import { a as listDecisionLog, c as prometheusMetricsText, o as listObservationEvents, t as isDocumentKnowledgeBase, u as globalMetrics } from "./kb-types-JeIAB0Dq.mjs";
import { A as uninstallClaworksPack, E as reloadClaworksPacksFromDisk, N as applyIngressPublish, b as installClaworksPack, d as runClaworksDoctor, f as runClaworksDoctorFix, i as bridgeImMessage, j as updateClaworksPack, k as searchNexusPackages, l as buildHealthPayload, o as checkA2aPeerRbac, p as defaultClaworksStateDir, s as resolveA2aPeer, t as buildA2aAgentCard } from "./agent-card-0vXLqNel.mjs";
import { c as listPackages, d as scanNexusCatalog, l as openPackArtifactStream, s as getPackageDetail, u as resolvePackDir } from "./pack-loader-DLYx0S-x.mjs";
import { dirname, extname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
//#region src/kernel/rate-limiter.ts
function createRateLimiter(config = {}) {
	const windowMs = config.windowMs ?? 6e4;
	const maxRequests = config.maxRequests ?? 60;
	const maxBuckets = config.maxBuckets ?? 1e4;
	const maxStaleBucketMs = config.maxStaleBucketMs ?? 5 * 6e4;
	const buckets = /* @__PURE__ */ new Map();
	function getOrCreate(key, nowMs) {
		const existing = buckets.get(key);
		if (existing && nowMs - existing.windowStartMs < windowMs) return {
			bucket: existing,
			isNew: false
		};
		if (!existing && buckets.size >= maxBuckets) {
			const oldest = buckets.keys().next().value;
			if (oldest !== void 0) buckets.delete(oldest);
		}
		const bucket = {
			count: 0,
			windowStartMs: nowMs
		};
		buckets.set(key, bucket);
		return {
			bucket,
			isNew: true
		};
	}
	function buildResult(key, bucket, allowed, nowMs) {
		return {
			allowed,
			remaining: Math.max(0, maxRequests - bucket.count),
			retryAfterMs: allowed ? 0 : Math.max(0, bucket.windowStartMs + windowMs - nowMs),
			key
		};
	}
	return {
		consume(key, nowMs = Date.now()) {
			const { bucket } = getOrCreate(key, nowMs);
			if (bucket.count >= maxRequests) return buildResult(key, bucket, false, nowMs);
			bucket.count++;
			return buildResult(key, bucket, true, nowMs);
		},
		peek(key, nowMs = Date.now()) {
			const existing = buckets.get(key);
			if (!existing || nowMs - existing.windowStartMs >= windowMs) return {
				allowed: true,
				remaining: maxRequests,
				retryAfterMs: 0,
				key
			};
			return buildResult(key, existing, existing.count < maxRequests, nowMs);
		},
		reset(key) {
			buckets.delete(key);
		},
		prune(nowMs = Date.now()) {
			let count = 0;
			for (const [key, bucket] of buckets.entries()) if (nowMs - bucket.windowStartMs >= maxStaleBucketMs) {
				buckets.delete(key);
				count++;
			}
			return count;
		},
		size() {
			return buckets.size;
		}
	};
}
/** 通用 API 限流（60次/分/source） */
const API_RATE_LIMITER_CONFIG = {
	windowMs: 6e4,
	maxRequests: 60
};
/** 解析速率限制 key（source + subjectId 组合）*/
function resolveRateLimitKey(source, subjectId) {
	return `${source.trim() || "unknown"}|${(subjectId ?? "").trim() || "anonymous"}`;
}
//#endregion
//#region src/planes/data/kb-status.ts
function resolveKbProviderLabel(data) {
	if (data?.kb_provider === "memory-core") return "memory-core";
	if (data?.kb_path?.trim() && data.kb_provider !== "stub") return "file";
	return "stub";
}
async function describeKnowledgeBase(kb, data, opts) {
	if (kb.describe) {
		const described = await kb.describe();
		return {
			...described,
			memory_slot: opts?.memorySlot ?? described.memory_slot,
			kb_embed_model: data?.kb_embed_model ?? described.kb_embed_model,
			kb_path: data?.kb_path ?? described.kb_path
		};
	}
	const provider = resolveKbProviderLabel(data);
	return {
		provider,
		vector: provider === "memory-core",
		kb_path: data?.kb_path,
		kb_embed_model: data?.kb_embed_model,
		kb_drop_dir: join(defaultClaworksStateDir(), "kb-drop"),
		memory_slot: opts?.memorySlot,
		document_count: 0,
		note: provider === "stub" ? "in-memory stub KB (substring match; set kb_provider=memory-core for vector RAG)" : void 0
	};
}
//#endregion
//#region src/interfaces/rest/auth.ts
/**
* 验证请求认证 + 提取主体上下文，供 RBAC 使用。
* - 有 api_key 配置时：Bearer Token 必须匹配，主体类型为 apikey
* - 无 api_key 配置时：本地开发模式，主体为 system（始终允许）
*/
function readChannelUserHeader(req) {
	const raw = req.headers["x-claworks-channel-user"];
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
	return "";
}
/**
* 对 API 密钥进行 SHA-256 哈希，用于存储哈希值的配置场景。
* 返回 64 位小写十六进制字符串。
*/
function hashApiKey(key) {
	return createHash("sha256").update(key).digest("hex");
}
/**
* 判断请求 token 是否匹配配置中存储的密钥值。
* 向后兼容：
*   - 存储值长度 < 32：视为明文，直接比对
*   - 存储值长度 >= 32：视为 SHA-256 哈希，对 token 哈希后比对
*/
function matchesKey(token, stored) {
	if (stored.length < 32) return token === stored;
	return hashApiKey(token) === stored;
}
/**
* 收集所有有效 API 密钥（primary + rotation list），去除空值。
* 支持多密钥并行（密钥轮换不中断服务）。
*/
function collectValidKeys(runtime) {
	const keys = [];
	const primary = runtime.config.api?.api_key?.trim();
	if (primary) keys.push(primary);
	for (const k of runtime.config.api?.api_keys ?? []) {
		const t = k?.trim();
		if (t && !keys.includes(t)) keys.push(t);
	}
	return keys;
}
function resolveAuthContext(req, runtime) {
	const validKeys = collectValidKeys(runtime);
	const requireApiKey = runtime.config.api?.require_api_key === true;
	const header = req.headers.authorization ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	const channelUser = readChannelUserHeader(req);
	if (validKeys.length === 0) {
		if (requireApiKey) return {
			authenticated: false,
			subjectType: "apikey",
			subjectId: "unknown"
		};
		if (channelUser) return {
			authenticated: true,
			subjectType: "channel_user",
			subjectId: channelUser
		};
		return {
			authenticated: true,
			subjectType: "system",
			subjectId: "local"
		};
	}
	if (token && validKeys.some((k) => matchesKey(token, k))) {
		if (channelUser) return {
			authenticated: true,
			subjectType: "channel_user",
			subjectId: channelUser
		};
		return {
			authenticated: true,
			subjectType: "apikey",
			subjectId: `apikey:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`
		};
	}
	return {
		authenticated: false,
		subjectType: "apikey",
		subjectId: "unknown"
	};
}
/** 旧版兼容：只返回 boolean（内部模块仍可用） */
function checkClaworksApiAuth(req, runtime) {
	return resolveAuthContext(req, runtime).authenticated;
}
/**
* RBAC 权限检查（非 HTTP 中间件，作为函数调用）。
* 返回 denied 时，调用方负责发 403 并发布 rbac.denied 事件（供 Playbook 响应）。
*/
function checkRbac(runtime, auth, action, resource) {
	return runtime.rbac.check({
		action,
		resource,
		subjectType: auth.subjectType,
		subjectId: auth.subjectId
	});
}
//#endregion
//#region src/interfaces/rest/http-utils.ts
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return {};
	return JSON.parse(raw);
}
function sendJson$2(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}
function notFound(res) {
	sendJson$2(res, 404, {
		error: "Not found",
		code: "NOT_FOUND"
	});
}
function badRequest(res, message) {
	sendJson$2(res, 400, {
		error: message,
		code: "BAD_REQUEST"
	});
}
function parsePath(url) {
	return new URL(url, "http://localhost").pathname.split("/").filter(Boolean);
}
//#endregion
//#region src/interfaces/rest/router-context.ts
function extractEventSessionAndText(body, payload) {
	const sessionRaw = payload.session_id ?? payload.sessionId ?? body.session_id ?? body.sessionId;
	const textRaw = payload.text ?? payload.message ?? payload.content ?? body.text ?? body.message ?? body.content;
	return {
		sessionId: typeof sessionRaw === "string" && sessionRaw.trim() ? sessionRaw.trim() : null,
		text: typeof textRaw === "string" && textRaw.trim() ? textRaw.trim() : null
	};
}
//#endregion
//#region src/interfaces/rest/router.ts
const _apiRateLimiter = createRateLimiter(API_RATE_LIMITER_CONFIG);
const _routerDir = dirname(fileURLToPath(import.meta.url));
let _dashboardHtml = null;
function serveDashboard(res) {
	if (!_dashboardHtml) try {
		_dashboardHtml = readFileSync(join(_routerDir, "../studio/dashboard.html"), "utf-8");
	} catch {
		_dashboardHtml = "<h1>ClaWorks API</h1><p>Studio UI unavailable. Access <a href='/v1/health'>/v1/health</a> for status.</p>";
	}
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.end(_dashboardHtml);
}
function createClaworksRestHandler(runtime) {
	const configLimits = runtime.config.kernel;
	const rateLimiter = configLimits?.rate_limit_max_requests || configLimits?.rate_limit_window_ms ? createRateLimiter({
		maxRequests: configLimits.rate_limit_max_requests,
		windowMs: configLimits.rate_limit_window_ms
	}) : _apiRateLimiter;
	return async (req, res) => {
		const method = req.method ?? "GET";
		const rawPath = new URL(req.url ?? "/", "http://localhost").pathname;
		const parts = parsePath(req.url ?? "/");
		if (method === "GET" && (rawPath === "/" || rawPath === "/studio" || rawPath === "/studio/")) {
			serveDashboard(res);
			return true;
		}
		if (parts[0] !== "v1") return false;
		const auth = resolveAuthContext(req, runtime);
		if (!auth.authenticated) {
			sendJson$2(res, 401, {
				error: "Unauthorized",
				code: "UNAUTHORIZED"
			});
			return true;
		}
		if (!(method === "GET" && (parts[1] === "health" || parts[1] === "metrics"))) {
			const rlKey = resolveRateLimitKey("rest", auth.subjectId);
			const rlResult = rateLimiter.consume(rlKey);
			if (!rlResult.allowed) {
				res.setHeader("Retry-After", String(Math.ceil(rlResult.retryAfterMs / 1e3)));
				res.setHeader("X-RateLimit-Remaining", "0");
				sendJson$2(res, 429, {
					error: "Too Many Requests",
					code: "RATE_LIMITED",
					retryAfterMs: rlResult.retryAfterMs
				});
				return true;
			}
			res.setHeader("X-RateLimit-Remaining", String(rlResult.remaining));
		}
		/** 写操作 RBAC helper（deny 时发 rbac.denied 事件并返回 403） */
		const requireWrite = async (resource) => {
			const rbacResult = checkRbac(runtime, auth, "rest.write", resource);
			if (!rbacResult.allowed) {
				runtime.kernel.publish("rbac.denied", "rest", {
					subject_type: auth.subjectType,
					subject_id: auth.subjectId,
					action: "rest.write",
					resource,
					reason: rbacResult.reason
				}, {
					subjectType: "system",
					subjectId: "rbac"
				}).catch(() => void 0);
				sendJson$2(res, 403, {
					error: "Forbidden",
					code: "RBAC_DENIED",
					reason: rbacResult.reason
				});
				return false;
			}
			return true;
		};
		const requireRead = async (resource = "rest:*") => {
			const rbacResult = checkRbac(runtime, auth, "rest.read", resource);
			if (!rbacResult.allowed) {
				runtime.kernel.publish("rbac.denied", "rest", {
					subject_type: auth.subjectType,
					subject_id: auth.subjectId,
					action: "rest.read",
					resource,
					reason: rbacResult.reason
				}, {
					subjectType: "system",
					subjectId: "rbac"
				}).catch(() => void 0);
				sendJson$2(res, 403, {
					error: "Forbidden",
					code: "RBAC_DENIED",
					reason: rbacResult.reason
				});
				return false;
			}
			return true;
		};
		try {
			if (method === "GET" && parts[1] === "health") {
				sendJson$2(res, 200, buildHealthPayload(runtime));
				return true;
			}
			if (method === "GET" && parts[1] === "identity") {
				sendJson$2(res, 200, {
					name: runtime.identity.name,
					role: runtime.identity.role,
					domain: runtime.identity.domain,
					description: runtime.identity.description,
					rules: runtime.identity.rules,
					robot: runtime.robot,
					rbac_policies_loaded: runtime.rbac !== void 0,
					ingress_policies_loaded: runtime.ingress !== void 0
				});
				return true;
			}
			if (method === "GET" && parts[1] === "identity" && parts[2] === "agent-md") {
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/markdown; charset=utf-8");
				res.end(runtime.identity.agentMd);
				return true;
			}
			if (method === "POST" && parts[1] === "rbac" && parts[2] === "reload") {
				if (!await requireWrite("rbac:*")) return true;
				const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync-B-SXi7LG.mjs");
				await syncRbacFromObjectStore(runtime);
				await syncIngressFromObjectStore(runtime);
				sendJson$2(res, 200, {
					status: "ok",
					reloaded_at: (/* @__PURE__ */ new Date()).toISOString()
				});
				return true;
			}
			if (method === "GET" && parts[1] === "metrics" && parts.length === 2) {
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/plain; version=0.0.4");
				res.end(prometheusMetricsText(runtime.robot.name));
				return true;
			}
			if (method === "GET" && parts[1] === "metrics" && parts[2] === "json") {
				sendJson$2(res, 200, globalMetrics.snapshot());
				return true;
			}
			if (method === "GET" && parts[1] === "decision-log") {
				const url = new URL(req.url ?? "/", "http://localhost");
				sendJson$2(res, 200, { entries: listDecisionLog(Number(url.searchParams.get("limit") ?? 50)) });
				return true;
			}
			if (method === "GET" && parts[1] === "audit_log") {
				const url = new URL(req.url ?? "/", "http://localhost");
				const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
				const memEntries = listDecisionLog(limit).map((e) => ({
					...e,
					source: "decision_log"
				}));
				let dbEntries = [];
				try {
					const auditCap = runtime.capabilities.get("security.audit_log");
					if (auditCap) {
						const result = await auditCap.handler({
							runId: "observe/audit_log",
							playbookId: "",
							stepId: ""
						}, { limit });
						const items = result.events ?? result.entries ?? result.items ?? [];
						dbEntries = Array.isArray(items) ? items : [];
					}
				} catch {}
				sendJson$2(res, 200, { audit_log: {
					query: { limit },
					in_memory_count: memEntries.length,
					db_count: dbEntries.length,
					entries: [...memEntries, ...dbEntries]
				} });
				return true;
			}
			if (method === "GET" && parts[1] === "observation-events") {
				const url = new URL(req.url ?? "/", "http://localhost");
				sendJson$2(res, 200, { events: listObservationEvents(Number(url.searchParams.get("limit") ?? 50)) });
				return true;
			}
			if (method === "GET" && parts[1] === "doctor") {
				if (!await requireRead()) return true;
				const checks = runClaworksDoctor(runtime);
				sendJson$2(res, 200, {
					checks,
					healthy: checks.every((c) => c.status !== "error")
				});
				return true;
			}
			if (method === "POST" && parts[1] === "doctor") {
				const url = new URL(req.url ?? "/", "http://localhost");
				let body = {};
				try {
					body = await readJsonBody(req);
				} catch {
					body = {};
				}
				const fix = url.searchParams.get("fix") === "true" || body.fix === true;
				const checks = runClaworksDoctor(runtime);
				if (!fix) {
					sendJson$2(res, 200, { checks });
					return true;
				}
				const fixResult = await runClaworksDoctorFix(runtime);
				sendJson$2(res, 200, {
					checks: runClaworksDoctor(runtime),
					fix: {
						applied: fixResult.applied,
						warnings: fixResult.warnings,
						repair: fixResult.repair
					}
				});
				return true;
			}
			if (method === "GET" && parts[1] === "connectors") {
				sendJson$2(res, 200, { connectors: runtime.connectorManager.list() });
				return true;
			}
			if (method === "POST" && parts[1] === "connectors" && parts[2] && parts[3] === "invoke") {
				const body = await readJsonBody(req);
				if (!body.method) {
					badRequest(res, "method is required");
					return true;
				}
				const result = await runtime.connectorManager.invoke(parts[2], body.method, body.params);
				sendJson$2(res, 200, {
					invoked: true,
					connector: parts[2],
					method: body.method,
					result
				});
				return true;
			}
			if (method === "GET" && parts[1] === "packs" && parts[2] === "registry") {
				sendJson$2(res, 200, await searchNexusPackages(runtime, new URL(req.url ?? "/", "http://localhost").searchParams.get("q") ?? void 0));
				return true;
			}
			if (method === "GET" && parts[1] === "packs") {
				sendJson$2(res, 200, {
					packs: runtime.loadedPacks.map((p) => ({
						id: p.manifest.id,
						name: p.manifest.name,
						version: p.manifest.version,
						path: p.path,
						playbooks: p.playbooks.length,
						objectTypes: p.objectTypes.length
					})),
					registry: runtime.config.packs?.registry ?? process.env.CLAWORKS_NEXUS_URL ?? null
				});
				return true;
			}
			if (method === "POST" && parts[1] === "packs" && parts[2] === "install") {
				const body = await readJsonBody(req);
				if (!body.source) {
					badRequest(res, "source is required");
					return true;
				}
				const result = await installClaworksPack(runtime, body.source);
				sendJson$2(res, 201, {
					installed: result.installed,
					pack: {
						id: result.pack.manifest.id,
						version: result.pack.manifest.version,
						path: result.pack.path
					}
				});
				return true;
			}
			if (method === "DELETE" && parts[1] === "packs" && parts[2]) {
				const installed = await uninstallClaworksPack(runtime, parts[2]);
				sendJson$2(res, 200, {
					uninstalled: parts[2],
					installed
				});
				return true;
			}
			if (method === "POST" && parts[1] === "packs" && parts[2] === "reload") {
				sendJson$2(res, 200, { reloaded: (await reloadClaworksPacksFromDisk(runtime)).packs.map((p) => ({
					id: p.manifest.id,
					version: p.manifest.version
				})) });
				return true;
			}
			if (method === "POST" && parts[1] === "packs" && parts[2] === "update") {
				const body = await readJsonBody(req);
				if (!body.source) {
					badRequest(res, "source is required");
					return true;
				}
				const result = await updateClaworksPack(runtime, body.source);
				sendJson$2(res, 200, {
					updated: result.pack.manifest.id,
					version: result.pack.manifest.version,
					installed: result.installed
				});
				return true;
			}
			if (method === "GET" && parts[1] === "playbooks") {
				if (parts[2] === void 0) {
					sendJson$2(res, 200, { playbooks: runtime.playbookEngine.list().map((p) => ({
						id: p.id,
						name: p.name,
						trigger: p.trigger,
						pack: p.pack,
						priority: p.priority
					})) });
					return true;
				}
				if (parts[3] === "runs" && parts[2]) {
					sendJson$2(res, 200, { runs: await runtime.playbookEngine.listRuns({
						playbookId: parts[2],
						limit: 50
					}) });
					return true;
				}
			}
			if (method === "POST" && parts[1] === "playbooks" && parts[3] === "runs" && parts[2]) {
				const body = await readJsonBody(req);
				sendJson$2(res, 202, await runtime.playbookEngine.trigger(parts[2], body.input ?? {}));
				return true;
			}
			if (method === "GET" && parts[1] === "playbooks" && parts[3] === "runs" && parts[4] && parts[2]) {
				const run = await runtime.playbookEngine.getRun(parts[4]);
				if (!run) {
					notFound(res);
					return true;
				}
				sendJson$2(res, 200, run);
				return true;
			}
			if (method === "PUT" && parts[1] === "playbooks" && parts[2] && parts[3] === "yaml") {
				if (!await requireWrite(`playbook:${parts[2]}`)) return true;
				const body = await readJsonBody(req);
				if (!body.yaml) {
					badRequest(res, "yaml is required");
					return true;
				}
				const { homedir } = await import("node:os");
				const customPackRoot = join(homedir(), ".claworks", "packs", "custom");
				const playbooksDir = join(customPackRoot, "ontology", "playbooks");
				mkdirSync(playbooksDir, { recursive: true });
				const manifestPath = join(customPackRoot, "claworks.pack.json");
				try {
					mkdirSync(dirname(manifestPath), { recursive: true });
					writeFileSync(manifestPath, JSON.stringify({
						id: "custom",
						name: "Custom operator pack",
						version: "1.0.0",
						license: "MIT",
						provides: {
							objectTypes: [],
							playbooks: [],
							actionTypes: []
						}
					}, null, 2), { flag: "wx" });
				} catch {}
				const safeId = parts[2].replace(/[^\w-]/g, "_");
				const filePath = join(playbooksDir, `${safeId}.yaml`);
				writeFileSync(filePath, String(body.yaml), "utf-8");
				const { reloadClaworksPacksFromDisk } = await import("./pack-runtime-C63rWlbc.mjs");
				const packPaths = new Set([...runtime.config.packs?.paths ?? [], customPackRoot]);
				runtime.config.packs = {
					...runtime.config.packs,
					paths: [...packPaths],
					installed: [...new Set([...runtime.config.packs?.installed ?? [], "custom"])]
				};
				sendJson$2(res, 201, {
					status: "ok",
					playbook_id: safeId,
					file_path: filePath,
					reloaded_packs: (await reloadClaworksPacksFromDisk(runtime)).packs.map((p) => p.manifest.id)
				});
				return true;
			}
			if (method === "POST" && parts[1] === "playbooks" && parts[2] && parts[3] === "simulate") {
				const playbookId = parts[2];
				const body = await readJsonBody(req);
				const vars = body?.vars ?? {};
				const event = body?.event ?? { type: `manual.simulate.${playbookId}` };
				if (!(runtime.playbookEngine?.listPlaybooks?.() ?? []).find((p) => p.id === playbookId || p.id === `process.${playbookId}`)) {
					notFound(res);
					return true;
				}
				const { createMockObjectStore, createPlaybookSimulator } = await import("./playbook-simulator-CRHzOrGN.mjs");
				sendJson$2(res, 200, await createPlaybookSimulator(async (pid, initVars, trigEvent, mockStore) => {
					const steps = [];
					try {
						const sandboxRuntime = Object.create(runtime);
						sandboxRuntime.objectStore = mockStore;
						const playbookEngine = runtime.playbookEngine;
						if (!playbookEngine) throw new Error("PlaybookEngine 未初始化");
						const run = await playbookEngine.trigger(pid, typeof trigEvent === "object" && trigEvent !== null && !Array.isArray(trigEvent) ? trigEvent : {}, { variables: {
							...initVars,
							_simulate: true,
							_mock_store: mockStore
						} });
						if (run?.steps) for (let i = 0; i < run.steps.length; i++) {
							const s = run.steps[i];
							const durationMs = s.completedAt && s.startedAt ? s.completedAt.getTime() - s.startedAt.getTime() : 0;
							steps.push({
								step: i,
								type: s.stepId,
								name: s.stepId,
								status: s.status === "failed" ? "error" : "ok",
								durationMs,
								output: s.output,
								error: s.error
							});
						}
						return {
							steps,
							error: run.error
						};
					} catch (e) {
						return {
							steps,
							error: String(e)
						};
					}
				}).simulate(playbookId, vars, event));
				return true;
			}
			async function handleHitlSubmit(runId) {
				const rbacResult = checkRbac(runtime, auth, "hitl.resolve", `run:${runId}`);
				if (!rbacResult.allowed) {
					runtime.kernel.publish("rbac.denied", "rest", {
						subject_type: auth.subjectType,
						subject_id: auth.subjectId,
						action: "hitl.resolve",
						resource: `run:${runId}`,
						reason: rbacResult.reason
					}, {
						subjectType: "system",
						subjectId: "rbac"
					}).catch(() => void 0);
					sendJson$2(res, 403, {
						error: "Forbidden",
						code: "RBAC_DENIED",
						reason: rbacResult.reason
					});
					return true;
				}
				const body = await readJsonBody(req);
				if (!body.step_id || !body.decision) {
					badRequest(res, "step_id and decision are required");
					return true;
				}
				sendJson$2(res, 200, await runtime.playbookEngine.submitHitlDecision(runId, body.step_id, body.decision, body.comment));
				return true;
			}
			if (method === "POST" && parts[1] === "playbooks" && parts[2] === "runs" && parts[4] === "hitl" && parts[3]) return await handleHitlSubmit(parts[3]);
			if (method === "POST" && parts[1] === "playbooks" && parts[3] === "runs" && parts[5] === "hitl" && parts[2] && parts[4]) return await handleHitlSubmit(parts[4]);
			if (method === "POST" && parts[1] === "events") {
				if (!await requireWrite(`event:*`)) return true;
				const body = await readJsonBody(req);
				if (!body.type) {
					badRequest(res, "type is required");
					return true;
				}
				const payload = body.payload ?? {};
				const { sessionId: eventSessionId, text: eventText } = extractEventSessionAndText(body, payload);
				if (eventSessionId && eventText) runtime.contextEngine?.append(eventSessionId, "user", eventText, { channel: "rest" });
				const publishResult = await applyIngressPublish(runtime, {
					source: "rest",
					eventType: body.type,
					subjectId: auth.subjectId,
					payload,
					correlationId: body.correlation_id,
					idempotencyKey: body.idempotency_key,
					subjectType: auth.subjectType,
					publishSource: body.source ?? "rest-api"
				});
				if (publishResult.action === "denied") {
					sendJson$2(res, 403, {
						error: "Forbidden",
						code: "INGRESS_DENIED",
						reason: publishResult.reason
					});
					return true;
				}
				if (publishResult.action === "observe_only") {
					sendJson$2(res, 202, { action: "observe_only" });
					return true;
				}
				if (publishResult.action === "intent_routed") {
					sendJson$2(res, 202, {
						action: "intent_routed",
						playbook_id: publishResult.playbookId,
						run_id: publishResult.runId,
						status: publishResult.status
					});
					return true;
				}
				sendJson$2(res, 202, {
					event_id: randomUUID(),
					event_type: publishResult.eventType,
					matched_playbooks: publishResult.matchedPlaybooks
				});
				return true;
			}
			if (method === "GET" && parts[1] === "capabilities") {
				const caps = runtime.capabilities.list().map((c) => ({
					id: c.id,
					verb: c.verb,
					description: c.description,
					owner: c.owner
				}));
				sendJson$2(res, 200, {
					capabilities: caps,
					count: caps.length
				});
				return true;
			}
			if (method === "GET" && parts[1] === "runs" && !parts[2]) {
				const runs = await runtime.playbookEngine.listRuns({ limit: 50 });
				sendJson$2(res, 200, {
					runs,
					count: runs.length
				});
				return true;
			}
			if (method === "GET" && parts[1] === "events") {
				sendJson$2(res, 200, { events: await runtime.kernel.bus.query({ limit: 50 }) });
				return true;
			}
			if (method === "POST" && parts[1] === "bridge" && parts[2] === "webhook") {
				const body = await readJsonBody(req);
				if (!body.source || body.body === void 0 && body.payload === void 0) {
					badRequest(res, "source and body (or payload) are required");
					return true;
				}
				const { bridgeWebhookPayload } = await import("./webhook-bridge-DpvzmbB-.mjs");
				const result = await bridgeWebhookPayload(runtime, {
					source: String(body.source),
					webhookId: body.webhook_id ? String(body.webhook_id) : body.webhookId ? String(body.webhookId) : void 0,
					body: body.body ?? body.payload,
					subjectId: body.subject_id ? String(body.subject_id) : body.subjectId ? String(body.subjectId) : auth.subjectId,
					extra: body.extra
				});
				sendJson$2(res, result.action === "denied" ? 403 : 202, result);
				return true;
			}
			if (method === "POST" && parts[1] === "bridge" && parts[2] === "im") {
				const body = await readJsonBody(req);
				if (!body.channel || !body.text) {
					badRequest(res, "channel and text are required");
					return true;
				}
				const { bridgeImMessage } = await import("./im-bridge-CKgUqBfa.mjs");
				const result = await bridgeImMessage(runtime, {
					channel: String(body.channel),
					messageId: String(body.message_id ?? body.messageId ?? `msg-${Date.now()}`),
					userId: String(body.user_id ?? body.userId ?? auth.subjectId),
					text: String(body.text),
					groupId: body.group_id ? String(body.group_id) : body.groupId ? String(body.groupId) : void 0,
					extra: body.extra
				});
				sendJson$2(res, result.action === "denied" ? 403 : 202, result);
				return true;
			}
			if (method === "GET" && parts[1] === "objects" && parts[2]) {
				const url = new URL(req.url ?? "/", "http://localhost");
				const filterRaw = url.searchParams.get("filter");
				const filter = filterRaw ? JSON.parse(filterRaw) : void 0;
				const result = await runtime.objectStore.query(parts[2], {
					filter,
					limit: Number(url.searchParams.get("limit") ?? 50)
				});
				sendJson$2(res, 200, {
					type: parts[2],
					items: result.items,
					next_cursor: result.nextCursor
				});
				return true;
			}
			if (method === "GET" && parts[1] === "objects" && parts[2] && parts[3]) {
				const obj = await runtime.objectStore.get(parts[2], parts[3]);
				if (!obj) {
					notFound(res);
					return true;
				}
				sendJson$2(res, 200, obj);
				return true;
			}
			if (method === "POST" && parts[1] === "objects" && parts[2] && !parts[3]) {
				if (!await requireWrite(`object:${parts[2]}`)) return true;
				const body = await readJsonBody(req);
				sendJson$2(res, 201, await runtime.objectStore.create(parts[2], body));
				return true;
			}
			if (method === "PATCH" && parts[1] === "objects" && parts[2] && parts[3]) {
				if (!await requireWrite(`object:${parts[2]}:${parts[3]}`)) return true;
				const body = await readJsonBody(req);
				sendJson$2(res, 200, await runtime.objectStore.update(parts[2], parts[3], body));
				return true;
			}
			if (method === "POST" && parts[1] === "objects" && parts[2] && parts[3] && parts[4] === "actions" && parts[5]) {
				if (!await requireWrite(`object:${parts[2]}:${parts[3]}/action:${parts[5]}`)) return true;
				const body = await readJsonBody(req);
				sendJson$2(res, 200, await runtime.objectStore.executeAction(parts[2], parts[3], parts[5], body, {
					runId: "rest",
					playbookId: "rest",
					variables: {},
					objectStore: runtime.objectStore,
					kb: runtime.kb,
					robot: runtime.robot
				}));
				return true;
			}
			if (method === "GET" && parts[1] === "kb" && parts[2] === "status") {
				sendJson$2(res, 200, await describeKnowledgeBase(runtime.kb, runtime.config.data, { memorySlot: runtime.config.plugins?.slots?.memory }));
				return true;
			}
			if (method === "POST" && parts[1] === "kb" && parts[2] === "flush") {
				if (typeof runtime.kb.flush !== "function") {
					sendJson$2(res, 200, {
						flushed: false,
						note: "KB provider has no flush hook"
					});
					return true;
				}
				await runtime.kb.flush();
				sendJson$2(res, 200, { flushed: true });
				return true;
			}
			if (method === "GET" && parts[1] === "kb" && parts[2] === "search") {
				const url = new URL(req.url ?? "/", "http://localhost");
				const q = url.searchParams.get("q") ?? "";
				sendJson$2(res, 200, { results: await runtime.kb.search(q, {
					limit: Number(url.searchParams.get("limit") ?? 5),
					namespace: url.searchParams.get("namespace") ?? void 0
				}) });
				return true;
			}
			if (method === "POST" && parts[1] === "kb" && parts[2] === "ingest" && !parts[3]) {
				const body = await readJsonBody(req);
				if (!body.text) {
					badRequest(res, "text is required");
					return true;
				}
				await runtime.kb.ingest(body.text, {
					namespace: body.namespace,
					source: body.source
				});
				sendJson$2(res, 201, { ingested: true });
				return true;
			}
			if (method === "POST" && parts[1] === "kb" && parts[2] === "ingest" && parts[3] === "folder") {
				if (!await requireWrite("kb:ingest:folder")) return true;
				const body = await readJsonBody(req);
				if (!body.folder_path) {
					badRequest(res, "folder_path is required");
					return true;
				}
				const allowedExts = new Set((body.file_types ?? [
					".txt",
					".md",
					".markdown",
					".json",
					".csv",
					".yaml",
					".yml"
				]).map((e) => e.startsWith(".") ? e : `.${e}`));
				const results = [];
				const collectFiles = (dir) => {
					try {
						return readdirSync(dir).flatMap((entry) => {
							const full = join(dir, entry);
							try {
								const st = statSync(full);
								if (st.isDirectory() && body.recursive !== false) return collectFiles(full);
								if (st.isFile() && allowedExts.has(extname(entry).toLowerCase())) return [full];
							} catch {}
							return [];
						});
					} catch {
						return [];
					}
				};
				const files = collectFiles(body.folder_path);
				for (const file of files) try {
					const text = readFileSync(file, "utf-8");
					const source = body.source_prefix ? `${body.source_prefix}/${file.slice(body.folder_path.length + 1)}` : file;
					await runtime.kb.ingest(text, {
						namespace: body.namespace,
						source
					});
					results.push({
						file,
						status: "ok"
					});
				} catch (err) {
					results.push({
						file,
						status: "error",
						reason: err instanceof Error ? err.message : String(err)
					});
				}
				sendJson$2(res, 201, {
					ingested: results.filter((r) => r.status === "ok").length,
					errors: results.filter((r) => r.status === "error").length,
					total: files.length,
					results
				});
				return true;
			}
			if (method === "GET" && parts[1] === ".well-known" && parts[2] === "agent.json") {
				sendJson$2(res, 200, buildA2aAgentCard(runtime));
				return true;
			}
			if (method === "GET" && parts[1] === "evolution" && parts[2] === "export") {
				if (!await requireRead()) return true;
				const exportUrl = new URL(req.url ?? "/", "http://localhost");
				const days = parseInt(String(exportUrl.searchParams.get("days") ?? "30"), 10) || 30;
				sendJson$2(res, 200, await runtime.evolutionSync?.exportEvolutionData(days) ?? {
					events: [],
					cases: [],
					feedback: []
				});
				return true;
			}
			if (method === "POST" && parts[1] === "evolution" && parts[2] === "import") {
				if (!await requireWrite("evolution:import")) return true;
				const pack = await readJsonBody(req);
				if (!runtime.evolutionSync) {
					sendJson$2(res, 503, { error: "evolutionSync 未初始化" });
					return true;
				}
				sendJson$2(res, 200, await runtime.evolutionSync.importEvolutionPack(pack));
				return true;
			}
			if (method === "GET" && parts[1] === "events" && parts[2] === "stream") {
				if (!await requireRead()) return true;
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no"
				});
				const rawBusSub = runtime.kernel.bus.subscribe("*", async (event) => {
					try {
						const data = JSON.stringify({
							type: event.type,
							source: event.source,
							payload: event.payload,
							ts: event.timestamp
						});
						res.write(`data: ${data}\n\n`);
					} catch {}
				});
				req.on("close", () => rawBusSub());
				req.on("aborted", () => rawBusSub());
				const hbInterval = setInterval(() => {
					try {
						res.write(": heartbeat\n\n");
					} catch {
						clearInterval(hbInterval);
					}
				}, 3e4);
				req.on("close", () => clearInterval(hbInterval));
				return true;
			}
			if (method === "GET" && parts[1] === "hitl" && parts[2] === "pending") {
				sendJson$2(res, 200, { pending: (await runtime.playbookEngine.listRuns({
					status: "waiting_hitl",
					limit: 50
				})).map((run) => ({
					run_id: run.id,
					playbook_id: run.playbookId,
					started_at: run.startedAt,
					waiting_step_id: run.steps.find((s) => s.status === "waiting")?.stepId ?? null,
					steps: run.steps
				})) });
				return true;
			}
			if (method === "POST" && parts[1] === "hitl" && parts[2] && parts[3] === "resolve") {
				if (!await requireWrite(`hitl:${parts[2]}`)) return true;
				const runId = parts[2];
				const body = await readJsonBody(req);
				if (!body.decision) {
					badRequest(res, "decision is required");
					return true;
				}
				let stepId = body.step_id;
				if (!stepId) {
					const run = await runtime.playbookEngine.getRun(runId);
					if (!run) {
						sendJson$2(res, 404, {
							error: "Run not found",
							code: "NOT_FOUND"
						});
						return true;
					}
					stepId = run.steps.find((s) => s.status === "waiting")?.stepId;
					if (!stepId) {
						badRequest(res, "No waiting step found on run; provide step_id explicitly");
						return true;
					}
				}
				sendJson$2(res, 200, await runtime.playbookEngine.submitHitlDecision(runId, stepId, body.decision, body.comment));
				return true;
			}
			notFound(res);
			return true;
		} catch (err) {
			sendJson$2(res, 500, {
				error: err instanceof Error ? err.message : String(err),
				code: "INTERNAL_ERROR"
			});
			return true;
		}
	};
}
//#endregion
//#region src/interfaces/rest/studio.ts
const studioHtmlPath = join(fileURLToPath(new URL(".", import.meta.url)), "../../../../../studio/index.html");
let cachedHtml = null;
async function serveClaworksStudio(req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== "/studio" && url.pathname !== "/studio/") return false;
	if (!cachedHtml) cachedHtml = await readFile(studioHtmlPath, "utf8");
	res.statusCode = 200;
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.end(cachedHtml);
	return true;
}
//#endregion
//#region src/interfaces/a2a/task-store.ts
var A2aTaskStore = class {
	constructor() {
		this.tasks = /* @__PURE__ */ new Map();
		this.observers = /* @__PURE__ */ new Map();
	}
	create(req) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const task = {
			id: randomUUID(),
			status: "submitted",
			createdAt: now,
			updatedAt: now,
			message: req.message,
			metadata: req.metadata
		};
		this.tasks.set(task.id, task);
		return task;
	}
	get(taskId) {
		return this.tasks.get(taskId);
	}
	update(taskId, patch, delta) {
		const task = this.tasks.get(taskId);
		if (!task) return;
		const next = {
			...task,
			...patch,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.tasks.set(taskId, next);
		this._notifyObservers(taskId, next, delta);
		return next;
	}
	setStatus(taskId, status) {
		return this.update(taskId, { status });
	}
	/** 推送流式 delta（不修改任务状态，只通知观察者） */
	pushDelta(taskId, delta) {
		const task = this.tasks.get(taskId);
		if (!task) return;
		this._notifyObservers(taskId, task, delta);
	}
	list(limit = 50) {
		return [...this.tasks.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
	}
	/** 订阅指定任务的变更通知，返回取消订阅函数 */
	subscribe(taskId, observer) {
		let set = this.observers.get(taskId);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.observers.set(taskId, set);
		}
		set.add(observer);
		return () => {
			set?.delete(observer);
			if (set?.size === 0) this.observers.delete(taskId);
		};
	}
	_notifyObservers(taskId, task, delta) {
		const set = this.observers.get(taskId);
		if (!set) return;
		for (const obs of set) try {
			obs(task, delta);
		} catch {}
	}
};
//#endregion
//#region src/interfaces/a2a/task-handler.ts
function readA2aPeerHeader(req) {
	const raw = req.headers["x-claworks-peer"];
	if (typeof raw === "string" && raw.trim()) return raw.trim();
	if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
}
function extractText(message) {
	return message.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
}
function createA2aHttpHandler(deps) {
	const store = "store" in deps ? deps.store ?? new A2aTaskStore() : new A2aTaskStore();
	const resolveRuntime = () => {
		if (typeof deps === "function") return deps();
		return deps.runtime;
	};
	const resolveBaseUrl = (runtime) => {
		if (typeof deps === "function") return;
		return deps.baseUrl ?? runtime.robot.endpoint;
	};
	return async (req, res) => {
		const runtime = resolveRuntime();
		if (!runtime) {
			sendJson$2(res, 503, {
				error: "ClaWorks runtime not ready",
				code: "NOT_READY"
			});
			return true;
		}
		const method = req.method ?? "GET";
		const parts = parsePath(req.url ?? "/");
		if (parts[0] !== "a2a") return false;
		try {
			if (method === "GET" && parts[1] === "tasks" && !parts[2]) {
				sendJson$2(res, 200, { tasks: store.list() });
				return true;
			}
			if (method === "GET" && parts[1] === "tasks" && parts[2]) {
				const task = store.get(parts[2]);
				if (!task) {
					notFound(res);
					return true;
				}
				sendJson$2(res, 200, task);
				return true;
			}
			if (method === "POST" && parts[1] === "tasks" && parts[2] === "send") {
				const body = await readJsonBody(req);
				if (!body.message?.parts?.length) {
					badRequest(res, "message.parts is required");
					return true;
				}
				const task = store.create(body);
				store.setStatus(task.id, "working");
				const headerPeer = readA2aPeerHeader(req);
				const meta = {
					...body.metadata,
					...headerPeer ? { peer_id: headerPeer } : {}
				};
				processA2aTask(runtime, store, task.id, {
					...body,
					metadata: meta
				}).catch((err) => {
					store.update(task.id, {
						status: "failed",
						error: err instanceof Error ? err.message : String(err)
					});
				});
				sendJson$2(res, 202, store.get(task.id));
				return true;
			}
			if (method === "GET" && parts[1] === "agent-card") {
				sendJson$2(res, 200, buildA2aAgentCard(runtime, resolveBaseUrl(runtime)));
				return true;
			}
			notFound(res);
			return true;
		} catch (err) {
			sendJson$2(res, 500, {
				error: err instanceof Error ? err.message : String(err),
				code: "INTERNAL_ERROR"
			});
			return true;
		}
	};
}
async function processA2aTask(runtime, store, taskId, req) {
	const meta = req.metadata ?? {};
	const text = extractText(req.message);
	const peerResolved = resolveA2aPeer(meta, runtime.config.a2a?.peers ?? []);
	if ("error" in peerResolved) {
		store.update(taskId, {
			status: "failed",
			error: peerResolved.error
		});
		return;
	}
	if (typeof meta.playbook_id === "string" && meta.playbook_id) {
		const rbac = checkA2aPeerRbac(runtime, peerResolved, "a2a.delegate", `playbook:${meta.playbook_id}`);
		if (!rbac.allowed) {
			store.update(taskId, {
				status: "failed",
				error: rbac.reason
			});
			await runtime.kernel.publish("rbac.denied", "a2a", {
				action: "a2a.delegate",
				resource: `playbook:${meta.playbook_id}`,
				subject_type: "peer",
				subject_id: peerResolved.subjectId,
				reason: rbac.reason
			});
			return;
		}
		const input = meta.input && typeof meta.input === "object" && !Array.isArray(meta.input) ? meta.input : {
			message: text,
			...meta
		};
		const run = await runtime.playbookEngine.trigger(meta.playbook_id, input);
		store.update(taskId, {
			status: run.status === "failed" ? "failed" : "completed",
			result: {
				run_id: run.id,
				playbook_id: run.playbookId,
				status: run.status
			},
			error: run.error
		});
		return;
	}
	const eventType = typeof meta.event_type === "string" && meta.event_type ? meta.event_type : "a2a.message.received";
	const payload = meta.payload && typeof meta.payload === "object" && !Array.isArray(meta.payload) ? {
		...meta.payload,
		message: text
	} : {
		message: text,
		...meta
	};
	const source = typeof meta.source === "string" && meta.source ? meta.source : `a2a://${peerResolved.peerId}`;
	const rbac = checkA2aPeerRbac(runtime, peerResolved, "event.publish", eventType);
	if (!rbac.allowed) {
		store.update(taskId, {
			status: "failed",
			error: rbac.reason
		});
		await runtime.kernel.publish("rbac.denied", "a2a", {
			action: "event.publish",
			resource: eventType,
			subject_type: "peer",
			subject_id: peerResolved.subjectId,
			reason: rbac.reason
		});
		return;
	}
	const matches = await runtime.kernel.publish(eventType, source, payload, typeof meta.correlation_id === "string" ? { correlationId: meta.correlation_id } : void 0);
	store.update(taskId, {
		status: "completed",
		result: {
			event_type: eventType,
			matched_playbooks: matches.map((m) => m.playbookId)
		}
	});
}
//#endregion
//#region src/interfaces/mcp/mcp-auth.ts
const MCP_READ_TOOLS = new Set([
	"cw_kb_status",
	"cw_kb_search",
	"cw_kb_list_documents",
	"cw_kb_get_document",
	"cw_kb_lint_document",
	"cw_query_objects",
	"cw_list_playbooks",
	"cw_health",
	"cw_get_identity",
	"cw_list_runs",
	"cw_get_run",
	"list_pending_hitl",
	"get_alarm_summary",
	"list_object_types",
	"search_kb",
	"query_objects"
]);
function resolveMcpAuth(req, runtime) {
	return resolveAuthContext(req, runtime);
}
function mcpToolWriteResource(toolName, args) {
	switch (toolName) {
		case "cw_trigger_playbook": return `playbook:${String(args.playbook_id ?? "*")}`;
		case "cw_publish_event": return String(args.event_type ?? args.type ?? "*");
		case "cw_reload_packs": return "pack:*";
		case "cw_kb_ingest": return "kb:ingest";
		case "cw_kb_flush": return "kb:flush";
		case "cw_kb_ingest_folder": return "kb:ingest:folder";
		case "cw_kb_ingest_document":
		case "cw_kb_create_ingest_job":
		case "cw_kb_process_ingest_job": return "kb:ingest";
		case "cw_kb_publish": return "kb:publish";
		case "cw_agent_chat": return "agent:chat";
		case "cw_bridge_im_message": return "playbook:classify_im_to_business_event";
		case "cw_submit_hitl": return `hitl:${String(args.run_id ?? "*")}`;
		case "ingest_kb_text": return "kb:ingest";
		default: return `mcp:${toolName}`;
	}
}
function checkMcpToolAuth(runtime, auth, toolName, args) {
	if (MCP_READ_TOOLS.has(toolName)) return { allowed: true };
	const resource = mcpToolWriteResource(toolName, args);
	return checkRbac(runtime, auth, toolName === "cw_bridge_im_message" ? "playbook.trigger" : toolName === "cw_publish_event" ? "event.publish" : toolName === "cw_trigger_playbook" ? "playbook.trigger" : "rest.write", resource);
}
async function publishMcpRbacDenied(runtime, auth, toolName, reason) {
	const resource = mcpToolWriteResource(toolName, {});
	await runtime.kernel.publish("rbac.denied", "mcp", {
		subject_type: auth.subjectType,
		subject_id: auth.subjectId,
		action: "rest.write",
		resource,
		tool: toolName,
		reason
	}, {
		subjectType: "system",
		subjectId: "rbac"
	}).catch(() => void 0);
}
//#endregion
//#region src/claworks/alarm-summary.ts
/** Aggregate active Alarm objects (best-effort; type must exist in ontology). */
async function buildAlarmSummary(runtime, stationId) {
	if (!runtime.ontology.listTypes().map((t) => t.name).includes("Alarm")) return {
		total: 0,
		by_severity: {},
		station_id: stationId ?? null
	};
	const { items } = await runtime.objectStore.query("Alarm", { limit: 500 });
	const active = (stationId ? items.filter((row) => {
		const sid = row.station_id ?? row.stationId;
		return sid === void 0 || String(sid) === stationId;
	}) : items).filter((row) => {
		const status = row.status ?? row.state;
		if (status === void 0) return true;
		const s = String(status).toLowerCase();
		return s !== "closed" && s !== "resolved" && s !== "cleared";
	});
	const by_severity = {};
	for (const row of active) {
		const key = String(row.severity ?? row.priority ?? "unknown");
		by_severity[key] = (by_severity[key] ?? 0) + 1;
	}
	return {
		total: active.length,
		by_severity,
		station_id: stationId ?? null
	};
}
//#endregion
//#region src/planes/data/kb-folder-ingest.ts
const DEFAULT_EXTENSIONS = [
	".txt",
	".md",
	".markdown",
	".json",
	".csv",
	".yaml",
	".yml"
];
function normalizeExtensions(fileTypes) {
	return new Set((fileTypes ?? DEFAULT_EXTENSIONS).map((e) => e.startsWith(".") ? e : `.${e}`));
}
function collectFiles(dir, recursive, allowedExts) {
	try {
		return readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			try {
				const st = statSync(full);
				if (st.isDirectory() && recursive) return collectFiles(full, recursive, allowedExts);
				if (st.isFile() && allowedExts.has(extname(entry).toLowerCase())) return [full];
			} catch {}
			return [];
		});
	} catch {
		return [];
	}
}
/** Batch-ingest text files from a folder into the knowledge base. */
async function ingestKbFolder(kb, opts) {
	const folderPath = opts.folder_path.trim();
	if (!folderPath) throw new Error("folder_path is required");
	const files = collectFiles(folderPath, opts.recursive !== false, normalizeExtensions(opts.file_types));
	const results = [];
	for (const file of files) try {
		const text = readFileSync(file, "utf-8");
		const source = opts.source_prefix ? `${opts.source_prefix}/${file.slice(folderPath.length + 1)}` : file;
		await kb.ingest(text, {
			namespace: opts.namespace,
			source
		});
		results.push({
			file,
			status: "ok"
		});
	} catch (err) {
		results.push({
			file,
			status: "error",
			reason: err instanceof Error ? err.message : String(err)
		});
	}
	if (typeof kb.flush === "function") await kb.flush();
	return {
		ingested: results.filter((r) => r.status === "ok").length,
		errors: results.filter((r) => r.status === "error").length,
		total: files.length,
		results
	};
}
//#endregion
//#region src/interfaces/mcp/tools.ts
function requireDocumentKb(runtime) {
	if (!isDocumentKnowledgeBase(runtime.kb)) throw new Error("Document KB layer is required");
	return runtime.kb;
}
const CLAWORKS_MCP_TOOLS = [
	{
		name: "cw_publish_event",
		description: "Publish an event to the ClaWorks EventKernel",
		inputSchema: {
			type: "object",
			properties: {
				type: { type: "string" },
				source: { type: "string" },
				payload: { type: "object" }
			},
			required: ["type"]
		}
	},
	{
		name: "cw_trigger_playbook",
		description: "Trigger a playbook by id",
		inputSchema: {
			type: "object",
			properties: {
				playbook_id: { type: "string" },
				input: { type: "object" }
			},
			required: ["playbook_id"]
		}
	},
	{
		name: "cw_reload_packs",
		description: "Reload all installed packs from disk",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "cw_kb_status",
		description: "Describe knowledge base provider and vector configuration",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "cw_kb_search",
		description: "Search the knowledge base",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				limit: { type: "number" },
				namespace: { type: "string" },
				layer: { type: "string" }
			},
			required: ["query"]
		}
	},
	{
		name: "cw_kb_list_documents",
		description: "List KB documents with optional status/layer/namespace filters",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string" },
				layer: { type: "string" },
				namespace: { type: "string" },
				q: { type: "string" },
				limit: { type: "number" }
			}
		}
	},
	{
		name: "cw_kb_get_document",
		description: "Get a KB document by id including chunks",
		inputSchema: {
			type: "object",
			properties: { document_id: { type: "string" } },
			required: ["document_id"]
		}
	},
	{
		name: "cw_kb_ingest_document",
		description: "Ingest text as a draft or auto-published KB document",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string" },
				title: { type: "string" },
				source: { type: "string" },
				namespace: { type: "string" },
				layer: { type: "string" },
				doc_type: { type: "string" },
				auto_publish: { type: "boolean" }
			},
			required: ["text"]
		}
	},
	{
		name: "cw_kb_publish",
		description: "Publish a lint-clean KB document",
		inputSchema: {
			type: "object",
			properties: { document_id: { type: "string" } },
			required: ["document_id"]
		}
	},
	{
		name: "cw_kb_lint_document",
		description: "Lint a KB document before publish",
		inputSchema: {
			type: "object",
			properties: { document_id: { type: "string" } },
			required: ["document_id"]
		}
	},
	{
		name: "cw_kb_create_ingest_job",
		description: "Create a batch KB ingest job (folder, file, or inline text)",
		inputSchema: {
			type: "object",
			properties: {
				folder_path: { type: "string" },
				source_path: { type: "string" },
				text: { type: "string" },
				title: { type: "string" },
				source: { type: "string" },
				namespace: { type: "string" },
				layer: { type: "string" },
				doc_type: { type: "string" },
				auto_publish: { type: "boolean" }
			}
		}
	},
	{
		name: "cw_kb_process_ingest_job",
		description: "Process a pending KB ingest job",
		inputSchema: {
			type: "object",
			properties: { job_id: { type: "string" } },
			required: ["job_id"]
		}
	},
	{
		name: "cw_kb_ingest",
		description: "Ingest text into the knowledge base",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string" },
				namespace: { type: "string" },
				source: { type: "string" }
			},
			required: ["text"]
		}
	},
	{
		name: "cw_kb_flush",
		description: "Flush pending KB index updates (memory-core sync)",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "cw_kb_ingest_folder",
		description: "Batch-ingest files from a folder into the knowledge base",
		inputSchema: {
			type: "object",
			properties: {
				folder_path: { type: "string" },
				namespace: { type: "string" },
				recursive: { type: "boolean" },
				source_prefix: { type: "string" }
			},
			required: ["folder_path"]
		}
	},
	{
		name: "cw_agent_chat",
		description: "Platform agent chat completion",
		inputSchema: {
			type: "object",
			properties: {
				messages: {
					type: "array",
					items: {
						type: "object",
						properties: {
							role: { type: "string" },
							content: { type: "string" }
						}
					}
				},
				model: { type: "string" }
			},
			required: ["messages"]
		}
	},
	{
		name: "cw_query_objects",
		description: "Query ObjectStore by type",
		inputSchema: {
			type: "object",
			properties: {
				type_name: { type: "string" },
				limit: { type: "number" }
			},
			required: ["type_name"]
		}
	},
	{
		name: "cw_list_playbooks",
		description: "List loaded playbooks",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "cw_health",
		description: "Robot health and doctor checks",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "cw_get_identity",
		description: "Get robot identity summary",
		inputSchema: {
			type: "object",
			properties: { include_agent_md: { type: "boolean" } }
		}
	},
	{
		name: "cw_bridge_im_message",
		description: "Bridge an IM message into ClaWorks EventKernel",
		inputSchema: {
			type: "object",
			properties: {
				channel: { type: "string" },
				message_id: { type: "string" },
				user_id: { type: "string" },
				text: { type: "string" },
				group_id: { type: "string" },
				extra: { type: "object" }
			},
			required: ["channel", "text"]
		}
	},
	{
		name: "cw_list_runs",
		description: "List playbook runs",
		inputSchema: {
			type: "object",
			properties: {
				playbook_id: { type: "string" },
				status: { type: "string" },
				limit: { type: "number" }
			}
		}
	},
	{
		name: "cw_get_run",
		description: "Get a single playbook run by id",
		inputSchema: {
			type: "object",
			properties: { run_id: { type: "string" } },
			required: ["run_id"]
		}
	},
	{
		name: "cw_submit_hitl",
		description: "Submit HITL decision for a waiting run",
		inputSchema: {
			type: "object",
			properties: {
				run_id: { type: "string" },
				step_id: { type: "string" },
				decision: { type: "string" },
				comment: { type: "string" }
			},
			required: [
				"run_id",
				"step_id",
				"decision"
			]
		}
	},
	{
		name: "list_pending_hitl",
		description: "List playbook runs awaiting human approval (remote bridge alias)",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "get_alarm_summary",
		description: "Active alarm counts by severity (remote bridge alias)",
		inputSchema: {
			type: "object",
			properties: { station_id: { type: "string" } }
		}
	},
	{
		name: "list_object_types",
		description: "List ontology object types (remote bridge alias)",
		inputSchema: {
			type: "object",
			properties: {}
		}
	},
	{
		name: "search_kb",
		description: "Search knowledge base (remote bridge alias)",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				limit: { type: "number" }
			},
			required: ["query"]
		}
	},
	{
		name: "query_objects",
		description: "Query ObjectStore (remote bridge alias)",
		inputSchema: {
			type: "object",
			properties: {
				type_name: { type: "string" },
				filters: { type: "object" },
				limit: { type: "number" }
			},
			required: ["type_name"]
		}
	},
	{
		name: "cw_list_capabilities",
		description: "List all registered robot capabilities with their schemas and constitution decisions",
		inputSchema: {
			type: "object",
			properties: {
				verb: {
					type: "string",
					description: "Filter by verb (query/deliver/control/...)"
				},
				owner_kind: {
					type: "string",
					description: "Filter by owner kind (core/pack/bridge)"
				}
			}
		}
	},
	{
		name: "cw_invoke_capability",
		description: "Invoke a registered capability by id with params, enforcing robot constitution",
		inputSchema: {
			type: "object",
			required: ["capability_id"],
			properties: {
				capability_id: { type: "string" },
				params: { type: "object" },
				source: {
					type: "string",
					description: "Caller source (mcp/rest/playbook/...)"
				},
				user_id: { type: "string" }
			}
		}
	},
	{
		name: "cw_check_constitution",
		description: "Check whether a capability would be allowed/hitl/denied by the robot constitution",
		inputSchema: {
			type: "object",
			required: ["capability_id"],
			properties: {
				capability_id: { type: "string" },
				source: { type: "string" },
				user_id: { type: "string" }
			}
		}
	}
];
async function callClaworksMcpTool(runtime, name, args) {
	if (name === "cw_list_capabilities" || name === "cw_invoke_capability" || name === "cw_check_constitution") {
		const { CapabilityDenied, CapabilityHitlRequired, CapabilityNotFound } = await import("./capability-registry-eV3L0kwC.mjs");
		switch (name) {
			case "cw_list_capabilities": {
				const all = runtime.capabilities.list();
				const verb = args.verb ? String(args.verb) : void 0;
				const ownerKind = args.owner_kind ? String(args.owner_kind) : void 0;
				const filtered = all.filter((c) => {
					if (verb && c.verb !== verb) return false;
					if (ownerKind && c.owner.kind !== ownerKind) return false;
					return true;
				});
				return {
					capabilities: filtered,
					total: filtered.length
				};
			}
			case "cw_invoke_capability": {
				const capId = String(args.capability_id ?? "");
				const params = args.params ?? {};
				const source = String(args.source ?? "mcp");
				const userId = args.user_id ? String(args.user_id) : void 0;
				const ctx = {
					source,
					subjectId: userId ?? "mcp:agent",
					subjectType: "mcp",
					invoke: (id, p) => runtime.capabilities.invoke(id, ctx, p, { constitutionCheck: {
						source,
						userId
					} }),
					logger: runtime.logger
				};
				try {
					return {
						status: "ok",
						result: await runtime.capabilities.invoke(capId, ctx, params, { constitutionCheck: {
							source,
							userId
						} })
					};
				} catch (err) {
					if (err instanceof CapabilityNotFound) return {
						status: "not_found",
						capability_id: capId
					};
					if (err instanceof CapabilityDenied) return {
						status: "denied",
						reason: err.message,
						tier: err.tier
					};
					if (err instanceof CapabilityHitlRequired) return {
						status: "hitl_required",
						reason: err.message,
						tier: err.tier
					};
					throw err;
				}
			}
			case "cw_check_constitution": return {
				capability_id: String(args.capability_id ?? ""),
				...runtime.constitution?.check(String(args.capability_id ?? ""), {
					source: args.source ? String(args.source) : void 0,
					userId: args.user_id ? String(args.user_id) : void 0
				}) ?? {
					action: "allow",
					tier: 0,
					reason: "constitution unavailable"
				}
			};
		}
	}
	switch (name) {
		case "cw_publish_event": {
			const publishResult = await applyIngressPublish(runtime, {
				source: "mcp",
				eventType: String(args.type ?? "custom.event"),
				subjectId: String(args.subject_id ?? "mcp:agent"),
				payload: args.payload ?? {},
				publishSource: String(args.source ?? "mcp"),
				subjectType: "system"
			});
			if (publishResult.action === "denied") return {
				action: "denied",
				reason: publishResult.reason
			};
			if (publishResult.action === "observe_only") return { action: "observe_only" };
			if (publishResult.action === "intent_routed") return {
				action: "intent_routed",
				playbook_id: publishResult.playbookId,
				run_id: publishResult.runId,
				status: publishResult.status
			};
			return {
				action: "published",
				event_type: publishResult.eventType,
				matched_playbooks: publishResult.matchedPlaybooks
			};
		}
		case "cw_trigger_playbook": {
			const run = await runtime.playbookEngine.trigger(String(args.playbook_id ?? ""), args.input ?? {});
			return {
				run_id: run.id,
				status: run.status
			};
		}
		case "cw_reload_packs": {
			const { packs } = await reloadClaworksPacksFromDisk(runtime);
			return {
				status: "ok",
				total: packs.length,
				pack_ids: packs.map((p) => p.manifest.id)
			};
		}
		case "cw_kb_status": return describeKnowledgeBase(runtime.kb, runtime.config.data);
		case "cw_kb_search": return { results: await runtime.kb.search(String(args.query ?? ""), {
			limit: typeof args.limit === "number" ? args.limit : 5,
			namespace: args.namespace ? String(args.namespace) : void 0,
			layer: args.layer ? String(args.layer) : void 0
		}) };
		case "cw_kb_list_documents": return { documents: await requireDocumentKb(runtime).listDocuments({
			status: args.status ? String(args.status) : void 0,
			layer: args.layer ? String(args.layer) : void 0,
			namespace: args.namespace ? String(args.namespace) : void 0,
			q: args.q ? String(args.q) : void 0,
			limit: typeof args.limit === "number" ? args.limit : void 0
		}) };
		case "cw_kb_get_document": {
			const document = await requireDocumentKb(runtime).getDocument(String(args.document_id ?? ""));
			if (!document) throw new Error(`Document not found: ${args.document_id}`);
			return { document };
		}
		case "cw_kb_ingest_document": {
			const text = String(args.text ?? "");
			if (!text.trim()) throw new Error("text is required");
			return { document: await requireDocumentKb(runtime).ingestDocument({
				text,
				title: args.title ? String(args.title) : void 0,
				source: args.source ? String(args.source) : void 0,
				namespace: args.namespace ? String(args.namespace) : void 0,
				layer: args.layer ? String(args.layer) : void 0,
				doc_type: args.doc_type ? String(args.doc_type) : void 0,
				auto_publish: args.auto_publish === true
			}) };
		}
		case "cw_kb_publish": return { document: await requireDocumentKb(runtime).publishDocument(String(args.document_id ?? "")) };
		case "cw_kb_lint_document": return requireDocumentKb(runtime).lintDocument(String(args.document_id ?? ""));
		case "cw_kb_create_ingest_job": return { job: requireDocumentKb(runtime).createIngestJob({
			folder_path: args.folder_path ? String(args.folder_path) : void 0,
			source_path: args.source_path ? String(args.source_path) : void 0,
			text: args.text ? String(args.text) : void 0,
			title: args.title ? String(args.title) : void 0,
			source: args.source ? String(args.source) : void 0,
			namespace: args.namespace ? String(args.namespace) : void 0,
			layer: args.layer ? String(args.layer) : void 0,
			doc_type: args.doc_type ? String(args.doc_type) : void 0,
			auto_publish: args.auto_publish === true
		}) };
		case "cw_kb_process_ingest_job": return { job: await requireDocumentKb(runtime).processIngestJob(String(args.job_id ?? "")) };
		case "cw_kb_ingest": {
			const text = String(args.text ?? "");
			await runtime.kb.ingest(text, {
				namespace: args.namespace ? String(args.namespace) : void 0,
				source: args.source ? String(args.source) : void 0
			});
			return { ingested: true };
		}
		case "cw_kb_flush":
			if (typeof runtime.kb.flush !== "function") return {
				flushed: false,
				note: "KB provider has no flush hook"
			};
			await runtime.kb.flush();
			return { flushed: true };
		case "cw_kb_ingest_folder": return ingestKbFolder(runtime.kb, {
			folder_path: String(args.folder_path ?? ""),
			namespace: args.namespace ? String(args.namespace) : void 0,
			recursive: args.recursive !== false,
			source_prefix: args.source_prefix ? String(args.source_prefix) : void 0
		});
		case "cw_agent_chat": {
			if (!runtime.llmComplete) throw new Error("LLM not configured on this robot");
			const lastUser = [...args.messages ?? []].reverse().find((m) => m.role === "user")?.content?.trim();
			if (!lastUser) throw new Error("messages must include at least one user message");
			return { message: {
				role: "assistant",
				content: (await runtime.llmComplete({
					prompt: lastUser,
					model: args.model ? String(args.model) : void 0
				})).text
			} };
		}
		case "cw_query_objects": {
			const { items } = await runtime.objectStore.query(String(args.type_name ?? "WorkOrder"), { limit: typeof args.limit === "number" ? args.limit : 20 });
			return { items };
		}
		case "cw_list_playbooks": return { playbooks: runtime.playbookEngine.list().map((p) => ({
			id: p.id,
			name: p.name,
			pack: p.pack,
			priority: p.priority
		})) };
		case "cw_health": {
			const { buildHealthPayload } = await import("./health-CG_tPxO-.mjs");
			return buildHealthPayload(runtime);
		}
		case "cw_get_identity":
			if (args.include_agent_md === true) return {
				...runtime.identity,
				robot: runtime.robot,
				agent_md: runtime.identity.agentMd
			};
			return {
				name: runtime.identity.name,
				role: runtime.identity.role,
				domain: runtime.identity.domain,
				rules: runtime.identity.rules,
				owner: runtime.identity.owner,
				robot: runtime.robot
			};
		case "cw_bridge_im_message": return bridgeImMessage(runtime, {
			channel: String(args.channel ?? "mcp"),
			messageId: String(args.message_id ?? `mcp-${Date.now()}`),
			userId: String(args.user_id ?? "mcp:user"),
			text: String(args.text ?? ""),
			groupId: args.group_id ? String(args.group_id) : void 0,
			extra: args.extra
		});
		case "cw_list_runs": return { runs: await runtime.playbookEngine.listRuns({
			playbookId: args.playbook_id ? String(args.playbook_id) : void 0,
			status: args.status ? String(args.status) : void 0,
			limit: typeof args.limit === "number" ? args.limit : 50
		}) };
		case "cw_get_run": {
			const run = await runtime.playbookEngine.getRun(String(args.run_id ?? ""));
			if (!run) throw new Error(`Run not found: ${args.run_id}`);
			return run;
		}
		case "cw_submit_hitl": {
			const run = await runtime.playbookEngine.submitHitlDecision(String(args.run_id ?? ""), String(args.step_id ?? ""), String(args.decision ?? ""), args.comment ? String(args.comment) : void 0);
			return {
				run_id: run.id,
				status: run.status
			};
		}
		case "list_pending_hitl": return { pending: (await runtime.playbookEngine.listRuns({
			status: "waiting_hitl",
			limit: 50
		})).map((run) => ({
			run_id: run.id,
			playbook_id: run.playbookId,
			waiting_step_id: run.steps.find((s) => s.status === "waiting")?.stepId ?? null
		})) };
		case "get_alarm_summary": return buildAlarmSummary(runtime, args.station_id ? String(args.station_id) : void 0);
		case "list_object_types":
		case "cw_list_types": return { types: runtime.ontology.listTypes().map((t) => ({
			name: t.name,
			pack: t.pack
		})) };
		case "search_kb": return { results: await runtime.kb.search(String(args.query ?? ""), { limit: typeof args.limit === "number" ? args.limit : 5 }) };
		case "query_objects": {
			const filter = args.filters && typeof args.filters === "object" && !Array.isArray(args.filters) ? args.filters : void 0;
			const { items } = await runtime.objectStore.query(String(args.type_name ?? "WorkOrder"), {
				limit: typeof args.limit === "number" ? args.limit : 20,
				filter
			});
			return { items };
		}
		default: throw new Error(`unknown tool: ${name}`);
	}
}
//#endregion
//#region src/interfaces/mcp/server.ts
function sendJson$1(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}
function jsonRpcResult(id, result) {
	return {
		jsonrpc: "2.0",
		id: id ?? null,
		result
	};
}
function jsonRpcError(id, code, message, data) {
	return {
		jsonrpc: "2.0",
		id: id ?? null,
		error: {
			code,
			message,
			data
		}
	};
}
function mcpToolsListPayload() {
	return { tools: CLAWORKS_MCP_TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema
	})) };
}
async function handleJsonRpc(runtime, body, req, res) {
	const { id, method, params } = body;
	const auth = resolveMcpAuth(req, runtime);
	if (!auth.authenticated) {
		sendJson$1(res, 401, jsonRpcError(id, -32001, "Unauthorized"));
		return;
	}
	try {
		if (method === "initialize") {
			sendJson$1(res, 200, jsonRpcResult(id, {
				protocolVersion: "2024-11-05",
				serverInfo: {
					name: "claworks-mcp",
					version: runtime.robot.version
				},
				capabilities: { tools: {} }
			}));
			return;
		}
		if (method === "tools/list") {
			sendJson$1(res, 200, jsonRpcResult(id, mcpToolsListPayload()));
			return;
		}
		if (method === "tools/call") {
			const name = String(params?.name ?? "");
			const args = params?.arguments ?? {};
			const rbac = checkMcpToolAuth(runtime, auth, name, args);
			if (!rbac.allowed) {
				await publishMcpRbacDenied(runtime, auth, name, rbac.reason);
				sendJson$1(res, 200, jsonRpcError(id, -32003, "Forbidden", {
					code: "RBAC_DENIED",
					reason: rbac.reason
				}));
				return;
			}
			const result = await callClaworksMcpTool(runtime, name, args);
			sendJson$1(res, 200, { ...jsonRpcResult(id, {
				content: [{
					type: "text",
					text: JSON.stringify(result, null, 2)
				}],
				isError: false
			}) });
			return;
		}
		sendJson$1(res, 200, jsonRpcError(id, -32601, `Method not found: ${method ?? ""}`));
	} catch (err) {
		sendJson$1(res, 200, jsonRpcError(id, -32603, err instanceof Error ? err.message : String(err)));
	}
}
function createMcpHttpHandler(getRuntime) {
	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith("/mcp") && !url.pathname.startsWith("/v1/mcp")) return false;
		const runtime = getRuntime();
		if (!runtime) {
			sendJson$1(res, 503, { error: "runtime not ready" });
			return true;
		}
		const auth = resolveMcpAuth(req, runtime);
		if (!auth.authenticated) {
			sendJson$1(res, 401, {
				error: "Unauthorized",
				code: "UNAUTHORIZED"
			});
			return true;
		}
		if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/mcp/" || url.pathname === "/v1/mcp" || url.pathname === "/v1/mcp/")) {
			const body = await readBody(req);
			if (body.jsonrpc === "2.0" && body.method) {
				await handleJsonRpc(runtime, body, req, res);
				return true;
			}
			sendJson$1(res, 400, jsonRpcError(body.id, -32600, "Invalid JSON-RPC request"));
			return true;
		}
		if (req.method === "POST" && (url.pathname === "/mcp/tools/list" || url.pathname === "/v1/mcp/tools/list")) {
			sendJson$1(res, 200, { tools: CLAWORKS_MCP_TOOLS });
			return true;
		}
		if (req.method === "POST" && (url.pathname === "/mcp/tools/call" || url.pathname === "/v1/mcp/tools/call")) {
			const body = await readBody(req);
			const name = body.name ?? "";
			const args = body.arguments ?? {};
			const rbac = checkMcpToolAuth(runtime, auth, name, args);
			if (!rbac.allowed) {
				await publishMcpRbacDenied(runtime, auth, name, rbac.reason);
				sendJson$1(res, 403, {
					error: "Forbidden",
					code: "RBAC_DENIED",
					reason: rbac.reason
				});
				return true;
			}
			try {
				const result = await callClaworksMcpTool(runtime, name, args);
				sendJson$1(res, 200, { content: [{
					type: "text",
					text: JSON.stringify(result, null, 2)
				}] });
				return true;
			} catch (err) {
				sendJson$1(res, 500, { error: err instanceof Error ? err.message : String(err) });
				return true;
			}
		}
		sendJson$1(res, 404, { error: "not found" });
		return true;
	};
}
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}
//#endregion
//#region src/interfaces/nexus/server.ts
function parseUrl(req) {
	return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}
async function createNexusServer(catalogRoot) {
	const state = {
		catalogRoot,
		entries: [],
		async refresh() {
			state.entries = await scanNexusCatalog(catalogRoot);
		},
		async listen(port, host = "127.0.0.1") {
			await state.refresh();
			const server = createServer((req, res) => {
				handleRequest(state, req, res);
			});
			await new Promise((resolve) => server.listen(port, host, resolve));
			return server;
		}
	};
	await state.refresh();
	return state;
}
async function handleRequest(state, req, res) {
	const url = parseUrl(req);
	const parts = url.pathname.split("/").filter(Boolean);
	try {
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "packages" && parts.length === 2) {
			sendJson(res, 200, { packages: listPackages(state.entries, {
				family: url.searchParams.get("family") ?? void 0,
				q: url.searchParams.get("q") ?? void 0
			}) });
			return;
		}
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "packages" && parts.length === 3) {
			const detail = getPackageDetail(state.entries, parts[2]);
			if (!detail) {
				sendJson(res, 404, {
					error: "package not found",
					code: "NOT_FOUND"
				});
				return;
			}
			sendJson(res, 200, detail);
			return;
		}
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "packages" && parts[3] === "versions" && parts.length === 5) {
			const slug = parts[2];
			const version = parts[4];
			const pack = resolvePackDir(state.entries, slug, version);
			if (!pack) {
				sendJson(res, 404, {
					error: "version not found",
					code: "NOT_FOUND"
				});
				return;
			}
			sendJson(res, 200, {
				slug,
				version,
				manifest: pack.manifest
			});
			return;
		}
		if (req.method === "GET" && parts[0] === "api" && parts[1] === "packages" && parts[3] === "versions" && parts[5] === "artifacts" && parts.length === 7) {
			const slug = parts[2];
			const version = parts[4];
			const hostKey = parts[6];
			const pack = resolvePackDir(state.entries, slug, version);
			if (!pack) {
				sendJson(res, 404, {
					error: "artifact not found",
					code: "NOT_FOUND"
				});
				return;
			}
			if (hostKey !== "generic" && hostKey !== "pack.tgz") {
				sendJson(res, 404, {
					error: `unknown artifact hostKey: ${hostKey}`,
					code: "NOT_FOUND"
				});
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/gzip");
			res.setHeader("Content-Disposition", `attachment; filename="${slug}-${version}.tar.gz"`);
			await pipeline(openPackArtifactStream(pack.dir), res);
			return;
		}
		if (req.method === "GET" && parts[0] === "health") {
			sendJson(res, 200, {
				status: "ok",
				packs: state.entries.length,
				catalog: state.catalogRoot
			});
			return;
		}
		sendJson(res, 404, {
			error: "Not found",
			code: "NOT_FOUND"
		});
	} catch (err) {
		sendJson(res, 500, {
			error: err instanceof Error ? err.message : String(err),
			code: "INTERNAL_ERROR"
		});
	}
}
//#endregion
export { createA2aHttpHandler as a, createClaworksRestHandler as c, parsePath as d, readJsonBody as f, resolveAuthContext as g, checkRbac as h, callClaworksMcpTool as i, badRequest as l, checkClaworksApiAuth as m, createMcpHttpHandler as n, A2aTaskStore as o, sendJson$2 as p, CLAWORKS_MCP_TOOLS as r, serveClaworksStudio as s, createNexusServer as t, notFound as u };

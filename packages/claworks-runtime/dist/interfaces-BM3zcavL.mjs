import { a as listObservationEvents, i as listDecisionLog, s as prometheusMetricsText } from "./client-sSruxTff.mjs";
import { E as applyIngressPublish, S as buildHealthPayload, T as runClaworksDoctor, _ as bridgeImMessage, b as resolveA2aPeer, d as reloadClaworksPacksFromDisk, g as updateClaworksPack, h as uninstallClaworksPack, i as installClaworksPack, m as searchNexusPackages, t as buildA2aAgentCard, y as checkA2aPeerRbac } from "./agent-card-COf94zUM.mjs";
import { c as listPackages, d as scanNexusCatalog, l as openPackArtifactStream, s as getPackageDetail, u as resolvePackDir } from "./pack-loader-ttcUSOdi.mjs";
import { dirname, extname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
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
function resolveAuthContext(req, runtime) {
	const expected = runtime.config.api?.api_key?.trim();
	const header = req.headers.authorization ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	const channelUser = readChannelUserHeader(req);
	if (!expected) {
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
	if (token === expected) {
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
//#region src/interfaces/rest/router.ts
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
				const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync-CZlL_vuW.mjs").then((n) => n.t);
				await syncRbacFromObjectStore(runtime);
				await syncIngressFromObjectStore(runtime);
				sendJson$2(res, 200, {
					status: "ok",
					reloaded_at: (/* @__PURE__ */ new Date()).toISOString()
				});
				return true;
			}
			if (method === "GET" && parts[1] === "metrics") {
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/plain; version=0.0.4");
				res.end(prometheusMetricsText(runtime.robot.name));
				return true;
			}
			if (method === "GET" && parts[1] === "decision-log") {
				const url = new URL(req.url ?? "/", "http://localhost");
				sendJson$2(res, 200, { entries: listDecisionLog(Number(url.searchParams.get("limit") ?? 50)) });
				return true;
			}
			if (method === "GET" && parts[1] === "observation-events") {
				const url = new URL(req.url ?? "/", "http://localhost");
				sendJson$2(res, 200, { events: listObservationEvents(Number(url.searchParams.get("limit") ?? 50)) });
				return true;
			}
			if (method === "POST" && parts[1] === "doctor") {
				sendJson$2(res, 200, { checks: runClaworksDoctor(runtime) });
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
				const { reloadClaworksPacksFromDisk } = await import("./agent-card-COf94zUM.mjs").then((n) => n.s);
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
				const publishResult = await applyIngressPublish(runtime, {
					source: "rest",
					eventType: body.type,
					subjectId: auth.subjectId,
					payload: body.payload ?? {},
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
				const { bridgeWebhookPayload } = await import("./webhook-bridge-CAdM-3RL.mjs").then((n) => n.n);
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
				const { bridgeImMessage } = await import("./agent-card-COf94zUM.mjs").then((n) => n.v);
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
	update(taskId, patch) {
		const task = this.tasks.get(taskId);
		if (!task) return;
		const next = {
			...task,
			...patch,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		this.tasks.set(taskId, next);
		return next;
	}
	setStatus(taskId, status) {
		return this.update(taskId, { status });
	}
	list(limit = 50) {
		return [...this.tasks.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
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
//#region src/interfaces/mcp/tools.ts
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
		name: "cw_kb_search",
		description: "Search the knowledge base",
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
	}
];
async function callClaworksMcpTool(runtime, name, args) {
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
		case "cw_kb_search": return { results: await runtime.kb.search(String(args.query ?? ""), { limit: typeof args.limit === "number" ? args.limit : 5 }) };
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
			const { buildHealthPayload } = await import("./agent-card-COf94zUM.mjs").then((n) => n.C);
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
function createMcpHttpHandler(getRuntime) {
	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith("/mcp")) return false;
		const runtime = getRuntime();
		if (!runtime) {
			sendJson$1(res, 503, { error: "runtime not ready" });
			return true;
		}
		if (req.method === "POST" && url.pathname === "/mcp/tools/list") {
			sendJson$1(res, 200, { tools: CLAWORKS_MCP_TOOLS });
			return true;
		}
		if (req.method === "POST" && url.pathname === "/mcp") {
			const rpc = await readBody(req);
			if (rpc.jsonrpc === "2.0") {
				if (rpc.method === "tools/list") {
					sendJson$1(res, 200, {
						jsonrpc: "2.0",
						id: rpc.id,
						result: { tools: CLAWORKS_MCP_TOOLS }
					});
					return true;
				}
				if (rpc.method === "tools/call") {
					const params = rpc.params ?? {};
					const name = params.name ?? "";
					const args = params.arguments ?? {};
					try {
						const result = await callClaworksMcpTool(runtime, name, args);
						sendJson$1(res, 200, {
							jsonrpc: "2.0",
							id: rpc.id,
							result: { content: [{
								type: "text",
								text: JSON.stringify(result, null, 2)
							}] }
						});
					} catch (err) {
						sendJson$1(res, 200, {
							jsonrpc: "2.0",
							id: rpc.id,
							error: {
								code: -32e3,
								message: err instanceof Error ? err.message : String(err)
							}
						});
					}
					return true;
				}
				sendJson$1(res, 200, {
					jsonrpc: "2.0",
					id: rpc.id,
					error: {
						code: -32601,
						message: "Method not found"
					}
				});
				return true;
			}
		}
		if (req.method === "POST" && url.pathname === "/mcp/tools/call") {
			const body = await readBody(req);
			const name = body.name ?? "";
			const args = body.arguments ?? {};
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

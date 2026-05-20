import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { runClaworksDoctor } from "../../claworks/doctor.js";
import { buildHealthPayload } from "../../claworks/health.js";
import { applyIngressPublish } from "../../claworks/ingress-publish.js";
import {
  listDecisionLog,
  listObservationEvents,
  prometheusMetricsText,
} from "../../claworks/observability.js";
import {
  installClaworksPack,
  reloadClaworksPacksFromDisk,
  searchNexusPackages,
  uninstallClaworksPack,
  updateClaworksPack,
} from "../../claworks/pack-runtime.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { buildA2aAgentCard } from "../a2a/agent-card.js";
import { resolveAuthContext, checkRbac } from "./auth.js";
import { badRequest, notFound, parsePath, readJsonBody, sendJson } from "./http-utils.js";

export function createClaworksRestHandler(
  runtime: ClaworksRuntime,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const method = req.method ?? "GET";
    const parts = parsePath(req.url ?? "/");

    if (parts[0] !== "v1") {
      return false;
    }

    const auth = resolveAuthContext(req, runtime);
    if (!auth.authenticated) {
      sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      return true;
    }

    /** 写操作 RBAC helper（deny 时发 rbac.denied 事件并返回 403） */
    const requireWrite = async (resource: string): Promise<boolean> => {
      const rbacResult = checkRbac(runtime, auth, "rest.write", resource);
      if (!rbacResult.allowed) {
        // 发 rbac.denied 事件（Playbook 可捕获进行告警/升级）
        void runtime.kernel
          .publish(
            "rbac.denied",
            "rest",
            {
              subject_type: auth.subjectType,
              subject_id: auth.subjectId,
              action: "rest.write",
              resource,
              reason: rbacResult.reason,
            },
            { subjectType: "system", subjectId: "rbac" },
          )
          .catch(() => undefined);
        sendJson(res, 403, {
          error: "Forbidden",
          code: "RBAC_DENIED",
          reason: rbacResult.reason,
        });
        return false;
      }
      return true;
    };

    try {
      if (method === "GET" && parts[1] === "health") {
        sendJson(res, 200, buildHealthPayload(runtime));
        return true;
      }

      // GET /v1/identity — 机器人身份与规则（只读，无需写权限）
      if (method === "GET" && parts[1] === "identity") {
        sendJson(res, 200, {
          name: runtime.identity.name,
          role: runtime.identity.role,
          domain: runtime.identity.domain,
          description: runtime.identity.description,
          rules: runtime.identity.rules,
          robot: runtime.robot,
          rbac_policies_loaded: runtime.rbac !== undefined,
          ingress_policies_loaded: runtime.ingress !== undefined,
        });
        return true;
      }

      // GET /v1/identity/agent-md — 完整 robot.md 内容
      if (method === "GET" && parts[1] === "identity" && parts[2] === "agent-md") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.end(runtime.identity.agentMd);
        return true;
      }

      // POST /v1/rbac/reload — 手动触发 RBAC 策略从 ObjectStore 重新加载
      if (method === "POST" && parts[1] === "rbac" && parts[2] === "reload") {
        if (!(await requireWrite("rbac:*"))) {
          return true;
        }
        const { syncRbacFromObjectStore, syncIngressFromObjectStore } =
          await import("../../claworks/rbac-sync.js");
        await syncRbacFromObjectStore(runtime);
        await syncIngressFromObjectStore(runtime);
        sendJson(res, 200, { status: "ok", reloaded_at: new Date().toISOString() });
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
        const limit = Number(url.searchParams.get("limit") ?? 50);
        sendJson(res, 200, { entries: listDecisionLog(limit) });
        return true;
      }

      if (method === "GET" && parts[1] === "observation-events") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        sendJson(res, 200, { events: listObservationEvents(limit) });
        return true;
      }

      if (method === "POST" && parts[1] === "doctor") {
        sendJson(res, 200, { checks: runClaworksDoctor(runtime) });
        return true;
      }

      if (method === "GET" && parts[1] === "connectors") {
        sendJson(res, 200, { connectors: runtime.connectorManager.list() });
        return true;
      }

      if (method === "POST" && parts[1] === "connectors" && parts[2] && parts[3] === "invoke") {
        const body = (await readJsonBody(req)) as {
          method?: string;
          params?: Record<string, unknown>;
        };
        if (!body.method) {
          badRequest(res, "method is required");
          return true;
        }
        const result = await runtime.connectorManager.invoke(parts[2], body.method, body.params);
        sendJson(res, 200, {
          invoked: true,
          connector: parts[2],
          method: body.method,
          result,
        });
        return true;
      }

      if (method === "GET" && parts[1] === "packs" && parts[2] === "registry") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const q = url.searchParams.get("q") ?? undefined;
        const registry = await searchNexusPackages(runtime, q);
        sendJson(res, 200, registry);
        return true;
      }

      if (method === "GET" && parts[1] === "packs") {
        sendJson(res, 200, {
          packs: runtime.loadedPacks.map((p) => ({
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            path: p.path,
            playbooks: p.playbooks.length,
            objectTypes: p.objectTypes.length,
          })),
          registry: runtime.config.packs?.registry ?? process.env.CLAWORKS_NEXUS_URL ?? null,
        });
        return true;
      }

      if (method === "POST" && parts[1] === "packs" && parts[2] === "install") {
        const body = (await readJsonBody(req)) as { source?: string };
        if (!body.source) {
          badRequest(res, "source is required");
          return true;
        }
        const result = await installClaworksPack(runtime, body.source);
        sendJson(res, 201, {
          installed: result.installed,
          pack: {
            id: result.pack.manifest.id,
            version: result.pack.manifest.version,
            path: result.pack.path,
          },
        });
        return true;
      }

      if (method === "DELETE" && parts[1] === "packs" && parts[2]) {
        const installed = await uninstallClaworksPack(runtime, parts[2]);
        sendJson(res, 200, { uninstalled: parts[2], installed });
        return true;
      }

      if (method === "POST" && parts[1] === "packs" && parts[2] === "reload") {
        const result = await reloadClaworksPacksFromDisk(runtime);
        sendJson(res, 200, {
          reloaded: result.packs.map((p) => ({
            id: p.manifest.id,
            version: p.manifest.version,
          })),
        });
        return true;
      }

      if (method === "POST" && parts[1] === "packs" && parts[2] === "update") {
        const body = (await readJsonBody(req)) as { source?: string };
        if (!body.source) {
          badRequest(res, "source is required");
          return true;
        }
        const result = await updateClaworksPack(runtime, body.source);
        sendJson(res, 200, {
          updated: result.pack.manifest.id,
          version: result.pack.manifest.version,
          installed: result.installed,
        });
        return true;
      }

      if (method === "GET" && parts[1] === "playbooks") {
        if (parts[2] === undefined) {
          sendJson(res, 200, {
            playbooks: runtime.playbookEngine.list().map((p) => ({
              id: p.id,
              name: p.name,
              trigger: p.trigger,
              pack: p.pack,
              priority: p.priority,
            })),
          });
          return true;
        }
        if (parts[3] === "runs" && parts[2]) {
          const runs = await runtime.playbookEngine.listRuns({
            playbookId: parts[2],
            limit: 50,
          });
          sendJson(res, 200, { runs });
          return true;
        }
      }

      if (method === "POST" && parts[1] === "playbooks" && parts[3] === "runs" && parts[2]) {
        const body = (await readJsonBody(req)) as { input?: Record<string, unknown> };
        const run = await runtime.playbookEngine.trigger(parts[2], body.input ?? {});
        sendJson(res, 202, run);
        return true;
      }

      if (
        method === "GET" &&
        parts[1] === "playbooks" &&
        parts[3] === "runs" &&
        parts[4] &&
        parts[2]
      ) {
        const run = await runtime.playbookEngine.getRun(parts[4]);
        if (!run) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, run);
        return true;
      }

      // PUT /v1/playbooks/{id}/yaml — 写入 Playbook YAML 到自定义 pack 并热重载
      if (method === "PUT" && parts[1] === "playbooks" && parts[2] && parts[3] === "yaml") {
        if (!(await requireWrite(`playbook:${parts[2]}`))) return true;
        const body = (await readJsonBody(req)) as { yaml?: string; pack_path?: string };
        if (!body.yaml) {
          badRequest(res, "yaml is required");
          return true;
        }
        // 写入 custom pack 目录（~/.claworks/packs/custom/ontology/playbooks/）
        const { homedir } = await import("node:os");
        const customPackRoot = join(homedir(), ".claworks", "packs", "custom");
        const playbooksDir = join(customPackRoot, "ontology", "playbooks");
        mkdirSync(playbooksDir, { recursive: true });
        // 确保 custom pack manifest 存在
        const manifestPath = join(customPackRoot, "claworks.pack.json");
        try {
          mkdirSync(dirname(manifestPath), { recursive: true });
          writeFileSync(
            manifestPath,
            JSON.stringify(
              {
                id: "custom",
                name: "Custom operator pack",
                version: "1.0.0",
                license: "MIT",
                provides: { objectTypes: [], playbooks: [], actionTypes: [] },
              },
              null,
              2,
            ),
            { flag: "wx" },
          );
        } catch {
          /* manifest already exists */
        }
        const safeId = parts[2].replace(/[^\w-]/g, "_");
        const filePath = join(playbooksDir, `${safeId}.yaml`);
        writeFileSync(filePath, String(body.yaml), "utf-8");
        // 热重载 packs
        const { reloadClaworksPacksFromDisk } = await import("../../claworks/pack-runtime.js");
        const packPaths = new Set([...(runtime.config.packs?.paths ?? []), customPackRoot]);
        runtime.config.packs = {
          ...runtime.config.packs,
          paths: [...packPaths],
          installed: [...new Set([...(runtime.config.packs?.installed ?? []), "custom"])],
        };
        const result = await reloadClaworksPacksFromDisk(runtime);
        sendJson(res, 201, {
          status: "ok",
          playbook_id: safeId,
          file_path: filePath,
          reloaded_packs: result.packs.map((p) => p.manifest.id),
        });
        return true;
      }

      async function handleHitlSubmit(runId: string): Promise<boolean> {
        const rbacResult = checkRbac(runtime, auth, "hitl.resolve", `run:${runId}`);
        if (!rbacResult.allowed) {
          void runtime.kernel
            .publish(
              "rbac.denied",
              "rest",
              {
                subject_type: auth.subjectType,
                subject_id: auth.subjectId,
                action: "hitl.resolve",
                resource: `run:${runId}`,
                reason: rbacResult.reason,
              },
              { subjectType: "system", subjectId: "rbac" },
            )
            .catch(() => undefined);
          sendJson(res, 403, {
            error: "Forbidden",
            code: "RBAC_DENIED",
            reason: rbacResult.reason,
          });
          return true;
        }
        const body = (await readJsonBody(req)) as {
          step_id?: string;
          decision?: string;
          comment?: string;
        };
        if (!body.step_id || !body.decision) {
          badRequest(res, "step_id and decision are required");
          return true;
        }
        const run = await runtime.playbookEngine.submitHitlDecision(
          runId,
          body.step_id,
          body.decision,
          body.comment,
        );
        sendJson(res, 200, run);
        return true;
      }

      if (
        method === "POST" &&
        parts[1] === "playbooks" &&
        parts[2] === "runs" &&
        parts[4] === "hitl" &&
        parts[3]
      ) {
        return await handleHitlSubmit(parts[3]);
      }

      if (
        method === "POST" &&
        parts[1] === "playbooks" &&
        parts[3] === "runs" &&
        parts[5] === "hitl" &&
        parts[2] &&
        parts[4]
      ) {
        return await handleHitlSubmit(parts[4]);
      }

      if (method === "POST" && parts[1] === "events") {
        if (!(await requireWrite(`event:*`))) {
          return true;
        }
        const body = (await readJsonBody(req)) as {
          type?: string;
          source?: string;
          payload?: Record<string, unknown>;
          correlation_id?: string;
          idempotency_key?: string;
        };
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
          publishSource: body.source ?? "rest-api",
        });
        if (publishResult.action === "denied") {
          sendJson(res, 403, {
            error: "Forbidden",
            code: "INGRESS_DENIED",
            reason: publishResult.reason,
          });
          return true;
        }
        if (publishResult.action === "observe_only") {
          sendJson(res, 202, { action: "observe_only" });
          return true;
        }
        if (publishResult.action === "intent_routed") {
          sendJson(res, 202, {
            action: "intent_routed",
            playbook_id: publishResult.playbookId,
            run_id: publishResult.runId,
            status: publishResult.status,
          });
          return true;
        }
        sendJson(res, 202, {
          event_id: randomUUID(),
          event_type: publishResult.eventType,
          matched_playbooks: publishResult.matchedPlaybooks,
        });
        return true;
      }

      if (method === "GET" && parts[1] === "events") {
        const events = await runtime.kernel.bus.query({ limit: 50 });
        sendJson(res, 200, { events });
        return true;
      }

      // POST /v1/bridge/webhook — 外部 Webhook 载荷意图路由
      if (method === "POST" && parts[1] === "bridge" && parts[2] === "webhook") {
        const body = (await readJsonBody(req)) as {
          source?: string;
          webhook_id?: string;
          webhookId?: string;
          body?: Record<string, unknown> | string;
          payload?: Record<string, unknown> | string;
          subject_id?: string;
          subjectId?: string;
          extra?: Record<string, unknown>;
        };
        if (!body.source || (body.body === undefined && body.payload === undefined)) {
          badRequest(res, "source and body (or payload) are required");
          return true;
        }
        const { bridgeWebhookPayload } = await import("../../claworks/webhook-bridge.js");
        const result = await bridgeWebhookPayload(runtime, {
          source: String(body.source),
          webhookId: body.webhook_id
            ? String(body.webhook_id)
            : body.webhookId
              ? String(body.webhookId)
              : undefined,
          body: (body.body ?? body.payload) as Record<string, unknown> | string,
          subjectId: body.subject_id
            ? String(body.subject_id)
            : body.subjectId
              ? String(body.subjectId)
              : auth.subjectId,
          extra: body.extra,
        });
        const status = result.action === "denied" ? 403 : 202;
        sendJson(res, status, result);
        return true;
      }

      // POST /v1/bridge/im — IM 消息意图路由桥梁入口
      if (method === "POST" && parts[1] === "bridge" && parts[2] === "im") {
        const body = (await readJsonBody(req)) as {
          channel?: string;
          message_id?: string;
          messageId?: string;
          user_id?: string;
          userId?: string;
          text?: string;
          group_id?: string;
          groupId?: string;
          extra?: Record<string, unknown>;
        };
        if (!body.channel || !body.text) {
          badRequest(res, "channel and text are required");
          return true;
        }
        const { bridgeImMessage } = await import("../../claworks/im-bridge.js");
        const result = await bridgeImMessage(runtime, {
          channel: String(body.channel),
          messageId: String(body.message_id ?? body.messageId ?? `msg-${Date.now()}`),
          userId: String(body.user_id ?? body.userId ?? auth.subjectId),
          text: String(body.text),
          groupId: body.group_id
            ? String(body.group_id)
            : body.groupId
              ? String(body.groupId)
              : undefined,
          extra: body.extra,
        });
        const status = result.action === "denied" ? 403 : 202;
        sendJson(res, status, result);
        return true;
      }

      if (method === "GET" && parts[1] === "objects" && parts[2]) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const filterRaw = url.searchParams.get("filter");
        const filter = filterRaw ? (JSON.parse(filterRaw) as Record<string, unknown>) : undefined;
        const result = await runtime.objectStore.query(parts[2], {
          filter,
          limit: Number(url.searchParams.get("limit") ?? 50),
        });
        sendJson(res, 200, { type: parts[2], items: result.items, next_cursor: result.nextCursor });
        return true;
      }

      if (method === "GET" && parts[1] === "objects" && parts[2] && parts[3]) {
        const obj = await runtime.objectStore.get(parts[2], parts[3]);
        if (!obj) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, obj);
        return true;
      }

      if (method === "POST" && parts[1] === "objects" && parts[2] && !parts[3]) {
        if (!(await requireWrite(`object:${parts[2]}`))) {
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const obj = await runtime.objectStore.create(parts[2], body);
        sendJson(res, 201, obj);
        return true;
      }

      if (method === "PATCH" && parts[1] === "objects" && parts[2] && parts[3]) {
        if (!(await requireWrite(`object:${parts[2]}:${parts[3]}`))) {
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const obj = await runtime.objectStore.update(parts[2], parts[3], body);
        sendJson(res, 200, obj);
        return true;
      }

      if (
        method === "POST" &&
        parts[1] === "objects" &&
        parts[2] &&
        parts[3] &&
        parts[4] === "actions" &&
        parts[5]
      ) {
        if (!(await requireWrite(`object:${parts[2]}:${parts[3]}/action:${parts[5]}`))) {
          return true;
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const result = await runtime.objectStore.executeAction(parts[2], parts[3], parts[5], body, {
          runId: "rest",
          playbookId: "rest",
          variables: {},
          objectStore: runtime.objectStore,
          kb: runtime.kb,
          robot: runtime.robot,
        });
        sendJson(res, 200, result);
        return true;
      }

      if (method === "GET" && parts[1] === "kb" && parts[2] === "search") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const q = url.searchParams.get("q") ?? "";
        const results = await runtime.kb.search(q, {
          limit: Number(url.searchParams.get("limit") ?? 5),
          namespace: url.searchParams.get("namespace") ?? undefined,
        });
        sendJson(res, 200, { results });
        return true;
      }

      if (method === "POST" && parts[1] === "kb" && parts[2] === "ingest" && !parts[3]) {
        const body = (await readJsonBody(req)) as {
          text?: string;
          namespace?: string;
          source?: string;
        };
        if (!body.text) {
          badRequest(res, "text is required");
          return true;
        }
        await runtime.kb.ingest(body.text, { namespace: body.namespace, source: body.source });
        sendJson(res, 201, { ingested: true });
        return true;
      }

      // POST /v1/kb/ingest/folder — 批量将本地文件夹中的文本文件入库
      if (
        method === "POST" &&
        parts[1] === "kb" &&
        parts[2] === "ingest" &&
        parts[3] === "folder"
      ) {
        if (!(await requireWrite("kb:ingest:folder"))) return true;
        const body = (await readJsonBody(req)) as {
          folder_path?: string;
          namespace?: string;
          recursive?: boolean;
          file_types?: string[];
          source_prefix?: string;
        };
        if (!body.folder_path) {
          badRequest(res, "folder_path is required");
          return true;
        }
        const allowedExts = new Set(
          (body.file_types ?? [".txt", ".md", ".markdown", ".json", ".csv", ".yaml", ".yml"]).map(
            (e) => (e.startsWith(".") ? e : `.${e}`),
          ),
        );
        const results: { file: string; status: "ok" | "error"; reason?: string }[] = [];
        const collectFiles = (dir: string): string[] => {
          try {
            return readdirSync(dir).flatMap((entry) => {
              const full = join(dir, entry);
              try {
                const st = statSync(full);
                if (st.isDirectory() && body.recursive !== false) return collectFiles(full);
                if (st.isFile() && allowedExts.has(extname(entry).toLowerCase())) return [full];
              } catch {
                // skip unreadable entries
              }
              return [];
            });
          } catch {
            return [];
          }
        };
        const files = collectFiles(body.folder_path);
        for (const file of files) {
          try {
            const text = readFileSync(file, "utf-8");
            const source = body.source_prefix
              ? `${body.source_prefix}/${file.slice(body.folder_path.length + 1)}`
              : file;
            await runtime.kb.ingest(text, { namespace: body.namespace, source });
            results.push({ file, status: "ok" });
          } catch (err) {
            results.push({
              file,
              status: "error",
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        sendJson(res, 201, {
          ingested: results.filter((r) => r.status === "ok").length,
          errors: results.filter((r) => r.status === "error").length,
          total: files.length,
          results,
        });
        return true;
      }

      if (method === "GET" && parts[1] === ".well-known" && parts[2] === "agent.json") {
        sendJson(res, 200, buildA2aAgentCard(runtime));
        return true;
      }

      notFound(res);
      return true;
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
        code: "INTERNAL_ERROR",
      });
      return true;
    }
  };
}

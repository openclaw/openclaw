/**
 * evolve-engine.ts — ClaWorks 自主进化引擎
 *
 * 用户输入自然语言需求 → LLM 生成 Playbook YAML → 写文件 + 热重载 → 验证 → CBR 学习
 *
 * 完整进化循环：
 *   propose()  → 分析需求，LLM 生成 Playbook 方案
 *   deploy()   → 写文件到 Pack 目录 + packLoader.load() 热重载
 *   verify()   → 发布测试事件，订阅结果，等待触发
 *   learn()    → 写入 CbrStore 供后续检索
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ClaWorks 自改进流水线（Self-Improvement Pipeline）
 *
 * 解决弱模型（Qwen3-35B 等私域部署模型）能力不足的核心方案：
 * 用商业顶级模型（Claude/GPT）离线生成知识，弱模型在线执行。
 *
 * 流水线步骤：
 * 1. 数据采集（私域实时，弱模型运行时）
 *    - im.intent_unresolved 事件 → AutonomyEngine 检测
 *    - 用户负反馈 → learn.from_feedback → CBR 标记失败案例
 *    - PlaybookRun failed → cw_playbook_runs 记录
 *
 * 2. 导出 → evolution.export_data
 *    - 失败执行记录 + 用户纠正样本 + 未解析意图文本
 *    - 输出：EvolutionExportPackage JSON 文件
 *
 * 3. 商业模型分析（离线，在联网环境运行）
 *    - Claude/GPT 分析失败案例，生成改进方案
 *    - 产出：改进的 Playbook YAML + 新决策规则 + 优化的 prompt 模板
 *    - 相当于"顶级教授指导后"的知识体系
 *
 * 4. 导入 → evolution.import_pack（POST /v1/evolution/import）
 *    - 热更新 Playbook（pack.reload）
 *    - 更新 RuleEngine 决策表
 *    - 更新 PromptTemplateRegistry 模板
 *
 * 5. 验证 → PlaybookSimulator
 *    - 用历史失败案例跑回归测试
 *    - 对比进化前后的成功率
 *    - 通过后才部署（POST /v1/playbooks/:id/simulate）
 *
 * 示例：模拟场景驱动的能力建设
 *   - 用 opus/sonnet 生成 100 个模拟业务场景
 *   - 为每个场景生成标准的 Playbook + 规则 + prompt
 *   - 打包为进化包 → 导入私域 → 弱模型直接执行预制脚本
 *   - 效果等同于"学生跟顶级教授学习后独立工作"
 * ─────────────────────────────────────────────────────────────────────────────
 *   remove()   → 从文件系统删除并从引擎卸载
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 自改进流水线（Self-Improvement Pipeline）
 *
 * 私域（弱模型）→ 商业模型 → 进化包 → 导入回来的完整闭环：
 *
 * 1. 数据采集（私域实时）
 *    - perceive.intent 失败 → im.intent_unresolved 事件 → AutonomyEngine 检测
 *    - 用户负反馈 → learn.from_feedback → CBR 标记失败案例
 *    - PlaybookRun failed → cw_playbook_runs 记录
 *
 * 2. 导出（evolution.export_data）
 *    - 导出失败执行记录 + 用户纠正数据 + 未解析意图样本
 *    - 格式：EvolutionExportPackage（see: evolution-sync.ts）
 *
 * 3. 商业模型处理（离线，在联网环境）
 *    - 用 Claude/GPT 分析失败案例，生成改进方案
 *    - 输出：改进的 Playbook YAML + 新规则表 + 优化的 prompt 模板
 *    - 这一步是"顶级教授教学"环节
 *
 * 4. 导入（evolution.import_pack）
 *    - 将商业模型生成的进化包导入私域
 *    - pack.reload 热更新 Playbook
 *    - RuleEngine 更新规则表
 *    - PromptTemplateRegistry 更新模板
 *
 * 5. 验证（PlaybookSimulator）
 *    - 用历史失败案例跑 regression 测试
 *    - 对比进化前后的成功率
 *
 * 集成点：
 * - 触发导出：`runtime.autonomyEngine.exportLearningData()`（委托 `evolutionSync.exportEvolutionData()`）
 * - 触发导入：`POST /v1/evolution/import`（已实现）
 * - 触发验证：`POST /v1/playbooks/:id/simulate`（已实现）
 * ──────────────────────────────────────────────────────────────────────────
 */

import { mkdir, writeFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { parsePlaybookYaml } from "../pack-loader/yaml-parsers.js";
import { isDocumentKnowledgeBase } from "../planes/data/kb-types.js";
import { BRIDGE_LLM } from "./bridge-registry.js";
import { CW_EVENTS } from "./event-names.js";
import type { OutputSchema } from "./structured-output.js";

// ── 公开类型 ──────────────────────────────────────────────────────────────

export type EvolveRequest = {
  /** 用户的需求描述（自然语言） */
  description: string;
  /** 额外上下文（系统状态、已有能力等） */
  context?: string;
  /** 参考案例（few-shot 提示） */
  examples?: string[];
};

export type EvolveProposal = {
  id: string;
  title: string;
  description: string;
  /** 生成的完整 Playbook YAML 字符串 */
  playbook_yaml: string;
  /** 需要调用的能力 ID 列表 */
  required_capabilities: string[];
  /** 不在注册表中但需要的能力 */
  missing_capabilities: string[];
  /** 触发事件名 */
  trigger_event: string;
  /** 测试时发送的事件名 */
  test_event: string;
  /** 测试时的事件载荷 */
  test_payload: Record<string, unknown>;
  /** 0–1 置信度 */
  confidence: number;
  /** 潜在问题警告 */
  warnings: string[];
};

export type EvolveResult = {
  proposal: EvolveProposal;
  deployed: boolean;
  playbook_path: string;
  test_passed?: boolean;
  test_output?: unknown;
  cbr_case_id?: string;
};

export type PromoteDraftRequest = {
  proposalId: string;
  approved: boolean;
  packId?: string;
  verifyAfterDeploy?: boolean;
  source?: string;
};

export type PromoteDraftResult = {
  status: string;
  deployed?: boolean;
  proposal?: EvolveProposal;
  deploy?: EvolveResult;
  reason?: string;
};

export const EVOLUTION_DRAFTS_NAMESPACE = "evolution_drafts";

/** 运行时是否具备 LLM 桥（structuredOutput / bridge / llmComplete） */
export function hasEvolveLlmBridge(runtime: ClaworksRuntime): boolean {
  if (runtime.structuredOutput) {
    return true;
  }
  const bridge = runtime.bridges?.get(BRIDGE_LLM) as { complete?: unknown } | undefined;
  if (typeof bridge?.complete === "function") {
    return true;
  }
  return typeof runtime.llmComplete === "function";
}

export interface EvolveEngine {
  /** 分析需求，LLM 生成 Playbook 方案 */
  propose(req: EvolveRequest): Promise<EvolveProposal>;
  /** LLM 生成 Playbook 草稿，写入 KB evolution_drafts（不部署） */
  proposeDraft(
    req: EvolveRequest,
    opts?: { source?: string; signal?: string },
  ): Promise<EvolveProposal>;
  /** KB 草稿 HITL 晋升：approved=false 请求审批；approved=true 部署草稿 */
  promoteDraft(req: PromoteDraftRequest): Promise<PromoteDraftResult>;
  /** 部署方案（写文件 + 热重载） */
  deploy(proposal: EvolveProposal, opts?: { packId?: string }): Promise<EvolveResult>;
  /** 发布测试事件，验证 Playbook 是否正确触发 */
  verify(
    playbookId: string,
    testEvent: string,
    testPayload: Record<string, unknown>,
  ): Promise<{ passed: boolean; output?: unknown; error?: string }>;
  /** 将进化结果写入 CbrStore */
  learn(result: EvolveResult, feedback?: string): Promise<string | undefined>;
  /** 列出用户通过对话生成的所有 Playbook */
  listEvolved(): Promise<Array<{ id: string; title: string; deployedAt: Date }>>;
  /** 列出 KB evolution_drafts 中待审核的 Playbook 草稿 */
  listDrafts(): Promise<
    Array<{
      proposal_id: string;
      title: string;
      status: string;
      confidence?: number;
      signal?: string;
      source?: string;
      created_at: string;
      updated_at: string;
    }>
  >;
  /** 移除一个进化的 Playbook */
  remove(playbookId: string): Promise<void>;
  /**
   * 开启自动学习监听：订阅 PLAYBOOK_RUN_FAILED 事件，
   * 将失败案例自动写入 CbrStore，供下次 propose/分析时引用。
   * 返回 unsubscribe 函数，Runtime 停止时调用。
   */
  startAutoLearning(): () => void;
  /**
   * 订阅 evolve.playbook_drafted，丰富草稿元数据并发布 evolve.suggestions_ready（HITL，不自动 deploy）。
   * 返回 unsubscribe 函数，Runtime 停止时调用。
   */
  startDraftReviewPipeline(): () => void;
}

// ── LLM prompt 常量 ───────────────────────────────────────────────────────

function buildSystemPrompt(capIds: string, playbookExamples: string): string {
  return `你是 ClaWorks 机器人的 Playbook 工程师。
用户描述一个业务需求，你需要生成一个可执行的 Playbook YAML。

## 已注册的能力（从这些中选择 action）：
${capIds || "（暂无，请使用通用能力）"}

## Playbook YAML 格式示例：
${playbookExamples || "（暂无已有 Playbook）"}

## 完整 Playbook YAML 格式说明：
\`\`\`yaml
id: unique_playbook_id          # 唯一标识符，snake_case
name: 可读名称
pack: user_evolved              # 固定为 user_evolved
trigger:
  kind: event
  pattern: event.name           # 触发事件
  condition: "{{ expr }}"       # 可选过滤条件
priority: 500
steps:
  - kind: action
    id: step_id
    action: capability.id       # 必须是已注册的能力 ID
    params:
      key: "{{ event.payload.key }}"
    store_result_as: result_var
    on_failure: continue

  - kind: condition
    id: check_something
    if: "{{ result_var.value > 85 }}"
    then:
      - kind: action
        id: sub_step
        action: another.capability
        params: {}

  - kind: hitl
    id: confirm
    message: "确认执行？"
    timeout_seconds: 300
\`\`\`

## 重要规则：
1. action: 字段必须使用已注册的能力 ID
2. notify.dispatch 用于跨渠道通知，comms.send 用于回复 IM 消息
3. object.create 用于创建工单/记录
4. 模板使用 Jinja2 语法：{{ event.payload.field }}
5. 触发事件 pattern 可以是标准事件（如 sensor.reading_received）也可以是自定义事件

以 JSON 格式返回，包含：
{
  "title": "方案名称",
  "description": "方案说明",
  "playbook_yaml": "完整YAML字符串",
  "required_capabilities": ["能力id"],
  "missing_capabilities": ["不在列表中但需要的能力"],
  "trigger_event": "触发事件名",
  "test_event": "测试时发布的事件名",
  "test_payload": {"测试载荷"},
  "confidence": 0.85,
  "warnings": ["潜在问题"]
}`;
}

const PROPOSAL_SCHEMA: OutputSchema = {
  type: "object",
  required: [
    "title",
    "description",
    "playbook_yaml",
    "required_capabilities",
    "trigger_event",
    "test_event",
    "test_payload",
    "confidence",
  ],
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    playbook_yaml: { type: "string" },
    required_capabilities: { type: "array" },
    missing_capabilities: { type: "array" },
    trigger_event: { type: "string" },
    test_event: { type: "string" },
    test_payload: { type: "object" },
    confidence: { type: "number" },
    warnings: { type: "array" },
  },
};

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createEvolveEngine(runtime: ClaworksRuntime): EvolveEngine {
  async function publishDraftSuggestions(payload: Record<string, unknown>): Promise<void> {
    const proposalId = String(payload.id ?? payload.proposal_id ?? "").trim();
    if (!proposalId) {
      return;
    }

    let playbookId: string | undefined;
    let triggerPattern: string | undefined;
    let draftConfidence: number | undefined;
    let yamlValid = false;
    let yamlError: string | undefined;

    try {
      const hits = await runtime.kb.search(proposalId, {
        namespace: EVOLUTION_DRAFTS_NAMESPACE,
        limit: 10,
      });
      const draftDoc = hits.find((h) => h.text.includes(`proposal_id: ${proposalId}`));
      const parsed = draftDoc ? parseEvolutionDraftText(draftDoc.text) : null;
      if (parsed?.playbookYaml) {
        draftConfidence = parsed.confidence;
        playbookId = parsed.playbookYaml.match(/^id:\s*(.+)$/m)?.[1]?.trim();
        triggerPattern = parsed.playbookYaml.match(/^ {2}pattern:\s*(.+)$/m)?.[1]?.trim();
        try {
          parsePlaybookYaml(parsed.playbookYaml, "evolve-draft-review");
          yamlValid = true;
        } catch (err) {
          yamlError = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      yamlError = err instanceof Error ? err.message : String(err);
    }

    const title = typeof payload.title === "string" ? payload.title : proposalId;
    await runtime.kernel.publish(CW_EVENTS.EVOLVE_SUGGESTIONS_READY, "evolve.draft_review", {
      draft_id: proposalId,
      proposal_id: proposalId,
      title,
      status: payload.status ?? "pending_review",
      namespace: EVOLUTION_DRAFTS_NAMESPACE,
      signal: payload.signal,
      playbook_id: playbookId,
      trigger_pattern: triggerPattern,
      confidence: typeof payload.confidence === "number" ? payload.confidence : draftConfidence,
      simulation: {
        skipped: true,
        yaml_valid: yamlValid,
        error: yamlError,
      },
      hitl_required: true,
      suggestions: [
        `Playbook 草稿「${title}」已写入 KB（${EVOLUTION_DRAFTS_NAMESPACE}），待人工审核。`,
        `调用 evolve.promote_draft(proposalId="${proposalId}", approved=true) 部署。`,
      ],
    });
  }

  return {
    // ── propose ────────────────────────────────────────────────────────────
    async propose(req: EvolveRequest): Promise<EvolveProposal> {
      // 1. 收集系统能力列表作为上下文
      const capabilities = runtime.capabilities.list();
      const capIds = capabilities
        .slice(0, 60)
        .map((c) => `${c.id}  # ${c.description ?? ""}`)
        .join("\n");

      // 2. 取前 3 个 Playbook 作为 few-shot 示例
      const existingPlaybooks = runtime.playbookEngine.listPlaybooks().slice(0, 3);
      const playbookExamples = existingPlaybooks
        .map((p) => {
          const trigger = (p.trigger as { pattern?: string } | undefined)?.pattern ?? "some.event";
          return `# 示例: ${p.id}\ntrigger:\n  kind: event\n  pattern: ${trigger}\nsteps: [...]`;
        })
        .join("\n\n");

      // 3. 如果有相关 CBR 案例，加入参考
      const cbrExamples: string[] = req.examples ?? [];
      if (runtime.cbrStore) {
        const cases = runtime.cbrStore.search(req.description, 2);
        for (const c of cases) {
          const prob = String(c.problem ?? "");
          const sol = String(c.solution ?? "").slice(0, 200);
          cbrExamples.push(`# 历史案例（相似度高）\n问题: ${prob}\n方案摘要: ${sol}`);
        }
      }

      const systemPrompt = buildSystemPrompt(capIds, playbookExamples);
      const userPrompt = [
        `用户需求：${req.description}`,
        req.context ? `\n额外上下文：${req.context}` : "",
        cbrExamples.length > 0 ? `\n参考案例：\n${cbrExamples.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("");

      // 4. 优先使用 structuredOutput 引擎
      if (runtime.structuredOutput) {
        const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
        const { data } = await runtime.structuredOutput.complete(combinedPrompt, PROPOSAL_SCHEMA, {
          maxRetries: 3,
          fallback: buildFallbackProposal(req.description),
        });
        return normalizeProposal(data, req.description);
      }

      // 5. 降级：使用 llmComplete 直接补全
      const completeFn =
        (
          runtime.bridges?.get(BRIDGE_LLM) as
            | { complete?: (p: { prompt: string }) => Promise<{ text: string }> }
            | undefined
        )?.complete ?? runtime.llmComplete;

      if (!completeFn) {
        runtime.logger?.("[EvolveEngine] no LLM configured, returning minimal fallback proposal");
        return {
          id: `evolved_${Date.now()}`,
          ...buildFallbackProposal(req.description),
        };
      }

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}\n\n请直接返回 JSON，不要 markdown 代码块。`;
      const result = await completeFn({ prompt: fullPrompt });

      try {
        const match = result.text.match(/\{[\s\S]*\}/);
        const parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : null;
        if (parsed) {
          return normalizeProposal(parsed, req.description);
        }
      } catch {
        // fall through to fallback
      }

      return { id: `evolved_${Date.now()}`, ...buildFallbackProposal(req.description) };
    },

    // ── proposeDraft ───────────────────────────────────────────────────────
    async proposeDraft(req, opts = {}) {
      const proposal = await this.propose(req);
      const source = opts.source ?? "evolve.propose_draft";
      const draftBody = [
        `# Playbook Draft: ${proposal.title}`,
        `status: pending_review`,
        `proposal_id: ${proposal.id}`,
        `confidence: ${proposal.confidence}`,
        opts.signal ? `signal: ${opts.signal}` : "",
        "",
        proposal.playbook_yaml,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await runtime.kb.ingest(draftBody, {
          namespace: EVOLUTION_DRAFTS_NAMESPACE,
          source,
          title: proposal.title,
          metadata: {
            status: "pending_review",
            proposal_id: proposal.id,
            signal: opts.signal,
            confidence: proposal.confidence,
          },
        });
      } catch (err) {
        runtime.logger?.(
          `[EvolveEngine] proposeDraft kb ingest failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      await runtime.kernel.publish("evolve.playbook_drafted", source, {
        id: proposal.id,
        title: proposal.title,
        description: proposal.description,
        confidence: proposal.confidence,
        status: "pending_review",
        namespace: EVOLUTION_DRAFTS_NAMESPACE,
        signal: opts.signal,
        warnings: proposal.warnings,
      });

      return proposal;
    },

    async promoteDraft(req: PromoteDraftRequest): Promise<PromoteDraftResult> {
      const source = req.source ?? "evolve.promote_draft";
      const proposalId = req.proposalId.trim();
      if (!proposalId) {
        return { status: "error", reason: "proposal_id 必填" };
      }

      if (!req.approved) {
        await runtime.kernel.publish("hitl.approval_requested", source, {
          proposal_id: proposalId,
          kind: "evolve_draft_promotion",
        });
        return { status: "approval_required" };
      }

      const hits = await runtime.kb.search(proposalId, {
        namespace: EVOLUTION_DRAFTS_NAMESPACE,
        limit: 8,
      });
      const draftHit =
        hits.find((hit) => hit.text.includes(`proposal_id: ${proposalId}`)) ?? hits[0];
      if (!draftHit?.text) {
        return { status: "error", reason: `draft not found: ${proposalId}` };
      }

      const parsed = parseEvolutionDraftText(draftHit.text);
      if (!parsed?.playbookYaml) {
        return { status: "error", reason: "invalid evolution draft body" };
      }

      const proposal = normalizeProposal(
        {
          id: parsed.proposalId ?? proposalId,
          title: draftHit.title ?? proposalId,
          description: draftHit.title ?? proposalId,
          playbook_yaml: parsed.playbookYaml,
          confidence: parsed.confidence,
        },
        draftHit.title ?? proposalId,
      );

      const deployResult = await this.deploy(proposal, { packId: req.packId });
      if (req.verifyAfterDeploy !== false && proposal.test_event) {
        const verification = await this.verify(
          proposal.id,
          proposal.test_event,
          proposal.test_payload,
        );
        deployResult.test_passed = verification.passed;
        deployResult.test_output = verification.output;
      }

      await runtime.kernel.publish("evolve.playbook_deployed", source, {
        proposal_id: proposal.id,
        title: proposal.title,
        deployed: deployResult.deployed,
        playbook_path: deployResult.playbook_path,
        status: deployResult.test_passed === false ? "deployed_unverified" : "deployed",
      });

      return {
        status: "deployed_unverified",
        deployed: deployResult.deployed,
        proposal,
        deploy: deployResult,
      };
    },

    // ── deploy ─────────────────────────────────────────────────────────────
    async deploy(proposal: EvolveProposal, opts = {}): Promise<EvolveResult> {
      const packId = opts.packId ?? "user_evolved";

      // 确定 Pack 根目录（相对于 CWD 或绝对路径）
      const cwdPacksDir = join(process.cwd(), "contrib", "packs");
      const packDir = join(cwdPacksDir, packId);
      const playbooksDir = join(packDir, "ontology", "playbooks");

      await mkdir(playbooksDir, { recursive: true });

      // 写入 Playbook YAML
      const filename = `${proposal.id}.yaml`;
      const filePath = join(playbooksDir, filename);
      await writeFile(filePath, proposal.playbook_yaml, "utf8");

      // 确保 claworks.pack.json 存在
      const packJsonPath = join(packDir, "claworks.pack.json");
      try {
        await mkdir(packDir, { recursive: true });
        // 仅在不存在时创建
        await writeFile(
          packJsonPath,
          JSON.stringify(
            {
              id: packId,
              name: "用户进化 Pack",
              version: "1.0.0",
              description: "用户通过对话自动生成的 Playbook",
              license: "proprietary",
              provides: { objectTypes: [], playbooks: [], actionTypes: [] },
            },
            null,
            2,
          ),
          { flag: "wx" }, // wx = 仅当文件不存在时写入
        );
      } catch {
        // 文件已存在，忽略
      }

      // 热重载：使用 packLoader.load() 加载/更新这个 Pack
      let deployed = false;
      try {
        const loadedPack = await runtime.packLoader.load(packDir, runtime.logger);
        // 将新 Pack 的 Playbook 注入到 playbookEngine
        await runtime.playbookEngine.loadFromPacks([loadedPack]);
        // 更新 runtime.loadedPacks
        const existingIdx = runtime.loadedPacks.findIndex(
          (p) => p.manifest.id === loadedPack.manifest.id,
        );
        if (existingIdx >= 0) {
          runtime.loadedPacks[existingIdx] = loadedPack;
        } else {
          runtime.loadedPacks.push(loadedPack);
        }
        deployed = true;
        runtime.logger?.(`[EvolveEngine] deployed playbook ${proposal.id} to ${filePath}`);
      } catch (err) {
        runtime.logger?.(
          `[EvolveEngine] hot-reload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return { proposal, deployed, playbook_path: filePath };
    },

    // ── verify ─────────────────────────────────────────────────────────────
    async verify(
      playbookId: string,
      testEvent: string,
      testPayload: Record<string, unknown>,
    ): Promise<{ passed: boolean; output?: unknown; error?: string }> {
      try {
        const log: Record<string, unknown>[] = [];

        const unsubCompleted = runtime.kernel.subscribe("playbook.run.completed", (payload) => {
          if (payload["playbook_id"] === playbookId) {
            log.push({ ...payload, kind: "completed" });
          }
        });
        const unsubFailed = runtime.kernel.subscribe("playbook.run.failed", (payload) => {
          if (payload["playbook_id"] === playbookId) {
            log.push({ ...payload, kind: "failed" });
          }
        });

        await runtime.kernel.publish(testEvent, "evolve-verify", testPayload);

        // 等待最多 5 秒
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));

        unsubCompleted();
        unsubFailed();

        if (log.length > 0) {
          const hasFailure = log.some((l) => l["kind"] === "failed");
          return { passed: !hasFailure, output: log[0] };
        }

        // 没有事件回调时，检查 playbookEngine 里的 runs
        const runs = await runtime.playbookEngine.listRuns({ playbookId, limit: 1 });
        if (runs.length > 0) {
          const run = runs[0];
          return {
            passed: run.status === "completed",
            output: { run_id: run.id, status: run.status },
          };
        }

        // 未触发：可能触发条件不匹配，视为未验证而非失败
        return {
          passed: false,
          error: `测试事件 '${testEvent}' 已发布，但 Playbook '${playbookId}' 未在 5s 内触发。请检查 trigger.pattern 是否匹配。`,
        };
      } catch (err) {
        return { passed: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    // ── learn ──────────────────────────────────────────────────────────────
    async learn(result: EvolveResult, feedback?: string): Promise<string | undefined> {
      if (!runtime.cbrStore) {
        return undefined;
      }

      const tags = [
        "evolved",
        `trigger:${result.proposal.trigger_event}`,
        ...result.proposal.required_capabilities.map((c) => `cap:${c}`),
      ];

      const problem = result.proposal.description;
      const solution = result.proposal.playbook_yaml;
      const caseEntry = runtime.cbrStore.add(problem, solution, {
        id: `evolved-${result.proposal.id}`,
        outcome: result.test_passed ? "success" : "partial",
        tags,
        playbookId: result.proposal.id,
      });

      const entryId = String(caseEntry?.id ?? `evolved-${result.proposal.id}`);
      if (feedback) {
        runtime.logger?.(`[EvolveEngine] learn feedback for ${entryId}: ${feedback}`);
      }

      return entryId;
    },

    // ── listEvolved ────────────────────────────────────────────────────────
    async listEvolved(): Promise<Array<{ id: string; title: string; deployedAt: Date }>> {
      const playbooksDir = join(
        process.cwd(),
        "contrib",
        "packs",
        "user_evolved",
        "ontology",
        "playbooks",
      );
      try {
        const files = await readdir(playbooksDir);
        return files
          .filter((f) => f.endsWith(".yaml"))
          .map((f) => ({
            id: f.replace(/\.yaml$/, ""),
            title: f
              .replace(/\.yaml$/, "")
              .replace(/_/g, " ")
              .replace(/^evolved\s+\d+$/, "用户进化 Playbook"),
            deployedAt: new Date(),
          }));
      } catch {
        return [];
      }
    },

    // ── listDrafts ─────────────────────────────────────────────────────────
    async listDrafts() {
      if (!isDocumentKnowledgeBase(runtime.kb)) {
        return [];
      }
      const docs = await runtime.kb.listDocuments({
        namespace: EVOLUTION_DRAFTS_NAMESPACE,
        limit: 100,
      });
      return docs.map((doc) => {
        const meta = doc.metadata ?? {};
        const proposalId =
          typeof meta.proposal_id === "string"
            ? meta.proposal_id
            : typeof doc.source === "string"
              ? doc.source
              : doc.id;
        return {
          proposal_id: proposalId,
          title: doc.title,
          status: typeof meta.status === "string" ? meta.status : doc.status,
          confidence: typeof meta.confidence === "number" ? meta.confidence : undefined,
          signal: typeof meta.signal === "string" ? meta.signal : undefined,
          source: doc.source,
          created_at: new Date(doc.created_at).toISOString(),
          updated_at: new Date(doc.updated_at).toISOString(),
        };
      });
    },

    // ── remove ─────────────────────────────────────────────────────────────
    async remove(playbookId: string): Promise<void> {
      const filePath = join(
        process.cwd(),
        "contrib",
        "packs",
        "user_evolved",
        "ontology",
        "playbooks",
        `${playbookId}.yaml`,
      );
      await unlink(filePath).catch(() => {});

      // 从 playbookEngine 卸载
      runtime.playbookEngine.unload?.(playbookId);
    },

    // ── startAutoLearning ──────────────────────────────────────────────────
    startAutoLearning(): () => void {
      if (!runtime.cbrStore) {
        // 无 CbrStore 时返回空 cleanup，不报错
        return () => {};
      }
      const unsub = runtime.kernel.subscribe(
        "playbook.run.failed",
        (payload: Record<string, unknown>) => {
          if (!runtime.cbrStore) {
            return;
          }
          const playbookId = String(payload["playbook_id"] ?? "unknown");
          const error = String(payload["error"] ?? "");
          const durationMs = Number(payload["duration_ms"] ?? 0);
          try {
            runtime.cbrStore.add(
              `Playbook '${playbookId}' 执行失败: ${error.slice(0, 300)}`,
              "失败案例已记录，供下次 propose/分析时参考。",
              {
                category: "playbook_failure",
                playbook_id: playbookId,
                duration_ms: durationMs,
                failed_at: new Date().toISOString(),
                auto_learned: true,
              },
            );
          } catch {
            // 记录失败不影响主流程
          }
        },
      );
      runtime.logger?.("[EvolveEngine] 自动学习监听已启动（订阅 playbook.run.failed）");
      return unsub;
    },

    startDraftReviewPipeline(): () => void {
      const unsub = runtime.kernel.subscribe(
        CW_EVENTS.EVOLVE_PLAYBOOK_DRAFTED,
        (payload: Record<string, unknown>) => {
          void publishDraftSuggestions(payload).catch((err) => {
            runtime.logger?.(
              `[EvolveEngine] draft review failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      );
      runtime.logger?.(
        "[EvolveEngine] 草稿 HITL 流水线已启动（订阅 evolve.playbook_drafted → evolve.suggestions_ready）",
      );
      return unsub;
    },
  };
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────

export function parseEvolutionDraftText(text: string): {
  proposalId?: string;
  playbookYaml?: string;
  confidence?: number;
} | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const proposalMatch = trimmed.match(/^proposal_id:\s*(\S+)/m);
  const confidenceMatch = trimmed.match(/^confidence:\s*([\d.]+)/m);
  const yamlStart = trimmed.split("\n").findIndex((line) => /^id:\s*/.test(line));
  if (yamlStart < 0) {
    return null;
  }

  const playbookYaml = trimmed.split("\n").slice(yamlStart).join("\n").trim();
  if (!playbookYaml) {
    return null;
  }

  return {
    proposalId: proposalMatch?.[1],
    playbookYaml,
    confidence: confidenceMatch ? Number.parseFloat(confidenceMatch[1]) : undefined,
  };
}

function buildFallbackProposal(description: string): Omit<EvolveProposal, "id"> {
  const id = `evolved_${Date.now()}`;
  return {
    title: description.slice(0, 40),
    description,
    playbook_yaml: [
      `id: ${id}`,
      `name: ${description.slice(0, 40)}`,
      "pack: user_evolved",
      `trigger:`,
      `  kind: event`,
      `  pattern: user.custom_event`,
      `steps: []`,
      `# TODO: LLM 未返回有效方案，请手动编辑此文件`,
    ].join("\n"),
    required_capabilities: [],
    missing_capabilities: [],
    trigger_event: "user.custom_event",
    test_event: "user.custom_event",
    test_payload: { _test: true },
    confidence: 0.1,
    warnings: ["LLM 未配置或未返回有效方案，已生成空模板，请手动完善"],
  };
}

function normalizeProposal(raw: Record<string, unknown>, description: string): EvolveProposal {
  // 若 LLM 没给 id，使用时间戳
  const id = typeof raw["id"] === "string" && raw["id"] ? raw["id"] : `evolved_${Date.now()}`;

  // 保证 playbook_yaml 中 id 与 proposal.id 一致
  let yaml = String(raw["playbook_yaml"] ?? "");
  if (yaml && !yaml.includes(`id: ${id}`)) {
    yaml = yaml.replace(/^id:\s*.+$/m, `id: ${id}`);
  }

  return {
    id,
    title: String(raw["title"] ?? description.slice(0, 40)),
    description: String(raw["description"] ?? description),
    playbook_yaml: yaml || buildFallbackProposal(description).playbook_yaml,
    required_capabilities: Array.isArray(raw["required_capabilities"])
      ? (raw["required_capabilities"] as string[])
      : [],
    missing_capabilities: Array.isArray(raw["missing_capabilities"])
      ? (raw["missing_capabilities"] as string[])
      : [],
    trigger_event: String(raw["trigger_event"] ?? "user.custom_event"),
    test_event: String(raw["test_event"] ?? raw["trigger_event"] ?? "user.custom_event"),
    test_payload:
      raw["test_payload"] && typeof raw["test_payload"] === "object"
        ? (raw["test_payload"] as Record<string, unknown>)
        : { _test: true },
    confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : 0.5,
    warnings: Array.isArray(raw["warnings"]) ? (raw["warnings"] as string[]) : [],
  };
}

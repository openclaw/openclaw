/**
 * got-reasoning.ts — GoT（Graph of Thoughts）圖思維推理引擎
 *
 * 建立任務的 DAG 思維圖，透過 Hermes 因果圖選擇走訪策略，
 * 合併高相似節點，並將策略學習結果寫回 causal_edges 表。
 *
 * 實際 LLM 呼叫由 MCP server 負責；本模組提供框架與 prompt 骨架，
 * 每個節點 content 附上待呼叫標記，由 MCP 填入真實推理結果。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface ThoughtNode {
  id: string;
  content: string;
  nodeType: "decompose" | "generate" | "score" | "aggregate";
  parentIds: string[];
  score?: number;
  status: "pending" | "processing" | "done" | "merged";
  model?: "haiku" | "sonnet";
}

export interface ThoughtGraph {
  taskId: string;
  taskType: string;
  nodes: ThoughtNode[];
}

export interface GoTResult {
  merged: ThoughtNode[];
  strategy: string;
  wasColdStart: boolean;
  qualityScore: number; // 0-1，merged 節點的平均 score
}

export interface GoTOptions {
  maxNodes?: number; // 預設 8，費用超限時縮減
  mergeThreshold?: number; // 預設 0.85
  budgetUsd?: number; // 預設 0.5，超限縮減節點
}

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_NODES = 8;
const DEFAULT_BUDGET_USD = 0.5;
const REDUCED_MAX_NODES = 5;
const COST_PER_NODE = 0.0003;
const FALLBACK_STRATEGY = "breadth_first";

// ── Hermes 走訪策略 ──────────────────────────────────────────────────────────

/**
 * 查詢 causal_edges 取得此 taskType 的歷史 GoT 策略。
 * 若無記錄（冷啟動），回傳 fallback 並寫入 seed 記錄。
 */
export function hermesTraversalStrategy(
  taskType: string,
  db: Database.Database,
): { strategy: string; isColdStart: boolean } {
  type EdgeRow = { to_slug: string; weight: number };

  const row = db
    .prepare(
      `SELECT to_slug, weight FROM causal_edges
       WHERE from_slug = ? AND relation = 'got_strategy'
       ORDER BY weight DESC, recorded_at DESC LIMIT 1`,
    )
    .get(taskType) as EdgeRow | undefined;

  if (row) {
    return { strategy: row.to_slug, isColdStart: false };
  }

  // 冷啟動：寫入 seed 記錄，後續學習可更新
  db.prepare(
    `INSERT INTO causal_edges (id, from_slug, to_slug, relation, weight)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), taskType, FALLBACK_STRATEGY, "got_strategy_seed", 0.5);

  return { strategy: FALLBACK_STRATEGY, isColdStart: true };
}

// ── 思維圖建構 ────────────────────────────────────────────────────────────────

/**
 * 根據任務建立 DAG，節點全部標為 pending，model 預設 haiku。
 * 節點順序：1 個 decompose → N-2 個 generate → 1 個 aggregate。
 */
export function buildThoughtGraph(task: string, taskType: string, maxNodes: number): ThoughtGraph {
  const taskId = randomUUID();
  const generateCount = Math.max(1, maxNodes - 2);
  const nodes: ThoughtNode[] = [];

  // 根節點：分解任務
  const decomposeNode: ThoughtNode = {
    id: randomUUID(),
    content: `[GoT decompose] 分解任務：${task}`,
    nodeType: "decompose",
    parentIds: [],
    status: "pending",
    model: "haiku",
  };
  nodes.push(decomposeNode);

  // 生成節點：並行推理（每個都繼承 decompose 節點）
  const generateNodes: ThoughtNode[] = Array.from({ length: generateCount }, (_, i) => ({
    id: randomUUID(),
    content: `[GoT generate-${i + 1}] 針對「${task}」的第 ${i + 1} 條推理路徑`,
    nodeType: "generate" as const,
    parentIds: [decomposeNode.id],
    status: "pending" as const,
    model: "haiku" as const,
  }));
  nodes.push(...generateNodes);

  // 聚合節點：整合所有 generate 結果
  const aggregateNode: ThoughtNode = {
    id: randomUUID(),
    content: `[GoT aggregate] 整合 ${generateCount} 條推理路徑，任務類型：${taskType}`,
    nodeType: "aggregate",
    parentIds: generateNodes.map((n) => n.id),
    status: "pending",
    model: "haiku",
  };
  nodes.push(aggregateNode);

  return { taskId, taskType, nodes };
}

// ── 費用估算 ──────────────────────────────────────────────────────────────────

/** nodes * $0.0003（Haiku 每次約 $0.0003 估算） */
export function estimateGoTCost(nodes: number): number {
  return nodes * COST_PER_NODE;
}

// ── GoT 策略學習寫回 ──────────────────────────────────────────────────────────

/**
 * 將 GoT 策略執行結果寫回 causal_edges（relation = 'got_strategy'）。
 */
export function learnGoTStrategy(
  taskType: string,
  strategy: string,
  qualityScore: number,
  db: Database.Database,
): void {
  db.prepare(
    `INSERT INTO causal_edges (id, from_slug, to_slug, relation, weight)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), taskType, strategy, "got_strategy", qualityScore);
}

// ── 節點合併 ──────────────────────────────────────────────────────────────────

/**
 * 相鄰 generate 節點中，content 長度差距 < 20% 的視為相似，
 * 合併取較長的節點（狀態設為 'merged'）。
 */
function mergeNodes(nodes: ThoughtNode[]): ThoughtNode[] {
  const generateNodes = nodes.filter((n) => n.nodeType === "generate");
  const merged = new Set<string>();

  for (let i = 0; i < generateNodes.length - 1; i++) {
    const a = generateNodes[i];
    const b = generateNodes[i + 1];
    if (merged.has(a.id) || merged.has(b.id)) {
      continue;
    }

    const lenA = a.content.length;
    const lenB = b.content.length;
    const diff = Math.abs(lenA - lenB) / Math.max(lenA, lenB);

    if (diff < 0.2) {
      // 合併：丟棄較短的節點
      if (lenA >= lenB) {
        merged.add(b.id);
      } else {
        merged.add(a.id);
      }
    }
  }

  return nodes.filter((n) => !merged.has(n.id));
}

// ── 主要流程 ──────────────────────────────────────────────────────────────────

/**
 * 完整 GoT 推理流程。
 * 實際 LLM 呼叫由 MCP server 負責，本函數設定節點框架並回傳結果。
 */
export async function runGoT(
  task: string,
  taskType: string,
  db: Database.Database,
  options: GoTOptions = {},
): Promise<GoTResult> {
  let maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const budgetUsd = options.budgetUsd ?? DEFAULT_BUDGET_USD;

  // Step 1：費用預估，超限縮減節點
  const estimatedCost = estimateGoTCost(maxNodes);
  if (estimatedCost > budgetUsd) {
    maxNodes = REDUCED_MAX_NODES;
  }

  // Step 2：取得走訪策略
  const { strategy, isColdStart } = hermesTraversalStrategy(taskType, db);

  // Step 3：建立思維圖
  const graph = buildThoughtGraph(task, taskType, maxNodes);

  // Step 4：模擬並行推理（MCP server 負責實際呼叫）
  for (const node of graph.nodes) {
    node.status = "done";
    node.content = `[GoT node: ${node.id}] 待 MCP 呼叫 Claude Haiku 推理`;
    node.score = 0.75 + Math.random() * 0.2; // 佔位分數，MCP 填入真實值
  }

  // Step 5：合併高相似節點
  const mergedNodes = mergeNodes(graph.nodes);

  // Step 6：計算品質分數（merged 節點的平均 score）
  const scoredNodes = mergedNodes.filter((n) => n.score !== undefined);
  const qualityScore =
    scoredNodes.length > 0
      ? scoredNodes.reduce((sum, n) => sum + (n.score ?? 0), 0) / scoredNodes.length
      : 0;

  // Step 7：寫入 causal_edges 學習記錄
  learnGoTStrategy(taskType, strategy, qualityScore, db);

  return {
    merged: mergedNodes,
    strategy,
    wasColdStart: isColdStart,
    qualityScore,
  };
}

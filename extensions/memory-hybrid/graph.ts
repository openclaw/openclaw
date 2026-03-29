/**
 * Knowledge Graph Module
 *
 * Stores entities (people, places, concepts) and their relationships
 * in an append-only JSONL file alongside the LanceDB database.
 *
 * Example:
 *   Node: { id: "Vova", type: "Person", description: "The user" }
 *   Edge: { source: "Vova", target: "Python", relation: "knows", timestamp: 1708123456 }
 *
 * Used by:
 * - processAndStoreMemory(): extracts entities & relations via LLM after storing a memory
 * - recall(): enriches search results with graph connections
 */

import { readFile, writeFile, appendFile, access, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ChatModel } from "./chat.js";
import { TaskPriority } from "./limiter.js";
import { MemoryTracer, type Logger } from "./tracer.js";
import { escapePrompt } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export interface GraphNode {
  id: string;
  type: string;
  description?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  timestamp: number;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ============================================================================
// Graph Database
// ============================================================================

export class GraphDB {
  public nodes: Map<string, GraphNode> = new Map();
  public edges: GraphEdge[] = [];
  /** Adjacency list for O(1) neighbor lookups: nodeId -> Set of edge indices */
  private adjacencyList: Map<string, Set<number>> = new Map();
  /** Set of composite keys for O(1) edge dedup: "source|target|relation" */
  private edgeKeys: Set<string> = new Set();
  private filePath: string;
  private legacyJsonPath: string;
  private loaded = false;
  private mutex = Promise.resolve();

  /** Track new (unsaved) nodes and edges for append-only writes */
  private dirtyNodes: Set<string> = new Set();
  private savedEdgeCount = 0;

  private tracer: MemoryTracer;
  private logger: Logger;

  constructor(basePath: string, tracer: MemoryTracer, logger: Logger) {
    this.tracer = tracer;
    this.logger = logger;
    // Save graph.jsonl next to the lancedb folder
    this.filePath = join(dirname(basePath), "graph.jsonl");
    this.legacyJsonPath = join(dirname(basePath), "graph.json");
    this.edgeKeys = new Set();
    this.adjacencyList = new Map();
  }

  /**
   * Execute a function with a comprehensive lock to prevent race conditions.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Wait for previous lock
    const prev = this.mutex;
    this.mutex = lock;
    await prev;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Load graph from disk (lazy, only on first access). Supports JSONL + legacy JSON migration. */
  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;

      let migrated = false;

      // Try JSONL first (new format)
      try {
        await access(this.filePath);
        const raw = await readFile(this.filePath, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const record = JSON.parse(trimmed) as { _t: "n" | "e"; d: GraphNode | GraphEdge };
            if (record._t === "n") {
              const node = record.d as GraphNode;
              if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
            } else if (record._t === "e") {
              const edge = record.d as GraphEdge;
              const key = `${edge.source}|${edge.target}|${edge.relation}`;
              if (!this.edgeKeys.has(key)) {
                this.edgeKeys.add(key);
                const edgeIndex = this.edges.length;
                this.edges.push(edge);
                this.addToAdjacencyList(edge.source, edgeIndex);
                this.addToAdjacencyList(edge.target, edgeIndex);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
        this.savedEdgeCount = this.edges.length;
        this.tracer.traceGraph(this.nodeCount, this.edgeCount);
        this.loaded = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn(`[memory-hybrid][graph] Load failed: ${err}`);
        }
        // JSONL doesn't exist — try legacy JSON migration
      }

      // Legacy JSON migration
      try {
        await access(this.legacyJsonPath);
        const raw = await readFile(this.legacyJsonPath, "utf-8");
        const data = JSON.parse(raw) as GraphData;

        for (const n of data.nodes) {
          if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
        }
        for (const e of data.edges || []) {
          const key = `${e.source}|${e.target}|${e.relation}`;
          if (!this.edgeKeys.has(key)) {
            this.edgeKeys.add(key);
            const edgeIndex = this.edges.length;
            this.edges.push(e);
            this.addToAdjacencyList(e.source, edgeIndex);
            this.addToAdjacencyList(e.target, edgeIndex);
          }
        }

        // Mark everything as dirty so first save() writes full JSONL
        for (const n of this.nodes.keys()) this.dirtyNodes.add(n);
        this.savedEdgeCount = 0;
        migrated = true;

        this.logger.warn(
          `[memory-hybrid][graph] Migrated legacy graph.json → graph.jsonl (${this.nodes.size} nodes, ${this.edges.length} edges)`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn(`[memory-hybrid][graph] Legacy load failed: ${err}`);
        }
        // No legacy file either — start fresh
      }

      this.loaded = true;

      // Auto-save migrated data to new format
      if (migrated) {
        await this.doSave();
      }
    });
  }

  /** Persist only NEW (dirty) entries to disk via append */
  async save(): Promise<void> {
    return this.withLock(async () => {
      await this.doSave();
    });
  }

  /** Inner save (must be called inside withLock) */
  private async doSave(): Promise<void> {
    // Snapshot dirty state so items added during write aren't lost
    const nodesToFlush = new Set(this.dirtyNodes);
    const edgeFlushStart = this.savedEdgeCount;
    const edgeFlushEnd = this.edges.length;

    const lines: string[] = [];

    // Append new nodes
    for (const nodeId of nodesToFlush) {
      const node = this.nodes.get(nodeId);
      if (node) {
        lines.push(JSON.stringify({ _t: "n", d: node }));
      }
    }

    // Append new edges (only those beyond savedEdgeCount)
    for (let i = edgeFlushStart; i < edgeFlushEnd; i++) {
      lines.push(JSON.stringify({ _t: "e", d: this.edges[i] }));
    }

    if (lines.length > 0) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, lines.join("\n") + "\n", "utf-8");
    }

    // Only clear flushed items (new ones may have been added during write)
    for (const id of nodesToFlush) {
      this.dirtyNodes.delete(id);
    }
    this.savedEdgeCount = edgeFlushEnd;
  }

  /**
   * Full rewrite (compaction) — use periodically to clean up the JSONL file.
   * Removes duplicate lines and produces a minimal file.
   */
  async compact(): Promise<void> {
    return this.withLock(async () => {
      const lines: string[] = [];
      for (const node of this.nodes.values()) {
        lines.push(JSON.stringify({ _t: "n", d: node }));
      }
      for (const edge of this.edges) {
        lines.push(JSON.stringify({ _t: "e", d: edge }));
      }
      // Atomic write: tmp file then rename (prevents data loss on crash)
      const tmpPath = this.filePath + ".tmp";
      await writeFile(tmpPath, lines.join("\n") + "\n", "utf-8");
      await rename(tmpPath, this.filePath);
      this.edgeKeys.clear();
      this.adjacencyList.clear();
      this.edges.forEach((edge, index) => {
        this.edgeKeys.add(`${edge.source}|${edge.target}|${edge.relation}`);
        this.addToAdjacencyList(edge.source, index);
        this.addToAdjacencyList(edge.target, index);
      });
      this.dirtyNodes.clear();
      this.savedEdgeCount = this.edges.length;
    });
  }

  /** Add a node if it doesn't already exist (must be called inside withLock/modify) */
  addNode(node: GraphNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
      this.dirtyNodes.add(node.id);
    }
  }

  /** Add an edge if an identical one doesn't already exist (must be called inside withLock/modify) */
  addEdge(edge: GraphEdge): void {
    const key = `${edge.source}|${edge.target}|${edge.relation}`;
    if (!this.edgeKeys.has(key)) {
      this.edgeKeys.add(key);
      const edgeIndex = this.edges.length;
      this.edges.push(edge);
      this.addToAdjacencyList(edge.source, edgeIndex);
      this.addToAdjacencyList(edge.target, edgeIndex);
    }
  }

  private addToAdjacencyList(nodeId: string, edgeIndex: number): void {
    if (!this.adjacencyList.has(nodeId)) {
      this.adjacencyList.set(nodeId, new Set());
    }
    this.adjacencyList.get(nodeId)!.add(edgeIndex);
  }

  /**
   * Execute a batch of graph mutations within a single transaction lock.
   * This prevents concurrency race conditions when multiple agents try to write to the graph.
   * After the mutations, it automatically saves the changes to disk.
   */
  async modify(fn: () => void | Promise<void>): Promise<void> {
    return this.withLock(async () => {
      await fn();
      await this.doSave();
    });
  }

  /** Get all edges connected to a node */
  async getNeighbors(nodeId: string): Promise<GraphEdge[]> {
    return this.withLock(async () => {
      const indices = this.adjacencyList.get(nodeId);
      if (!indices) return [];
      return Array.from(indices).map((idx) => this.edges[idx]);
    });
  }

  /**
   * Find graph edges relevant to a list of memory texts.
   * Checks if any edge's source/target node name appears within the memory text.
   * (Memory text is long like "My email is test@example.com", node id is short like "test@example.com")
   */
  async findEdgesForTexts(texts: string[], limit = 10): Promise<GraphEdge[]> {
    return this.withLock(async () => {
      if (texts.length === 0) return [];

      const lowerTexts = texts.map((t) => t.toLowerCase());

      // 1. Find matching node IDs first (O(Nodes) which is << O(Edges))
      const matchingNodes = new Set<string>();
      for (const nodeId of this.nodes.keys()) {
        const lowerId = nodeId.toLowerCase();
        if (lowerId.length < 4) continue;
        // Check if any text includes this node ID
        for (let i = 0; i < lowerTexts.length; i++) {
          if (lowerTexts[i].includes(lowerId)) {
            matchingNodes.add(nodeId);
            break;
          }
        }
      }

      if (matchingNodes.size === 0) return [];

      // 2. Fetch edges using the adjacency list O(1) per matching node
      const edgeIndices = new Set<number>();
      for (const nodeId of matchingNodes) {
        const indices = this.adjacencyList.get(nodeId);
        if (indices) {
          for (const idx of indices) edgeIndices.add(idx);
        }
      }

      const matchingEdges = Array.from(edgeIndices).map((idx) => this.edges[idx]);
      return matchingEdges.slice(0, limit);
    });
  }

  /** Total node count */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Total edge count */
  get edgeCount(): number {
    return this.edges.length;
  }

  /**
   * Get node IDs connected to a given node (both directions).
   */
  getConnectedNodes(nodeId: string): string[] {
    const connected = new Set<string>();
    // O(1) lookup via adjacency list instead of O(N) full edge scan
    const indices = this.adjacencyList.get(nodeId);
    if (indices) {
      for (const idx of indices) {
        const edge = this.edges[idx];
        if (edge.source === nodeId) connected.add(edge.target);
        if (edge.target === nodeId) connected.add(edge.source);
      }
    }
    return Array.from(connected);
  }

  /**
   * Multi-hop graph traversal.
   * Starting from seed node IDs, walk N hops collecting all connected entities.
   *
   * Example: traverse(["Python"], 2)
   *   Hop 1: Python → [Vova, Django, FastAPI]
   *   Hop 2: Vova → [Kyiv, Linux], Django → [Web]
   *   Result: [Python, Vova, Django, FastAPI, Kyiv, Linux, Web]
   *
   * Returns unique edges along the traversal path, sorted by relevance.
   */
  async traverse(
    seedNodeIds: string[],
    maxHops = 2,
    limit = 15,
  ): Promise<{ nodes: string[]; edges: GraphEdge[] }> {
    return this.withLock(async () => {
      const visitedNodes = new Set<string>(seedNodeIds);
      const collectedEdges: GraphEdge[] = [];
      const collectedEdgeKeys = new Set<string>();
      let frontier = [...seedNodeIds];

      for (let hop = 0; hop < maxHops; hop++) {
        const nextFrontier: string[] = [];

        for (const nodeId of frontier) {
          const neighborIndices = this.adjacencyList.get(nodeId);
          if (!neighborIndices) continue;
          for (const edgeIdx of neighborIndices) {
            const edge = this.edges[edgeIdx];
            // O(1) duplicate check via Set instead of O(n) Array.some
            const key = `${edge.source}|${edge.target}|${edge.relation}`;
            if (!collectedEdgeKeys.has(key)) {
              collectedEdgeKeys.add(key);
              collectedEdges.push(edge);
            }

            const otherNode = edge.source === nodeId ? edge.target : edge.source;
            if (!visitedNodes.has(otherNode)) {
              visitedNodes.add(otherNode);
              nextFrontier.push(otherNode);
            }
          }
        }

        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }

      return {
        nodes: Array.from(visitedNodes),
        edges: collectedEdges.slice(0, limit),
      };
    });
  }
}

// ============================================================================
// LLM-powered Graph Extraction
// ============================================================================

/**
 * Extract entities and relationships from text using an LLM.
 * Returns nodes and edges to add to the graph.
 */
export async function extractGraphFromText(
  text: string,
  chatModel: ChatModel,
  priority = TaskPriority.NORMAL,
  tracer: MemoryTracer,
  logger: Logger,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  // Skip very short text — not enough for meaningful extraction
  if (text.length < 25) {
    return { nodes: [], edges: [] };
  }

  const safeText = escapePrompt(text);
  const prompt = `Extract knowledge graph entities and relationships from the text below.
Return ONLY valid JSON, no markdown, no explanation.

Format:
{
  "nodes": [{"id": "EntityName", "type": "Person|Place|Concept|Tool|Language|Company|Other", "description": "short description"}],
  "edges": [{"source": "EntityName1", "target": "EntityName2", "relation": "verb_phrase"}]
}

Rules:
- Entity IDs MUST BE short, clean names (max 2-3 words)
- Entity IDs MUST BE normalized (use lowercase, e.g. "python", not "Python")
- Relations MUST BE exactly one of these allowed uppercase strings:
  [ "HAS", "LIKES", "DISLIKES", "USES", "CREATED", "KNOWS", "WORKS_AT", "IS_A", "RELATED_TO", "EXPERIENCED" ]
- If a relation doesn't fit the allowed list perfectly, map it to the closest one (e.g. "loves" -> "LIKES", "built" -> "CREATED")
- If no entities found, return {"nodes": [], "edges": []}

Text: "${JSON.stringify(safeText).slice(1, -1)}"`;

  try {
    const response = await chatModel.complete([{ role: "user", content: prompt }], true, priority);

    // Clean potential markdown wrapper
    const cleanJson = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    let data: {
      nodes?: Array<{ id?: string; type?: string; description?: string }>;
      edges?: Array<{ source?: string; target?: string; relation?: string }>;
    };

    try {
      data = JSON.parse(cleanJson);
      tracer.trace(
        "llm_graph_success",
        { nodeCount: data.nodes?.length, edgeCount: data.edges?.length },
        "LLM successfully extracted graph",
      );
    } catch (parseErr) {
      tracer.trace(
        "llm_graph_json_error",
        { raw: cleanJson },
        `Graph JSON Parse Failed: ${parseErr}. Attempting regex rescue.`,
      );
      const match = cleanJson.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          data = JSON.parse(match[0]);
          tracer.trace("llm_graph_repair_success", {}, "Successfully rescued Graph JSON via regex");
        } catch (err) {
          tracer.trace(
            "llm_graph_repair_fatal",
            { error: String(err) },
            "Graph regex rescue failed.",
          );
          throw err;
        }
      } else {
        tracer.trace("llm_graph_fatal", {}, "No JSON-like structure found in LLM Graph response.");
        throw parseErr;
      }
    }

    const allowedRelations = new Set([
      "HAS",
      "LIKES",
      "DISLIKES",
      "USES",
      "CREATED",
      "KNOWS",
      "WORKS_AT",
      "IS_A",
      "RELATED_TO",
      "EXPERIENCED",
    ]);

    const nodes: GraphNode[] = (data.nodes || [])
      .filter((n) => n.id && n.type)
      .map((n) => ({
        // Normalize IDs to lowercase + trimmed to prevent duplicate nodes (e.g. "Vova" vs "vova")
        id: String(n.id).toLowerCase().trim(),
        type: String(n.type),
        description: n.description ? String(n.description) : undefined,
      }));

    const edges: GraphEdge[] = (data.edges || [])
      .filter((e) => e.source && e.target && e.relation)
      .map((e) => ({
        source: String(e.source).toLowerCase().trim(),
        target: String(e.target).toLowerCase().trim(),
        relation: allowedRelations.has(String(e.relation).toUpperCase())
          ? String(e.relation).toUpperCase()
          : "RELATED_TO", // Fallback if LLM hallucinated a relation
        timestamp: Date.now(),
      }));

    return { nodes, edges };
  } catch (error) {
    // LLM extraction is best-effort — never fail the main operation
    logger.warn(
      `[memory-hybrid][graph] extractGraphFromText failed for: "${text.substring(0, 40)}...": ${error instanceof Error ? error.message : String(error)}`,
    );
    return { nodes: [], edges: [] };
  }
}

/**
 * Batch version of extractGraphFromText.
 * Consolidates multiple facts into a single LLM request to save API quota (High TPM/Low RPM).
 */
export async function extractGraphFromBatch(
  facts: string[],
  chatModel: ChatModel,
  priority = TaskPriority.NORMAL,
  tracer: MemoryTracer,
  logger: Logger,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (facts.length === 0) return { nodes: [], edges: [] };
  if (facts.length === 1)
    return extractGraphFromText(facts[0], chatModel, priority, tracer, logger);

  const factList = facts.map((f, i) => `${i + 1}. ${escapePrompt(f)}`).join("\n");
  const prompt = `Extract a unified knowledge graph from the multiple facts provided below.
Return ONLY valid JSON.

Format:
{
  "nodes": [{"id": "EntityName", "type": "Person|Place|Concept|Tool|Language|Company|Other", "description": "short description"}],
  "edges": [{"source": "EntityName1", "target": "EntityName2", "relation": "verb_phrase"}]
}

Rules:
- Create nodes for all distinct entities mentioned across ALL facts.
- Combine overlapping entities (e.g. "vova" and "vladimir" if they refer to the same person in context).
- IDs must be clean, normalized lowercase strings.
- Relations: [ "HAS", "LIKES", "DISLIKES", "USES", "CREATED", "KNOWS", "WORKS_AT", "IS_A", "RELATED_TO", "EXPERIENCED" ]

Facts:
${factList}`;

  try {
    const response = await chatModel.complete([{ role: "user", content: prompt }], true, priority);
    const cleanJson = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const data = JSON.parse(cleanJson);
    const allowedRelations = new Set([
      "HAS",
      "LIKES",
      "DISLIKES",
      "USES",
      "CREATED",
      "KNOWS",
      "WORKS_AT",
      "IS_A",
      "RELATED_TO",
      "EXPERIENCED",
    ]);

    const nodes: GraphNode[] = (data.nodes || [])
      .filter((n: Record<string, unknown>) => n.id && n.type)
      .map((n: Record<string, unknown>) => ({
        id: String(n.id).toLowerCase().trim(),
        type: String(n.type),
        description: n.description ? String(n.description) : undefined,
      }));

    const edges: GraphEdge[] = (data.edges || [])
      .filter((e: Record<string, unknown>) => e.source && e.target && e.relation)
      .map((e: Record<string, unknown>) => ({
        source: String(e.source).toLowerCase().trim(),
        target: String(e.target).toLowerCase().trim(),
        relation: allowedRelations.has(String(e.relation).toUpperCase())
          ? String(e.relation).toUpperCase()
          : "RELATED_TO",
        timestamp: Date.now(),
      }));

    return { nodes, edges };
  } catch (error) {
    logger.warn(`[memory-hybrid][graph] extractGraphFromBatch failed: ${String(error)}`);
    return { nodes: [], edges: [] };
  }
}

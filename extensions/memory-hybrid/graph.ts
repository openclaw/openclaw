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

import { readFile, writeFile, appendFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ChatModel } from "./chat.js";
import { tracer } from "./tracer.js";

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
  /** Set of composite keys for O(1) edge dedup: "source|target|relation" */
  private edgeKeys: Set<string> = new Set();
  private filePath: string;
  private legacyJsonPath: string;
  private loaded = false;
  private mutex = Promise.resolve();

  /** Track new (unsaved) nodes and edges for append-only writes */
  private dirtyNodes: Set<string> = new Set();
  private savedEdgeCount = 0;

  constructor(basePath: string) {
    // Save graph.jsonl next to the lancedb folder
    this.filePath = join(dirname(basePath), "graph.jsonl");
    this.legacyJsonPath = join(dirname(basePath), "graph.json");
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
                this.edges.push(edge);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
        this.savedEdgeCount = this.edges.length;
        this.loaded = true;
        return;
      } catch {
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
            this.edges.push(e);
          }
        }

        // Mark everything as dirty so first save() writes full JSONL
        for (const n of this.nodes.keys()) this.dirtyNodes.add(n);
        this.savedEdgeCount = 0;
        migrated = true;

        console.warn(
          `[memory-hybrid][graph] Migrated legacy graph.json → graph.jsonl (${this.nodes.size} nodes, ${this.edges.length} edges)`,
        );
      } catch {
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
      await writeFile(this.filePath, lines.join("\n") + "\n", "utf-8");
      this.edgeKeys.clear();
      for (const edge of this.edges) {
        this.edgeKeys.add(`${edge.source}|${edge.target}|${edge.relation}`);
      }
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
      this.edges.push(edge);
    }
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
      return this.edges.filter((e) => e.source === nodeId || e.target === nodeId);
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

      // Case-insensitive matching
      const lowerTexts = texts.map((t) => t.toLowerCase());

      // Require entity names to be at least 3 chars to avoid false positives
      // (e.g. a node named "is" would match every text)
      const matching = this.edges.filter((e) =>
        lowerTexts.some(
          (text) =>
            (e.source.length >= 4 && text.includes(e.source.toLowerCase())) ||
            (e.target.length >= 4 && text.includes(e.target.toLowerCase())),
        ),
      );

      return matching.slice(0, limit);
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
    for (const edge of this.edges) {
      if (edge.source === nodeId) connected.add(edge.target);
      if (edge.target === nodeId) connected.add(edge.source);
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
      let frontier = [...seedNodeIds];

      for (let hop = 0; hop < maxHops; hop++) {
        const nextFrontier: string[] = [];

        for (const nodeId of frontier) {
          const neighbors = this.edges.filter((e) => e.source === nodeId || e.target === nodeId);
          for (const edge of neighbors) {
            // Avoid collecting duplicate edges
            if (
              !collectedEdges.some(
                (e) =>
                  e.source === edge.source &&
                  e.target === edge.target &&
                  e.relation === edge.relation,
              )
            ) {
              collectedEdges.push(edge);
            }

            // Discover new nodes
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
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  // Skip very short text — not enough for meaningful extraction
  if (text.length < 25) {
    return { nodes: [], edges: [] };
  }

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

Text: "${JSON.stringify(text).slice(1, -1)}"`;

  try {
    const response = await chatModel.complete([{ role: "user", content: prompt }], true);

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
        } catch (e) {
          tracer.trace(
            "llm_graph_repair_fatal",
            { error: String(e) },
            "Graph regex rescue failed.",
          );
          throw e;
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
    console.warn(
      `[memory-hybrid][graph] extractGraphFromText failed for: "${text.substring(0, 40)}..."`,
      error instanceof Error ? error.message : String(error),
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
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (facts.length === 0) return { nodes: [], edges: [] };
  if (facts.length === 1) return extractGraphFromText(facts[0], chatModel);

  const factList = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
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
    const response = await chatModel.complete([{ role: "user", content: prompt }], true);
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
      .filter((n: any) => n.id && n.type)
      .map((n: any) => ({
        id: String(n.id).toLowerCase().trim(),
        type: String(n.type),
        description: n.description ? String(n.description) : undefined,
      }));

    const edges: GraphEdge[] = (data.edges || [])
      .filter((e: any) => e.source && e.target && e.relation)
      .map((e: any) => ({
        source: String(e.source).toLowerCase().trim(),
        target: String(e.target).toLowerCase().trim(),
        relation: allowedRelations.has(String(e.relation).toUpperCase())
          ? String(e.relation).toUpperCase()
          : "RELATED_TO",
        timestamp: Date.now(),
      }));

    return { nodes, edges };
  } catch (error) {
    console.warn(`[memory-hybrid][graph] extractGraphFromBatch failed:`, String(error));
    return { nodes: [], edges: [] };
  }
}

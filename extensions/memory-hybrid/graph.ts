/**
 * Knowledge Graph Module
 *
 * Stores entities (people, places, concepts) and their relationships
 * in a simple JSON file alongside the LanceDB database.
 *
 * Example:
 *   Node: { id: "Vova", type: "Person", description: "The user" }
 *   Edge: { source: "Vova", target: "Python", relation: "knows", timestamp: 1708123456 }
 *
 * Used by:
 * - processAndStoreMemory(): extracts entities & relations via LLM after storing a memory
 * - recall(): enriches search results with graph connections
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ChatModel } from "./chat.js";

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
  private filePath: string;
  private loaded = false;
  private mutex = Promise.resolve();

  constructor(basePath: string) {
    // Save graph.json next to the lancedb folder
    this.filePath = join(dirname(basePath), "graph.json");
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

  /** Load graph from disk (lazy, only on first access) */
  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;

      try {
        await access(this.filePath);
        const raw = await readFile(this.filePath, "utf-8");
        const data = JSON.parse(raw) as GraphData;

        // Merge with existing in-memory nodes/edges if any (rare but possible)
        for (const n of data.nodes) {
          if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
        }

        // Add edges that aren't already present
        for (const e of data.edges || []) {
          const exists = this.edges.some(
            (existing) =>
              existing.source === e.source &&
              existing.target === e.target &&
              existing.relation === e.relation,
          );
          if (!exists) this.edges.push(e);
        }
      } catch {
        // File doesn't exist yet or is invalid — start fresh
        // Keep existing in-memory state
      }

      this.loaded = true;
    });
  }

  /** Persist graph to disk (async, atomic) */
  async save(): Promise<void> {
    return this.withLock(async () => {
      // Always re-read from disk before saving to prevent overwriting other processes' changes
      // (Optimistic locking strategy would be better but simple re-read is safer for now)
      try {
        await access(this.filePath);
        const raw = await readFile(this.filePath, "utf-8");
        const onDisk = JSON.parse(raw) as GraphData;

        // Merge disk -> memory
        for (const n of onDisk.nodes) {
          if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
        }
        const existingEdgesStr = new Set(
          this.edges.map((e) => `${e.source}|${e.target}|${e.relation}`),
        );
        for (const e of onDisk.edges || []) {
          const key = `${e.source}|${e.target}|${e.relation}`;
          if (!existingEdgesStr.has(key)) {
            this.edges.push(e);
            existingEdgesStr.add(key);
          }
        }
      } catch {
        // File doesn't exist, safe to write our full state
      }

      const data: GraphData = {
        nodes: Array.from(this.nodes.values()),
        edges: this.edges,
      };
      await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    });
  }

  /** Add a node if it doesn't already exist */
  addNode(node: GraphNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  /** Add an edge if an identical one doesn't already exist */
  addEdge(edge: GraphEdge): void {
    const exists = this.edges.some(
      (e) => e.source === edge.source && e.target === edge.target && e.relation === edge.relation,
    );
    if (!exists) {
      this.edges.push(edge);
    }
  }

  /** Get all edges connected to a node */
  getNeighbors(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.source === nodeId || e.target === nodeId);
  }

  /**
   * Find graph edges relevant to a list of memory texts.
   * Checks if any edge's source/target node name appears within the memory text.
   * (Memory text is long like "My email is test@example.com", node id is short like "test@example.com")
   */
  findEdgesForTexts(texts: string[], limit = 10): GraphEdge[] {
    if (texts.length === 0) return [];

    // Case-insensitive matching
    const lowerTexts = texts.map((t) => t.toLowerCase());

    // Require entity names to be at least 3 chars to avoid false positives
    // (e.g. a node named "is" would match every text)
    const matching = this.edges.filter((e) =>
      lowerTexts.some(
        (text) =>
          (e.source.length >= 3 && text.includes(e.source.toLowerCase())) ||
          (e.target.length >= 3 && text.includes(e.target.toLowerCase())),
      ),
    );

    return matching.slice(0, limit);
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
  traverse(
    seedNodeIds: string[],
    maxHops = 2,
    limit = 15,
  ): { nodes: string[]; edges: GraphEdge[] } {
    const visitedNodes = new Set<string>(seedNodeIds);
    const collectedEdges: GraphEdge[] = [];
    let frontier = [...seedNodeIds];

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const neighbors = this.getNeighbors(nodeId);
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
- Entity IDs should be short, clean names (not full sentences)
- Relations should be short verb phrases like "knows", "prefers", "uses", "works_at"
- If no entities found, return {"nodes": [], "edges": []}

Text: "${text.replace(/"/g, '\\"')}"`;

  try {
    const response = await chatModel.complete([{ role: "user", content: prompt }], true);

    // Clean potential markdown wrapper
    const cleanJson = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const data = JSON.parse(cleanJson) as {
      nodes?: Array<{ id?: string; type?: string; description?: string }>;
      edges?: Array<{ source?: string; target?: string; relation?: string }>;
    };

    const nodes: GraphNode[] = (data.nodes || [])
      .filter((n) => n.id && n.type)
      .map((n) => ({
        id: String(n.id),
        type: String(n.type),
        description: n.description ? String(n.description) : undefined,
      }));

    const edges: GraphEdge[] = (data.edges || [])
      .filter((e) => e.source && e.target && e.relation)
      .map((e) => ({
        source: String(e.source),
        target: String(e.target),
        relation: String(e.relation),
        timestamp: Date.now(),
      }));

    return { nodes, edges };
  } catch {
    // LLM extraction is best-effort — never fail the main operation
    return { nodes: [], edges: [] };
  }
}

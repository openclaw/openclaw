/**
 * Cognitive Lattice — Structured AGI cognition for OpenClaw.
 *
 * Core philosophy (认知格哲学):
 *   Known  = verified practical knowledge (真实物理路径)
 *   Unknown = unfalsifiable concepts requiring decomposition
 *
 * Four-direction collision (四向碰撞):
 *   ↓ Top-down:  Decompose unfalsifiable → falsifiable → known
 *   ↑ Bottom-up: Combine known nodes → new higher-level questions
 *   ← → Horizontal: Cross-domain overlap discovery
 *   ⟳ Cycle: Collision produces new nodes → next collision → infinite growth
 *
 * Human concretization (人类具现化):
 *   Domain-expert humans turn fuzzy concepts into concrete verifiable nodes.
 *   AI generates practice lists for humans to verify.
 *   Humans enrich AI cognition through practice and imagination.
 *
 * 来源：中国.上海.赵致博
 */

// ── Node status lifecycle ────────────────────────────────────────────────────

export type NodeStatus =
  /** Verified practical knowledge — a real physical path humans can execute. */
  | "known"
  /** Unverified assertion awaiting decomposition or verification. */
  | "hypothesis"
  /** Disproven through practice or logical contradiction. */
  | "falsified"
  /** Verified through human practice — the strongest status. */
  | "proven";

// ── Core types ───────────────────────────────────────────────────────────────

export type CognitiveNode = {
  id: string;
  content: string;
  domain: string;
  status: NodeStatus;
  /** Whether this node can be directly verified through practice. */
  canVerify: boolean;
  /** Decomposition depth (0 = root question, higher = more concrete). */
  depth: number;
  parentId?: string;
  source?: string;
  createdAt: string;
};

export type CollisionType =
  /** Vertical collision: top-down meets bottom-up (decomposition ↔ synthesis). */
  | "vertical"
  /** Horizontal collision: cross-domain overlap discovery (left ↔ right). */
  | "horizontal";

export type NodeRelation = {
  nodeAId: string;
  nodeBId: string;
  relationType: CollisionType;
  confidence: number;
  description: string;
};

export type CollisionResult = {
  hasOverlap: boolean;
  overlapType: CollisionType | "none";
  relationDescription: string;
  newInsight?: string;
  confidence: number;
};

export type DecomposedItem = {
  content: string;
  canVerify: boolean;
  domain: string;
  depth: number;
  reasoning: string;
};

export type SynthesizedQuestion = {
  question: string;
  potentialDomain: string;
  crossDomain: boolean;
  sourceInsight: string;
};

export type PracticeItem = {
  step: number;
  action: string;
  verifyMethod: string;
  timeEstimate: string;
  domain: string;
};

export type HallucinationCheckResult = {
  overallReliable: boolean;
  verifiedParts: string[];
  hypothesisParts: string[];
  rejectedParts: string[];
  cleanedResponse: string;
  confidence: number;
  honestLimitations: string[];
};

export type GrowthCycleResult = {
  bottomUpQuestions: SynthesizedQuestion[];
  topDownDecompositions: Array<{
    question: string;
    results: DecomposedItem[];
  }>;
  crossDomainCollisions: Array<{
    nodeA: string;
    nodeB: string;
    overlap: string;
    newInsight: string;
  }>;
};

// ── Pure logic utilities ─────────────────────────────────────────────────────

/**
 * Classify whether a statement is likely directly verifiable through practice,
 * or whether it remains an abstract hypothesis requiring further decomposition.
 *
 * Verifiable nodes describe concrete actions a human can execute:
 *   ✓ "Run `npm test` and check all tests pass"
 *   ✓ "Survey 100 people in the target area"
 *   ✗ "Achieve product-market fit" (too abstract)
 */
export function classifyVerifiability(content: string): boolean {
  const concretePatterns = [
    // Action verbs indicating direct executability
    /^(run|execute|create|write|build|test|measure|count|install|configure|deploy|check|verify|record|open|send|call)\b/i,
    // Contains specific quantities or time bounds
    /\d+\s*(人|次|个|天|小时|分钟|秒|minutes?|hours?|days?|times?|items?|people)/i,
    // Contains file paths, commands, or URLs
    /[/\\][\w.-]+\.\w+|`[^`]+`|https?:\/\//,
  ];
  const abstractPatterns = [
    // Question form or subjunctive
    /^(如何|怎[么样]|为什么|是否|how|why|whether|should|could|would)\b/i,
    // Abstract goals without concrete steps
    /\b(成功|最佳|完美|优化|提升|理想|achieve|optimize|perfect|ideal|best)\b/i,
  ];

  const concreteScore = concretePatterns.filter((p) => p.test(content)).length;
  const abstractScore = abstractPatterns.filter((p) => p.test(content)).length;

  return concreteScore > abstractScore;
}

/**
 * Determine if two nodes likely belong to the same domain.
 * Used to distinguish vertical (same-domain) from horizontal (cross-domain) collisions.
 */
export function isSameDomain(domainA: string, domainB: string): boolean {
  if (!domainA || !domainB) {
    return false;
  }
  const a = domainA.trim().toLowerCase();
  const b = domainB.trim().toLowerCase();
  if (a === b) {
    return true;
  }
  // Check if one contains the other (e.g., "programming" and "programming/typescript")
  return a.includes(b) || b.includes(a);
}

/**
 * Classify the collision type between two nodes based on their domains and depths.
 */
export function classifyCollisionType(
  nodeA: Pick<CognitiveNode, "domain" | "depth">,
  nodeB: Pick<CognitiveNode, "domain" | "depth">,
): CollisionType {
  if (isSameDomain(nodeA.domain, nodeB.domain)) {
    // Same domain: vertical collision (decomposition ↔ synthesis)
    return "vertical";
  }
  // Different domains: horizontal collision (cross-domain overlap)
  return "horizontal";
}

/**
 * Compute a simple overlap score between two text contents.
 * Returns a value between 0 (no overlap) and 1 (identical).
 * Uses token-level Jaccard similarity as a lightweight heuristic.
 */
export function computeTextOverlap(contentA: string, contentB: string): number {
  const tokenize = (text: string): Set<string> => {
    const tokens = text
      .toLowerCase()
      .split(/[\s,;.!?，。！？、；：:]+/)
      .filter((t) => t.length > 1);
    return new Set(tokens);
  };

  const setA = tokenize(contentA);
  const setB = tokenize(contentB);

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Filter nodes that are candidates for bottom-up synthesis.
 * Only known/proven nodes with canVerify=true are valid foundations.
 */
export function selectSynthesisCandidates(
  nodes: CognitiveNode[],
): CognitiveNode[] {
  return nodes.filter(
    (n) => (n.status === "known" || n.status === "proven") && n.canVerify,
  );
}

/**
 * Find node pairs across different domains that might produce cross-domain insights.
 * Returns pairs sorted by text overlap score (highest first).
 */
export function findCrossDomainCandidates(
  nodes: CognitiveNode[],
  opts?: { minOverlap?: number; maxPairs?: number },
): Array<{ nodeA: CognitiveNode; nodeB: CognitiveNode; overlap: number }> {
  const minOverlap = opts?.minOverlap ?? 0.1;
  const maxPairs = opts?.maxPairs ?? 20;
  const candidates: Array<{ nodeA: CognitiveNode; nodeB: CognitiveNode; overlap: number }> = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const nodeA = nodes[i];
      const nodeB = nodes[j];
      if (isSameDomain(nodeA.domain, nodeB.domain)) {
        continue;
      }
      const overlap = computeTextOverlap(nodeA.content, nodeB.content);
      if (overlap >= minOverlap) {
        candidates.push({ nodeA, nodeB, overlap });
      }
    }
  }

  candidates.sort((a, b) => b.overlap - a.overlap);
  return candidates.slice(0, maxPairs);
}

/**
 * Build a decomposition tree from a flat list of decomposed items.
 * Groups items by depth level for structured display.
 */
export function buildDecompositionTree(
  items: DecomposedItem[],
): Map<number, DecomposedItem[]> {
  const tree = new Map<number, DecomposedItem[]>();
  for (const item of items) {
    const level = tree.get(item.depth) ?? [];
    level.push(item);
    tree.set(item.depth, level);
  }
  return tree;
}

/**
 * Determine whether a question needs further decomposition.
 * A question needs decomposition if it cannot be directly verified
 * and has not been falsified.
 */
export function needsDecomposition(node: Pick<CognitiveNode, "canVerify" | "status">): boolean {
  if (node.status === "falsified") {
    return false;
  }
  return !node.canVerify;
}

/**
 * Generate a unique node ID based on content hash.
 */
export function generateNodeId(content: string, domain: string): string {
  let hash = 0;
  const str = `${domain}:${content}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `node_${hex}`;
}

/**
 * Create a new CognitiveNode from raw content.
 */
export function createNode(
  content: string,
  domain: string,
  opts?: {
    status?: NodeStatus;
    parentId?: string;
    depth?: number;
    source?: string;
  },
): CognitiveNode {
  const canVerify = classifyVerifiability(content);
  return {
    id: generateNodeId(content, domain),
    content,
    domain,
    status: opts?.status ?? (canVerify ? "known" : "hypothesis"),
    canVerify,
    depth: opts?.depth ?? 0,
    parentId: opts?.parentId,
    source: opts?.source,
    createdAt: new Date().toISOString(),
  };
}

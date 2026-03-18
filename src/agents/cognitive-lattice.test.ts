import { describe, expect, it } from "vitest";
import {
  buildDecompositionTree,
  classifyCollisionType,
  classifyVerifiability,
  computeTextOverlap,
  createNode,
  findCrossDomainCandidates,
  generateNodeId,
  isSameDomain,
  needsDecomposition,
  selectSynthesisCandidates,
  type CognitiveNode,
  type DecomposedItem,
} from "./cognitive-lattice.js";

describe("classifyVerifiability", () => {
  it("classifies concrete executable actions as verifiable", () => {
    expect(classifyVerifiability("Run `npm test` and check all tests pass")).toBe(true);
    expect(classifyVerifiability("Create a file named config.json")).toBe(true);
    expect(classifyVerifiability("Execute the deployment script at /scripts/deploy.sh")).toBe(true);
    expect(classifyVerifiability("Record daily expenses for 30 days")).toBe(true);
    expect(classifyVerifiability("Survey 100 people in the target area")).toBe(true);
  });

  it("classifies abstract questions as not verifiable", () => {
    expect(classifyVerifiability("How to achieve success in business")).toBe(false);
    expect(classifyVerifiability("Why is optimization important")).toBe(false);
    expect(classifyVerifiability("如何创业成功")).toBe(false);
    expect(classifyVerifiability("Whether we should use microservices")).toBe(false);
  });

  it("handles edge cases", () => {
    expect(classifyVerifiability("")).toBe(false);
    // "test" starts with the action verb pattern, so it is classified as verifiable
    expect(classifyVerifiability("test")).toBe(true);
    expect(classifyVerifiability("some vague idea")).toBe(false);
  });
});

describe("isSameDomain", () => {
  it("detects identical domains", () => {
    expect(isSameDomain("programming", "programming")).toBe(true);
    expect(isSameDomain("Programming", "programming")).toBe(true);
  });

  it("detects sub-domain relationships", () => {
    expect(isSameDomain("programming", "programming/typescript")).toBe(true);
    expect(isSameDomain("programming/typescript", "programming")).toBe(true);
  });

  it("rejects different domains", () => {
    expect(isSameDomain("programming", "cooking")).toBe(false);
    expect(isSameDomain("finance", "healthcare")).toBe(false);
  });

  it("handles empty domains", () => {
    expect(isSameDomain("", "programming")).toBe(false);
    expect(isSameDomain("programming", "")).toBe(false);
  });
});

describe("classifyCollisionType", () => {
  it("classifies same-domain nodes as vertical collision", () => {
    const result = classifyCollisionType(
      { domain: "programming", depth: 0 },
      { domain: "programming", depth: 2 },
    );
    expect(result).toBe("vertical");
  });

  it("classifies cross-domain nodes as horizontal collision", () => {
    const result = classifyCollisionType(
      { domain: "programming", depth: 0 },
      { domain: "cooking", depth: 0 },
    );
    expect(result).toBe("horizontal");
  });
});

describe("computeTextOverlap", () => {
  it("returns 1 for identical texts", () => {
    expect(computeTextOverlap("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different texts", () => {
    expect(computeTextOverlap("programming code", "cooking recipe")).toBe(0);
  });

  it("returns partial overlap for texts with shared tokens", () => {
    const overlap = computeTextOverlap(
      "single responsibility principle in programming",
      "single responsibility in project management",
    );
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(1);
  });

  it("returns 0 for empty strings", () => {
    expect(computeTextOverlap("", "hello")).toBe(0);
    expect(computeTextOverlap("hello", "")).toBe(0);
  });
});

describe("selectSynthesisCandidates", () => {
  it("selects only known/proven verifiable nodes", () => {
    const nodes: CognitiveNode[] = [
      createNode("Run npm test", "programming", { status: "known" }),
      createNode("How to optimize performance", "programming", { status: "hypothesis" }),
      createNode("Check https://api.example.com returns 200", "testing", { status: "proven" }),
      createNode("This approach failed", "testing", { status: "falsified" }),
    ];

    const candidates = selectSynthesisCandidates(nodes);

    expect(candidates.length).toBe(2);
    expect(candidates.every((n) => n.status === "known" || n.status === "proven")).toBe(true);
    expect(candidates.every((n) => n.canVerify)).toBe(true);
  });
});

describe("findCrossDomainCandidates", () => {
  it("finds cross-domain node pairs with text overlap", () => {
    const nodes: CognitiveNode[] = [
      createNode("single responsibility: each module does one thing", "programming"),
      createNode("each stall sells only one type of product for efficiency", "vending"),
      createNode("learn to cook a new recipe", "cooking"),
    ];

    const candidates = findCrossDomainCandidates(nodes, { minOverlap: 0.01 });

    expect(candidates.length).toBeGreaterThan(0);
    // Programming and vending should have overlap (both mention "one/single" concept)
    const progVend = candidates.find(
      (c) =>
        (c.nodeA.domain === "programming" && c.nodeB.domain === "vending") ||
        (c.nodeA.domain === "vending" && c.nodeB.domain === "programming"),
    );
    expect(progVend).toBeDefined();
  });

  it("excludes same-domain pairs", () => {
    const nodes: CognitiveNode[] = [
      createNode("write unit tests", "programming"),
      createNode("write integration tests", "programming"),
    ];

    const candidates = findCrossDomainCandidates(nodes);
    expect(candidates.length).toBe(0);
  });

  it("respects maxPairs limit", () => {
    const nodes: CognitiveNode[] = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(createNode(`shared concept variant ${i}`, `domain-${i}`));
    }

    const candidates = findCrossDomainCandidates(nodes, { minOverlap: 0, maxPairs: 5 });
    expect(candidates.length).toBeLessThanOrEqual(5);
  });
});

describe("buildDecompositionTree", () => {
  it("groups decomposed items by depth level", () => {
    const items: DecomposedItem[] = [
      { content: "Level 0 A", canVerify: false, domain: "test", depth: 0, reasoning: "root" },
      { content: "Level 0 B", canVerify: false, domain: "test", depth: 0, reasoning: "root" },
      { content: "Level 1 A", canVerify: true, domain: "test", depth: 1, reasoning: "sub" },
      { content: "Level 2 A", canVerify: true, domain: "test", depth: 2, reasoning: "leaf" },
    ];

    const tree = buildDecompositionTree(items);

    expect(tree.get(0)?.length).toBe(2);
    expect(tree.get(1)?.length).toBe(1);
    expect(tree.get(2)?.length).toBe(1);
    expect(tree.has(3)).toBe(false);
  });
});

describe("needsDecomposition", () => {
  it("returns true for non-verifiable hypothesis nodes", () => {
    expect(needsDecomposition({ canVerify: false, status: "hypothesis" })).toBe(true);
  });

  it("returns false for verifiable nodes", () => {
    expect(needsDecomposition({ canVerify: true, status: "known" })).toBe(false);
  });

  it("returns false for falsified nodes", () => {
    expect(needsDecomposition({ canVerify: false, status: "falsified" })).toBe(false);
  });
});

describe("generateNodeId", () => {
  it("generates consistent IDs for the same content+domain", () => {
    const id1 = generateNodeId("test content", "test domain");
    const id2 = generateNodeId("test content", "test domain");
    expect(id1).toBe(id2);
  });

  it("generates different IDs for different content", () => {
    const id1 = generateNodeId("content A", "domain");
    const id2 = generateNodeId("content B", "domain");
    expect(id1).not.toBe(id2);
  });

  it("generates IDs with the node_ prefix", () => {
    const id = generateNodeId("test", "test");
    expect(id).toMatch(/^node_[0-9a-f]{8}$/);
  });
});

describe("createNode", () => {
  it("creates a node with auto-classified verifiability", () => {
    const node = createNode("Run `npm test` and verify output", "programming");
    expect(node.canVerify).toBe(true);
    expect(node.status).toBe("known");
    expect(node.domain).toBe("programming");
    expect(node.depth).toBe(0);
  });

  it("creates a hypothesis node for abstract content", () => {
    const node = createNode("How to build a successful startup", "business");
    expect(node.canVerify).toBe(false);
    expect(node.status).toBe("hypothesis");
  });

  it("respects explicit status override", () => {
    const node = createNode("some content", "domain", { status: "proven" });
    expect(node.status).toBe("proven");
  });

  it("sets parentId and depth from options", () => {
    const node = createNode("sub-question", "domain", {
      parentId: "parent_123",
      depth: 2,
    });
    expect(node.parentId).toBe("parent_123");
    expect(node.depth).toBe(2);
  });
});

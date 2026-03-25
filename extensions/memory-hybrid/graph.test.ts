import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { GraphDB, type GraphEdge } from "./graph.js";

const TEST_DIR = join(process.cwd(), ".memory", "test_graph_db");

describe("GraphDB.traverse", () => {
  let testCount = 0;

  async function makeGraph(): Promise<GraphDB> {
    testCount++;
    const path = join(TEST_DIR, `test_${testCount}`);
    await mkdir(path, { recursive: true });
    const graph = new GraphDB(path);
    await graph.load();

    // Build a test graph in a single modification block (thread-safe)
    await graph.modify(() => {
      graph.addNode({ id: "Vova", type: "Person" });
      graph.addNode({ id: "Python", type: "Language" });
      graph.addNode({ id: "Kyiv", type: "City" });
      graph.addNode({ id: "Django", type: "Framework" });
      graph.addNode({ id: "Web", type: "Concept" });
      graph.addNode({ id: "Ukraine", type: "Country" });

      graph.addEdge({ source: "Vova", target: "Python", relation: "uses", timestamp: 1 });
      graph.addEdge({ source: "Vova", target: "Kyiv", relation: "lives_in", timestamp: 2 });
      graph.addEdge({ source: "Python", target: "Django", relation: "framework", timestamp: 3 });
      graph.addEdge({ source: "Django", target: "Web", relation: "type", timestamp: 4 });
      graph.addEdge({ source: "Kyiv", target: "Ukraine", relation: "country", timestamp: 5 });
    });

    return graph;
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  test("1-hop should return direct neighbors", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse(["Vova"], 1);

    expect(result.nodes).toContain("Vova");
    expect(result.nodes).toContain("Python");
    expect(result.nodes).toContain("Kyiv");
    expect(result.nodes).not.toContain("Django"); // 2 hops away
    expect(result.edges.length).toBe(2);
  });

  test("2-hop should reach 2nd-degree connections", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse(["Vova"], 2);

    expect(result.nodes).toContain("Vova");
    expect(result.nodes).toContain("Python");
    expect(result.nodes).toContain("Kyiv");
    expect(result.nodes).toContain("Django"); // via Python
    expect(result.nodes).toContain("Ukraine"); // via Kyiv
    expect(result.nodes).not.toContain("Web"); // 3 hops away
  });

  test("3-hop should reach Web", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse(["Vova"], 3);

    expect(result.nodes).toContain("Web");
  });

  test("should not duplicate edges", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse(["Vova"], 3);

    const edgeKeys = result.edges.map((e) => `${e.source}-${e.relation}-${e.target}`);
    const unique = new Set(edgeKeys);
    expect(unique.size).toBe(edgeKeys.length);
  });

  test("empty seed should return empty result", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse([], 2);

    expect(result.nodes.length).toBe(0);
    expect(result.edges.length).toBe(0);
  });

  test("non-existent seed should return just the seed", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse(["NonExistent"], 2);

    expect(result.nodes).toContain("NonExistent");
    expect(result.edges.length).toBe(0);
  });

  test("getConnectedNodes should return neighbors", async () => {
    const graph = await makeGraph();
    const connected = graph.getConnectedNodes("Vova");

    expect(connected).toContain("Python");
    expect(connected).toContain("Kyiv");
    expect(connected).not.toContain("Django");
  });

  test("limit should cap edges", async () => {
    const graph = await makeGraph();
    const result = await graph.traverse(["Vova"], 3, 2);

    expect(result.edges.length).toBeLessThanOrEqual(2);
  });
});

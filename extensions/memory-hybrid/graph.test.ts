import { describe, test, expect } from "vitest";
import { GraphDB } from "./graph.js";

describe("GraphDB.traverse", () => {
  function makeGraph(): GraphDB {
    const graph = new GraphDB("/tmp/test");
    // Build a test graph:
    //   Vova --uses--> Python
    //   Vova --lives_in--> Kyiv
    //   Python --framework--> Django
    //   Django --type--> Web
    //   Kyiv --country--> Ukraine
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

    return graph;
  }

  test("1-hop should return direct neighbors", () => {
    const graph = makeGraph();
    const result = graph.traverse(["Vova"], 1);

    expect(result.nodes).toContain("Vova");
    expect(result.nodes).toContain("Python");
    expect(result.nodes).toContain("Kyiv");
    expect(result.nodes).not.toContain("Django"); // 2 hops away
    expect(result.edges.length).toBe(2);
  });

  test("2-hop should reach 2nd-degree connections", () => {
    const graph = makeGraph();
    const result = graph.traverse(["Vova"], 2);

    expect(result.nodes).toContain("Vova");
    expect(result.nodes).toContain("Python");
    expect(result.nodes).toContain("Kyiv");
    expect(result.nodes).toContain("Django"); // via Python
    expect(result.nodes).toContain("Ukraine"); // via Kyiv
    expect(result.nodes).not.toContain("Web"); // 3 hops away
  });

  test("3-hop should reach Web", () => {
    const graph = makeGraph();
    const result = graph.traverse(["Vova"], 3);

    expect(result.nodes).toContain("Web");
  });

  test("should not duplicate edges", () => {
    const graph = makeGraph();
    const result = graph.traverse(["Vova"], 3);

    const edgeKeys = result.edges.map(
      (e) => `${e.source}-${e.relation}-${e.target}`,
    );
    const unique = new Set(edgeKeys);
    expect(unique.size).toBe(edgeKeys.length);
  });

  test("empty seed should return empty result", () => {
    const graph = makeGraph();
    const result = graph.traverse([], 2);

    expect(result.nodes.length).toBe(0);
    expect(result.edges.length).toBe(0);
  });

  test("non-existent seed should return just the seed", () => {
    const graph = makeGraph();
    const result = graph.traverse(["NonExistent"], 2);

    expect(result.nodes).toContain("NonExistent");
    expect(result.edges.length).toBe(0);
  });

  test("getConnectedNodes should return neighbors", () => {
    const graph = makeGraph();
    const connected = graph.getConnectedNodes("Vova");

    expect(connected).toContain("Python");
    expect(connected).toContain("Kyiv");
    expect(connected).not.toContain("Django");
  });

  test("limit should cap edges", () => {
    const graph = makeGraph();
    const result = graph.traverse(["Vova"], 3, 2);

    expect(result.edges.length).toBeLessThanOrEqual(2);
  });
});

import { describe, expect, it } from "vitest";
import { createNode } from "./cognitive-lattice.js";
import {
  buildBottomUpSynthesizePrompt,
  buildCognitiveLatticeSystemPrompt,
  buildCollisionAnalysisPrompt,
  buildGrowthCyclePrompt,
  buildHallucinationCheckPrompt,
  buildPracticeListPrompt,
  buildSolutionSynthesisPrompt,
  buildTopDownDecomposePrompt,
} from "./cognitive-lattice-prompts.js";

describe("buildCognitiveLatticeSystemPrompt", () => {
  it("includes the cognitive lattice identity", () => {
    const prompt = buildCognitiveLatticeSystemPrompt();
    expect(prompt).toContain("Cognitive Lattice");
    expect(prompt).toContain("Four-Direction Collision");
    expect(prompt).toContain("human input");
  });
});

describe("buildTopDownDecomposePrompt", () => {
  it("builds a valid decomposition prompt", () => {
    const messages = buildTopDownDecomposePrompt("How to build a web application");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("How to build a web application");
    expect(messages[1].content).toContain("Top-Down Decomposition");
    expect(messages[1].content).toContain("canVerify");
  });

  it("includes known nodes context when provided", () => {
    const knownNodes = [
      createNode("Run npm install", "programming", { status: "known" }),
      createNode("Configure TypeScript", "programming", { status: "proven" }),
    ];
    const messages = buildTopDownDecomposePrompt("How to set up a project", knownNodes);
    expect(messages[1].content).toContain("Run npm install");
    expect(messages[1].content).toContain("Configure TypeScript");
    expect(messages[1].content).toContain("Known related nodes");
  });
});

describe("buildBottomUpSynthesizePrompt", () => {
  it("builds a valid synthesis prompt", () => {
    const messages = buildBottomUpSynthesizePrompt(
      "Functions should do only one thing",
      "programming",
      ["programming", "management", "cooking"],
    );
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Bottom-Up Synthesis");
    expect(messages[1].content).toContain("Functions should do only one thing");
    expect(messages[1].content).toContain("programming, management, cooking");
  });

  it("works without domain list", () => {
    const messages = buildBottomUpSynthesizePrompt("known fact", "science");
    expect(messages[1].content).not.toContain("Domains currently covered");
  });
});

describe("buildCollisionAnalysisPrompt", () => {
  it("builds a valid collision analysis prompt", () => {
    const messages = buildCollisionAnalysisPrompt(
      { content: "Single responsibility principle", domain: "programming" },
      { content: "One stall sells one product type", domain: "vending" },
    );
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Collision Analysis");
    expect(messages[1].content).toContain("programming");
    expect(messages[1].content).toContain("vending");
    expect(messages[1].content).toContain("hasOverlap");
  });
});

describe("buildPracticeListPrompt", () => {
  it("builds a valid practice list prompt", () => {
    const messages = buildPracticeListPrompt("Set up CI/CD pipeline", "devops");
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Practice List");
    expect(messages[1].content).toContain("Set up CI/CD pipeline");
    expect(messages[1].content).toContain("verifyMethod");
  });

  it("includes related nodes when provided", () => {
    const related = [createNode("Install GitHub Actions", "devops", { status: "known" })];
    const messages = buildPracticeListPrompt("Set up CI/CD pipeline", "devops", related);
    expect(messages[1].content).toContain("Install GitHub Actions");
  });
});

describe("buildHallucinationCheckPrompt", () => {
  it("builds a valid hallucination check prompt with proven nodes", () => {
    const provenNodes = [
      createNode("Run npm test passes all 21 tests", "testing", { status: "proven" }),
    ];
    const messages = buildHallucinationCheckPrompt(
      "You should use npm test to run tests, and also use jest directly",
      provenNodes,
      "How to run tests?",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("truth gatekeeper");
    expect(messages[0].content).toContain("overallReliable");
    expect(messages[1].content).toContain("npm test passes all 21 tests");
  });

  it("handles empty proven nodes gracefully", () => {
    const messages = buildHallucinationCheckPrompt("some response", [], "some question");
    expect(messages[1].content).toContain("No related proven nodes");
  });
});

describe("buildGrowthCyclePrompt", () => {
  it("builds a valid self-growth cycle prompt", () => {
    const nodes = [
      createNode("Python can process data", "programming", { status: "known" }),
      createNode("SQL can query databases", "data", { status: "known" }),
    ];
    const messages = buildGrowthCyclePrompt(nodes, {
      totalNodes: 50,
      totalRelations: 12,
      totalDomains: 5,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("Self-Growth Cycle");
    expect(messages[1].content).toContain("Total nodes: 50");
    expect(messages[1].content).toContain("Python can process data");
    expect(messages[1].content).toContain("bottomUpQuestions");
  });
});

describe("buildSolutionSynthesisPrompt", () => {
  it("builds a valid solution synthesis prompt", () => {
    const messages = buildSolutionSynthesisPrompt("How to deploy a TypeScript app?");
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("Solution Synthesis");
    expect(messages[1].content).toContain("How to deploy a TypeScript app?");
    expect(messages[1].content).toContain("Markdown");
  });

  it("includes related nodes and decomposed items when provided", () => {
    const related = [createNode("npm run build produces dist/", "devops", { status: "proven" })];
    const decomposed = [
      { content: "Run tsc --build", canVerify: true, domain: "devops", depth: 0, reasoning: "compile" },
      { content: "How to handle env vars", canVerify: false, domain: "devops", depth: 0, reasoning: "config" },
    ];
    const messages = buildSolutionSynthesisPrompt(
      "Deploy TypeScript app",
      related,
      decomposed,
      "Build step overlaps with CI pipeline",
    );
    expect(messages[1].content).toContain("npm run build produces dist/");
    expect(messages[1].content).toContain("Run tsc --build");
    expect(messages[1].content).toContain("How to handle env vars");
    expect(messages[1].content).toContain("Build step overlaps");
  });
});

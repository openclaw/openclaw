/**
 * Manual test for decision guidance visibility
 * 
 * Run: bun scripts/test-decision-guidance.ts
 */

import { ExecutionCoordinator, resetExecutionCoordinator } from "../src/agents/execution-coordinator.js";
import { resetDecisionContext } from "../src/agents/decision-context.js";

async function testDecisionGuidance() {
  console.log("=== Decision Guidance Visibility Test ===\n");

  resetDecisionContext();
  resetExecutionCoordinator();

  const coordinator = new ExecutionCoordinator();

  // Test 1: Simple search task
  console.log("Test 1: Initialize session with search task");
  const initResponse = await coordinator.initializeSession(
    "Tell me about typescript programming language features",
  );
  console.log("Should execute:", initResponse.shouldExecute);
  console.log("Strategy level:", initResponse.strategy?.level);
  console.log("Primary tool:", initResponse.strategy?.primaryTool);
  console.log("Execution order:", initResponse.strategy?.executionOrder);
  console.log();

  // Test 2: Simulate tool execution with good result
  console.log("Test 2: After successful tool execution");
  const goodResult = {
    details: {
      confidence: 0.95,
      results: ["TypeScript is a typed superset of JavaScript", "It adds optional static typing", "Compiles to plain JavaScript"],
    },
  };

  const afterGood = await coordinator.afterToolExecution({
    toolName: "self_rag",
    toolCallId: "call-1",
    args: { query: "typescript features" },
    result: goodResult,
    duration: 150,
  });

  console.log("Evaluation success:", afterGood.evaluation?.success);
  console.log("Evaluation confidence:", afterGood.evaluation?.confidence);
  console.log("Next action:", afterGood.evaluation?.nextAction);
  console.log("Should continue:", afterGood.shouldExecute);
  console.log("Stop reason:", afterGood.stopReason);
  console.log();

  // Test 3: Simulate tool execution with poor result
  console.log("Test 3: After poor tool execution");
  resetDecisionContext();
  resetExecutionCoordinator();
  
  const coordinator2 = new ExecutionCoordinator();
  await coordinator2.initializeSession("Search for information about quantum computing");

  const poorResult = {
    details: {
      confidence: 0.2,
      results: [],
    },
  };

  const afterPoor = await coordinator2.afterToolExecution({
    toolName: "self_rag",
    toolCallId: "call-2",
    args: { query: "quantum computing" },
    result: poorResult,
    duration: 100,
  });

  console.log("Evaluation success:", afterPoor.evaluation?.success);
  console.log("Evaluation confidence:", afterPoor.evaluation?.confidence);
  console.log("Issues:", afterPoor.evaluation?.issues);
  console.log("Recommendations:", afterPoor.evaluation?.recommendations);
  console.log("Next action:", afterPoor.evaluation?.nextAction);
  console.log("Recommended next tool:", afterPoor.nextRecommendedTool);
  console.log();

  // Test 4: Generate guidance text
  console.log("Test 4: Generated guidance text example");
  const parts: string[] = [];
  if (afterPoor.evaluation) {
    const eval_ = afterPoor.evaluation;
    if (eval_.confidence < 0.5) {
      parts.push(`Confidence: ${Math.round(eval_.confidence * 100)}% (low)`);
    }
    if (eval_.issues.length > 0) {
      parts.push(`Issues: ${eval_.issues.join(", ")}`);
    }
    if (eval_.recommendations.length > 0) {
      parts.push(`Recommendations: ${eval_.recommendations.join("; ")}`);
    }
    parts.push(`Next action: ${eval_.nextAction}`);
  }
  if (afterPoor.nextRecommendedTool) {
    parts.push(`Recommended next tool: ${afterPoor.nextRecommendedTool}`);
  }
  
  const guidanceText = `[Decision Guidance: ${parts.join(" | ")}]`;
  console.log("Guidance that LLM will see:");
  console.log(guidanceText);
  console.log();

  console.log("=== Test Complete ===");
}

testDecisionGuidance().catch(console.error);

/**
 * Dialectical Reasoning Tool
 *
 * Examines opposing positions (thesis and antithesis) to arrive at a
 * higher-level synthesis that reconciles or transcends both.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const DialecticalParams = Type.Object({
  thesis: Type.String({
    description: "The initial position or claim to examine",
  }),
  antithesis: Type.String({
    description: "The opposing position or counter-claim",
  }),
  criteria: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Evaluation criteria for judging the merits of each position (e.g., 'empirical evidence', 'logical consistency', 'practical feasibility')",
    }),
  ),
});

export function createDialecticalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_dialectical",
    label: "Dialectical Reasoning",
    description:
      "Analyze opposing positions (thesis vs antithesis) and synthesize a higher-level resolution. Uses the Hegelian dialectical method to find common ground, expose contradictions, and produce a nuanced synthesis.",
    parameters: DialecticalParams,
    async execute(_id: string, params: Static<typeof DialecticalParams>) {
      const criteriaSection = params.criteria?.length
        ? `\n**Evaluation Criteria:**\n${params.criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`
        : "\n**Evaluation Criteria:** Use logical consistency, empirical support, practical implications, and scope of applicability.";

      return textResult(`## Dialectical Reasoning

**Thesis:**
${params.thesis}

**Antithesis:**
${params.antithesis}
${criteriaSection}

---

**Instructions — apply the dialectical method systematically:**

### Phase 1: Thesis Analysis
1. **Core claims:** Identify the fundamental assertions of the thesis.
2. **Supporting arguments:** What evidence, principles, or reasoning supports this position?
3. **Assumptions:** What unstated assumptions does the thesis rely on?
4. **Strengths:** Where is the thesis most convincing?
5. **Limitations:** Where does the thesis break down, overreach, or leave gaps?

### Phase 2: Antithesis Analysis
1. **Core claims:** Identify the fundamental assertions of the antithesis.
2. **Points of contradiction:** Exactly how and where does the antithesis oppose the thesis?
3. **Supporting arguments:** What evidence, principles, or reasoning supports this position?
4. **Assumptions:** What unstated assumptions does the antithesis rely on?
5. **Strengths:** Where is the antithesis most convincing?
6. **Limitations:** Where does the antithesis break down, overreach, or leave gaps?

### Phase 3: Comparative Evaluation
For each evaluation criterion, assess both positions:
| Criterion | Thesis Score (1-5) | Antithesis Score (1-5) | Notes |
|-----------|--------------------|------------------------|-------|

### Phase 4: Synthesis
1. **Common ground:** What do both positions agree on or share?
2. **Reconciliation:** Can the valid elements of both be integrated into a coherent whole?
3. **Transcendence:** Does a higher-level perspective resolve the contradiction?
4. **Synthesized position:** State the synthesis clearly.
5. **Remaining tensions:** What unresolved issues persist even in the synthesis?
6. **Confidence:** How robust is the synthesis? Could it serve as a new thesis for further dialectical inquiry?`);
    },
  };
}

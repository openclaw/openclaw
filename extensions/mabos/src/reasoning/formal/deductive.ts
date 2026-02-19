/**
 * Deductive Reasoning Tool
 *
 * Derives conclusions from premises using logical rules.
 * If all premises are true, the conclusion must necessarily be true.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const DeductiveParams = Type.Object({
  premises: Type.Array(Type.String(), {
    description: "Array of premises (logical statements assumed to be true)",
  }),
  query: Type.String({
    description: "The conclusion or statement to derive from the premises",
  }),
});

export function createDeductiveTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_deductive",
    label: "Deductive Reasoning",
    description:
      "Derive conclusions from premises using deductive logic. If the premises are true, the conclusion must necessarily follow.",
    parameters: DeductiveParams,
    async execute(_id: string, params: Static<typeof DeductiveParams>) {
      const numberedPremises = params.premises.map((p, i) => `  P${i + 1}. ${p}`).join("\n");

      return textResult(`## Deductive Reasoning

**Premises:**
${numberedPremises}

**Query:** ${params.query}

---

**Instructions — apply deductive logic systematically:**

1. **Identify the logical form** of each premise (universal, conditional, disjunctive, etc.).
2. **Apply valid inference rules** such as:
   - Modus Ponens: If P then Q; P; therefore Q.
   - Modus Tollens: If P then Q; not Q; therefore not P.
   - Hypothetical Syllogism: If P then Q; if Q then R; therefore if P then R.
   - Disjunctive Syllogism: P or Q; not P; therefore Q.
   - Universal Instantiation: All X are Y; a is X; therefore a is Y.
3. **Chain the inferences** step by step toward the query.
4. **State whether the query follows necessarily** from the premises, is contradicted by them, or is underdetermined.
5. **Provide the derivation chain** showing each step and the rule applied.

**Conclusion format:**
- VALID: The query follows necessarily from the premises.
- INVALID: The query does not follow from the premises.
- UNDERDETERMINED: The premises are insufficient to determine the query.
- CONTRADICTORY: The premises are inconsistent.`);
    },
  };
}

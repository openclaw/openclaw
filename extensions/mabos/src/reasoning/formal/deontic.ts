/**
 * Deontic Reasoning Tool
 *
 * Evaluates actions against normative rules (obligations, permissions, prohibitions).
 * Draws on deontic logic to determine what an agent ought to, may, or must not do.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const NormSchema = Type.Object({
  norm: Type.String({ description: "The normative rule or regulation" }),
  type: Type.Union(
    [Type.Literal("obligation"), Type.Literal("permission"), Type.Literal("prohibition")],
    {
      description:
        "Type of norm: obligation (must do), permission (may do), prohibition (must not do)",
    },
  ),
});

const DeonticParams = Type.Object({
  action: Type.String({
    description: "The action to evaluate against the norms",
  }),
  norms: Type.Array(NormSchema, {
    description: "Array of normative rules with their types (obligation, permission, prohibition)",
  }),
  context: Type.Optional(
    Type.String({
      description: "Situational context that may affect norm applicability or priority",
    }),
  ),
});

const NORM_SYMBOLS: Record<string, string> = {
  obligation: "O(a) — obligatory",
  permission: "P(a) — permitted",
  prohibition: "F(a) — forbidden",
};

export function createDeonticTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_deontic",
    label: "Deontic Reasoning",
    description:
      "Evaluate an action against normative rules (obligations, permissions, prohibitions). Determines whether an action is obligatory, permitted, or forbidden.",
    parameters: DeonticParams,
    async execute(_id: string, params: Static<typeof DeonticParams>) {
      const normsList = params.norms
        .map((n, i) => {
          const sym = NORM_SYMBOLS[n.type];
          return `  N${i + 1}. [${sym}] ${n.norm}`;
        })
        .join("\n");

      const obligations = params.norms.filter((n) => n.type === "obligation");
      const permissions = params.norms.filter((n) => n.type === "permission");
      const prohibitions = params.norms.filter((n) => n.type === "prohibition");

      const contextSection = params.context ? `\n**Context:** ${params.context}` : "";

      return textResult(`## Deontic Reasoning — Normative Evaluation

**Action under evaluation:** ${params.action}

**Applicable norms:**
${normsList}
${contextSection}

**Norm summary:**
- Obligations: ${obligations.length} (things that must be done)
- Permissions: ${permissions.length} (things that may be done)
- Prohibitions: ${prohibitions.length} (things that must not be done)

---

**Instructions — apply deontic analysis systematically:**

1. **Norm applicability:** For each norm, determine whether it applies to the action in question given the context. A norm may be inapplicable due to scope, conditions, or exceptions.

2. **Conflict detection:** Check for deontic conflicts:
   - Is the action both obligated and prohibited? (deontic dilemma)
   - Is the action obligated by one norm but its negation obligated by another?
   - Are there conflicts between norms of the same type?

3. **Norm priority resolution:** If conflicts exist, resolve using:
   - **Specificity:** More specific norms override general ones.
   - **Recency:** Later-enacted norms override earlier ones.
   - **Hierarchy:** Higher-authority norms override lower ones.
   - **Context:** Situational factors that activate exception clauses.

4. **Deontic status determination:**
   - **Obligatory:** The action must be performed (required by an undefeated obligation).
   - **Permitted:** The action may be performed (not prohibited, or explicitly permitted).
   - **Forbidden:** The action must not be performed (prohibited by an undefeated prohibition).
   - **Optional:** The action is neither obligatory nor forbidden (discretionary).

5. **Compliance assessment:**
   - Would performing the action satisfy all applicable obligations?
   - Would performing the action violate any applicable prohibitions?
   - What are the consequences of non-compliance?

**Provide:**
- Deontic status of the action: OBLIGATORY / PERMITTED / FORBIDDEN / OPTIONAL
- List of satisfied and violated norms.
- Any unresolved conflicts with recommended resolution.
- Recommended course of action.`);
    },
  };
}

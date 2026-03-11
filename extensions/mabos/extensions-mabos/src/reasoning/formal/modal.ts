/**
 * Modal Reasoning Tool
 *
 * Analyzes propositions under modalities: possibility, necessity, and contingency.
 * Draws on modal logic concepts (possible worlds, accessibility relations).
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const ModalParams = Type.Object({
  proposition: Type.String({
    description: "The proposition to analyze under the specified modality",
  }),
  modality: Type.Union(
    [Type.Literal("possibility"), Type.Literal("necessity"), Type.Literal("contingency")],
    {
      description:
        "The modal operator to apply: possibility (could be true), necessity (must be true), contingency (true but could be false)",
    },
  ),
  context: Type.Optional(
    Type.String({
      description: "Additional context or constraints for the modal analysis",
    }),
  ),
});

const MODALITY_DESCRIPTIONS: Record<
  string,
  { symbol: string; question: string; definition: string }
> = {
  possibility: {
    symbol: "\u25C7P",
    question: "Could this proposition be true?",
    definition:
      "A proposition is possible if there exists at least one accessible world in which it is true.",
  },
  necessity: {
    symbol: "\u25A1P",
    question: "Must this proposition be true?",
    definition: "A proposition is necessary if it is true in all accessible worlds.",
  },
  contingency: {
    symbol: "P \u2227 \u25C7\u00ACP",
    question: "Is this proposition true but could have been false?",
    definition:
      "A proposition is contingent if it is true in the actual world but false in at least one accessible world.",
  },
};

export function createModalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_modal",
    label: "Modal Reasoning",
    description:
      "Analyze a proposition under modal logic (possibility, necessity, or contingency). Evaluates whether something could be, must be, or happens to be the case.",
    parameters: ModalParams,
    async execute(_id: string, params: Static<typeof ModalParams>) {
      const mod = MODALITY_DESCRIPTIONS[params.modality];

      const contextSection = params.context ? `\n**Context:** ${params.context}` : "";

      return textResult(`## Modal Reasoning — ${params.modality.charAt(0).toUpperCase() + params.modality.slice(1)}

**Proposition (P):** ${params.proposition}
**Modality:** ${mod.symbol} — ${mod.definition}
**Central question:** ${mod.question}
${contextSection}

---

**Instructions — apply modal analysis systematically:**

1. **Identify the type of modality involved:**
   - Is it alethic (logical/metaphysical truth)?
   - Is it epistemic (knowledge-based)?
   - Is it doxastic (belief-based)?
   - Is it temporal (past/future necessity)?

2. **Possible worlds analysis:**
   - Describe the actual world with respect to the proposition.
   - Identify relevant accessible worlds (scenarios, conditions, or states).
   - Determine the proposition's truth value across these worlds.

3. **Modal evaluation for "${params.modality}":**
${
  params.modality === "possibility"
    ? `   - Identify at least one coherent scenario where P is true.
   - Verify no logical contradiction arises in that scenario.
   - Distinguish between logical possibility, physical possibility, and practical feasibility.`
    : ""
}
${
  params.modality === "necessity"
    ? `   - Attempt to find any coherent scenario where P is false.
   - If no such scenario exists, P is necessary.
   - Distinguish between logical necessity (tautology), physical necessity (laws of nature), and normative necessity (rules/obligations).`
    : ""
}
${
  params.modality === "contingency"
    ? `   - Confirm P is true in the actual world (or under current conditions).
   - Identify at least one coherent scenario where P is false.
   - This establishes contingency: true but not necessarily so.`
    : ""
}

4. **Related modal properties:**
   - If P is necessary, it is also possible.
   - If P is impossible, it is not necessary and not contingent.
   - If P is contingent, both P and not-P are possible.

**Provide:**
- Verdict: Is the proposition ${params.modality === "possibility" ? "possible" : params.modality === "necessity" ? "necessary" : "contingent"}? (YES / NO / INDETERMINATE)
- Justification with reference to relevant scenarios or worlds.
- Any qualifications (e.g., "physically possible but not logically necessary").`);
    },
  };
}

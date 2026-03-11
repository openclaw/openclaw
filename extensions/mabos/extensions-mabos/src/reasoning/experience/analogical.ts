/**
 * Analogical Reasoning Tool
 *
 * Structured analogical reasoning that transfers knowledge from a
 * well-understood source domain to a target problem by identifying
 * structural similarities and mapping concepts across domains.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const MappingSchema = Type.Object({
  source: Type.String({ description: "Concept or element in the source domain" }),
  target: Type.String({ description: "Corresponding concept or element in the target domain" }),
});

const AnalogicalParams = Type.Object({
  source_domain: Type.String({
    description:
      "Well-understood domain or situation to reason from (e.g., 'immune system defense mechanisms')",
  }),
  target_problem: Type.String({
    description:
      "Problem or domain to apply analogical insights to (e.g., 'network security architecture')",
  }),
  known_mappings: Type.Optional(
    Type.Array(MappingSchema, {
      description: "Pre-identified correspondences between source and target concepts",
    }),
  ),
});

export function createAnalogicalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_analogical",
    label: "Analogical Reasoning",
    description:
      "Apply structured analogical reasoning: identify structural similarities between a source domain and a target problem, map concepts across domains, and transfer insights.",
    parameters: AnalogicalParams,
    async execute(_id: string, params: Static<typeof AnalogicalParams>) {
      const { source_domain, target_problem, known_mappings } = params;

      const mappingsSection = known_mappings?.length
        ? `**Known Mappings:**\n${known_mappings.map((m) => `  - ${m.source} <-> ${m.target}`).join("\n")}`
        : "**Known Mappings:** None provided — discover mappings from scratch.";

      return textResult(`## Analogical Reasoning

**Source Domain:** ${source_domain}
**Target Problem:** ${target_problem}

${mappingsSection}

---

**Instructions — apply analogical reasoning systematically:**

1. **Source analysis:** Identify the key structures, relationships, causal mechanisms, and principles in the source domain.
2. **Structural alignment:** Find structural parallels between source and target:
   - What entities in the source correspond to entities in the target?
   - What relationships in the source have counterparts in the target?
   - What causal mechanisms transfer?
3. **Mapping completion:** Extend the known mappings (if any) with additional correspondences. Present a mapping table:
   | Source | Target | Relationship Type |
   |--------|--------|-------------------|
${known_mappings?.length ? known_mappings.map((m) => `   | ${m.source} | ${m.target} | (to determine) |`).join("\n") : "   | (discover) | (discover) | (to determine) |"}
4. **Inference transfer:** Based on the mappings, what insights, solutions, or predictions from the source domain apply to the target problem?
5. **Disanalogy check:** Where does the analogy break down? What aspects of the source do NOT transfer, and why?
6. **Confidence assessment:**
   - STRONG: Deep structural alignment, few disanalogies, transferred insights are actionable.
   - MODERATE: Partial structural alignment, some disanalogies, insights need adaptation.
   - WEAK: Surface similarity only, significant disanalogies, limited transfer value.

**Provide:** A ranked list of transferred insights with confidence levels and caveats.`);
    },
  };
}

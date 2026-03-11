/**
 * Ethical Reasoning Tool
 *
 * Evaluates a situation through multiple ethical frameworks
 * (utilitarian, deontological, virtue ethics) and synthesizes
 * a balanced ethical assessment.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const DEFAULT_FRAMEWORKS = ["utilitarian", "deontological", "virtue"];

const EthicalParams = Type.Object({
  situation: Type.String({
    description: "Description of the ethical situation or dilemma to analyze",
  }),
  principles: Type.Array(Type.String(), {
    description:
      "Ethical principles to apply in the analysis (e.g., 'do no harm', 'respect autonomy', 'fairness')",
  }),
  frameworks: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Ethical frameworks to use for analysis (e.g., 'utilitarian', 'deontological', 'virtue'). Defaults to all three if not specified.",
    }),
  ),
});

export function createEthicalTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_ethical",
    label: "Ethical Reasoning",
    description:
      "Analyze an ethical situation through multiple moral frameworks. Evaluates the situation using utilitarian, deontological, and/or virtue ethics perspectives, then synthesizes a balanced ethical assessment with actionable guidance.",
    parameters: EthicalParams,
    async execute(_id: string, params: Static<typeof EthicalParams>) {
      const frameworks =
        params.frameworks && params.frameworks.length > 0 ? params.frameworks : DEFAULT_FRAMEWORKS;

      const principlesList = params.principles.map((p, i) => `  ${i + 1}. ${p}`).join("\n");

      const frameworksList = frameworks.map((f, i) => `  ${i + 1}. ${f}`).join("\n");

      // Build per-framework analysis sections
      const frameworkSections = frameworks
        .map((f) => {
          const fl = f.toLowerCase();
          if (fl === "utilitarian" || fl === "consequentialist") {
            return `### ${f} Analysis (Consequentialist)
1. **Stakeholders:** Identify all parties affected by possible actions.
2. **Outcomes:** For each possible action, what are the likely consequences for each stakeholder?
3. **Utility calculus:** Estimate the net benefit (happiness, well-being, preference satisfaction) across all stakeholders.
4. **Distribution:** Are benefits and harms distributed fairly, or do they concentrate on vulnerable groups?
5. **Verdict:** Which action produces the greatest overall good for the greatest number?`;
          }
          if (fl === "deontological" || fl === "kantian") {
            return `### ${f} Analysis (Duty-Based)
1. **Duties and rights:** What moral duties, obligations, and rights are at stake?
2. **Universalizability (Categorical Imperative):** Could the proposed action be universalized without contradiction? Would you will that everyone in a similar situation act the same way?
3. **Means vs ends:** Does the action treat any person merely as a means to an end, rather than as an end in themselves?
4. **Principle alignment:** How does the action align with each stated principle?
5. **Verdict:** Is the action morally permissible, required, or prohibited based on duty and rights?`;
          }
          if (fl === "virtue" || fl === "virtue ethics") {
            return `### ${f} Analysis (Character-Based)
1. **Virtues at play:** Which virtues are relevant (e.g., courage, temperance, justice, prudence, honesty, compassion)?
2. **Character assessment:** What would a person of good character do in this situation?
3. **Golden mean:** Is the action a balanced middle ground between excess and deficiency?
4. **Moral exemplar:** How would a moral role model approach this dilemma?
5. **Verdict:** Which action best reflects and cultivates virtuous character?`;
          }
          // Generic framework section for any custom framework name
          return `### ${f} Analysis
1. Identify the core tenets and values of the ${f} framework.
2. Apply those tenets to the situation at hand.
3. Evaluate each possible action against the framework's criteria.
4. Note any tensions or ambiguities within this framework.
5. Provide a verdict from this framework's perspective.`;
        })
        .join("\n\n");

      return textResult(`## Ethical Reasoning

**Situation:**
${params.situation}

**Ethical Principles to Apply:**
${principlesList}

**Frameworks for Analysis:**
${frameworksList}

---

**Instructions — perform a structured ethical analysis:**

### Preliminary: Identify the Options
List the possible courses of action and their immediate implications before applying any framework.

${frameworkSections}

### Cross-Framework Synthesis
1. **Agreement:** Where do the frameworks converge? Which actions are endorsed by all or most frameworks?
2. **Conflict:** Where do the frameworks diverge? What trade-offs exist?
3. **Principle check:** Revisit each stated principle — is the emerging recommendation consistent with all of them?
4. **Weighted assessment:** Given the nature of the situation, which framework carries the most weight and why?

### Final Assessment
| Framework        | Recommended Action | Confidence | Key Concern            |
|------------------|--------------------|------------|------------------------|

**Overall recommendation:** State the ethically preferred course of action.
**Caveats and limitations:** Note any unresolved tensions, contextual dependencies, or areas where reasonable people might disagree.
**Monitoring:** What should be watched for to detect if the chosen action leads to unforeseen ethical issues?`);
    },
  };
}

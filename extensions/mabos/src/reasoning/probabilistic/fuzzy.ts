/**
 * Fuzzy Logic Reasoning Tool (Algorithmic)
 *
 * Implements a complete Mamdani-style fuzzy inference system:
 *   1. Fuzzification  — triangular membership functions
 *   2. Rule evaluation — min-max (Mamdani) inference
 *   3. Aggregation     — max of all rule outputs per output set
 *   4. Defuzzification — centroid method
 *
 * Triangular membership for points [a, b, c] at value x:
 *   x <= a || x >= c  =>  0
 *   a < x <= b        =>  (x - a) / (b - a)
 *   b < x < c         =>  (c - x) / (c - b)
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const FuzzyParams = Type.Object({
  variables: Type.Array(
    Type.Object({
      name: Type.String(),
      value: Type.Number(),
      sets: Type.Array(
        Type.Object({
          name: Type.String(),
          points: Type.Tuple([Type.Number(), Type.Number(), Type.Number()], {
            description: "Triangular membership [left, peak, right]",
          }),
        }),
      ),
    }),
    { description: "Input variables with their fuzzy sets" },
  ),
  rules: Type.Array(
    Type.Object({
      if_var: Type.String({ description: "Antecedent variable name" }),
      if_set: Type.String({ description: "Antecedent fuzzy set name" }),
      then_var: Type.String({ description: "Consequent variable name" }),
      then_set: Type.String({ description: "Consequent fuzzy set name" }),
    }),
    { description: "Fuzzy rules (IF var IS set THEN var IS set)" },
  ),
  output_variable: Type.String({
    description: "Name of the output variable to defuzzify",
  }),
});

/** Triangular membership function. */
function triangularMembership(x: number, a: number, b: number, c: number): number {
  if (x <= a || x >= c) return 0;
  if (x <= b) return (x - a) / (b - a);
  return (c - x) / (c - b);
}

export function createFuzzyTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_fuzzy",
    label: "Fuzzy Logic Reasoning",
    description:
      "Perform Mamdani fuzzy inference: fuzzify inputs via triangular membership functions, evaluate rules with min-max inference, aggregate outputs, and defuzzify using the centroid method.",
    parameters: FuzzyParams,
    async execute(_id: string, params: Static<typeof FuzzyParams>) {
      // ----------------------------------------------------------------
      // STEP 1 — Fuzzification
      // ----------------------------------------------------------------
      const membershipDegrees: Record<string, Record<string, number>> = {};
      const fuzzificationLines: string[] = [];

      for (const variable of params.variables) {
        membershipDegrees[variable.name] = {};
        const setLines: string[] = [];

        for (const set of variable.sets) {
          const [a, b, c] = set.points;
          const mu = triangularMembership(variable.value, a, b, c);
          membershipDegrees[variable.name][set.name] = mu;
          setLines.push(`    - ${set.name} [${a}, ${b}, ${c}]: \u03bc = ${mu.toFixed(4)}`);
        }

        fuzzificationLines.push(
          `  **${variable.name}** (value = ${variable.value}):\n${setLines.join("\n")}`,
        );
      }

      // ----------------------------------------------------------------
      // STEP 2 — Rule Evaluation (Mamdani min for antecedent)
      // ----------------------------------------------------------------
      const ruleActivations: Array<{
        rule: string;
        firingStrength: number;
        outputVar: string;
        outputSet: string;
      }> = [];

      for (const rule of params.rules) {
        const antecedentMu = membershipDegrees[rule.if_var]?.[rule.if_set] ?? 0;

        ruleActivations.push({
          rule: `IF ${rule.if_var} IS ${rule.if_set} THEN ${rule.then_var} IS ${rule.then_set}`,
          firingStrength: antecedentMu,
          outputVar: rule.then_var,
          outputSet: rule.then_set,
        });
      }

      const ruleLines = ruleActivations.map(
        (r) => `  - ${r.rule}  =>  firing strength = ${r.firingStrength.toFixed(4)}`,
      );

      // ----------------------------------------------------------------
      // STEP 3 — Output Aggregation (max per output set)
      // ----------------------------------------------------------------
      const aggregated: Record<string, number> = {};

      for (const ra of ruleActivations) {
        if (ra.outputVar !== params.output_variable) continue;
        aggregated[ra.outputSet] = Math.max(aggregated[ra.outputSet] ?? 0, ra.firingStrength);
      }

      const aggregationLines = Object.entries(aggregated).map(
        ([set, mu]) => `  - ${set}: \u03bc_agg = ${mu.toFixed(4)}`,
      );

      // ----------------------------------------------------------------
      // STEP 4 — Defuzzification (centroid method)
      // ----------------------------------------------------------------

      // Find the output variable definition to determine the range
      // We look across all variables for sets that match the output sets
      // or fall back to scanning rule consequents.
      let outputSetsDefinition: Array<{ name: string; points: [number, number, number] }> = [];

      // First check if the output variable is among the declared variables
      const outputVarDef = params.variables.find((v) => v.name === params.output_variable);
      if (outputVarDef) {
        outputSetsDefinition = outputVarDef.sets.map((s) => ({
          name: s.name,
          points: s.points as [number, number, number],
        }));
      } else {
        // Try to collect output sets from the rule consequents
        // Use the input variables' sets that share the same set names
        // as a heuristic (common in simple fuzzy systems where input/output share shape)
        for (const ra of ruleActivations) {
          if (ra.outputVar !== params.output_variable) continue;
          // Search all variables for a set with this name
          for (const v of params.variables) {
            const found = v.sets.find((s) => s.name === ra.outputSet);
            if (found && !outputSetsDefinition.find((o) => o.name === found.name)) {
              outputSetsDefinition.push({
                name: found.name,
                points: found.points as [number, number, number],
              });
            }
          }
        }
      }

      let defuzzifiedValue = 0;
      let defuzzLine = "No output sets found for defuzzification.";

      if (outputSetsDefinition.length > 0) {
        // Determine the universe of discourse range
        const allPoints = outputSetsDefinition.flatMap((s) => s.points);
        const rangeMin = Math.min(...allPoints);
        const rangeMax = Math.max(...allPoints);

        const STEPS = 100;
        const step = (rangeMax - rangeMin) / STEPS;

        let numerator = 0;
        let denominator = 0;

        for (let i = 0; i <= STEPS; i++) {
          const x = rangeMin + i * step;

          // For each x, compute the aggregated membership (max of all clipped sets)
          let muAtX = 0;
          for (const setDef of outputSetsDefinition) {
            const aggMu = aggregated[setDef.name] ?? 0;
            if (aggMu === 0) continue;

            const [a, b, c] = setDef.points;
            const rawMu = triangularMembership(x, a, b, c);
            // Clipped by firing strength (Mamdani)
            const clipped = Math.min(rawMu, aggMu);
            muAtX = Math.max(muAtX, clipped);
          }

          numerator += x * muAtX;
          denominator += muAtX;
        }

        defuzzifiedValue = denominator > 0 ? numerator / denominator : 0;
        defuzzLine = `Centroid = ${defuzzifiedValue.toFixed(4)} (range: [${rangeMin}, ${rangeMax}], ${STEPS + 1} sample points)`;
      }

      // ----------------------------------------------------------------
      // Format output
      // ----------------------------------------------------------------
      return textResult(`## Fuzzy Logic Inference

### Step 1 \u2014 Fuzzification
${fuzzificationLines.join("\n\n")}

### Step 2 \u2014 Rule Evaluation
${ruleLines.join("\n")}

### Step 3 \u2014 Output Aggregation (${params.output_variable})
${aggregationLines.length > 0 ? aggregationLines.join("\n") : "  No rules matched the output variable."}

### Step 4 \u2014 Defuzzification
${defuzzLine}

---

**Defuzzified Output:** ${params.output_variable} = **${defuzzifiedValue.toFixed(4)}**`);
    },
  };
}

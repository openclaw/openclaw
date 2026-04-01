/**
 * Constraint Satisfaction Reasoning Tool
 *
 * Algorithmic CSP solver with backtracking and MRV (Minimum Remaining Values)
 * heuristic. Falls back to prompt-based reasoning if variable or backtrack
 * limits are exceeded.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

// --- Hard limits ---
const MAX_VARIABLES = 20;
const MAX_BACKTRACKS = 10_000;

// --- TypeBox schemas ---

const VariableSchema = Type.Object({
  name: Type.String({ description: "Variable name" }),
  domain: Type.Array(Type.String(), {
    description: "Possible values for this variable",
  }),
});

const ConstraintParams = Type.Object({
  variables: Type.Array(VariableSchema, {
    description: "Variables with their domains (max 20 variables)",
  }),
  constraints: Type.Array(Type.String(), {
    description: 'Binary constraints as strings, e.g. "A != B", "A < B", "A == B", "X != Y"',
  }),
  objective: Type.Optional(
    Type.String({
      description: "Optional optimization objective or preference criteria",
    }),
  ),
});

// --- Constraint parsing and evaluation ---

interface ParsedConstraint {
  left: string;
  op: string;
  right: string;
}

/**
 * Parse a constraint string like "A != B" into its components.
 * Supports operators: ==, !=, <, >, <=, >=
 */
function parseConstraint(raw: string): ParsedConstraint | null {
  const match = raw.trim().match(/^(\w+)\s*(==|!=|<=|>=|<|>)\s*(\w+)$/);
  if (!match) return null;
  return { left: match[1], op: match[2], right: match[3] };
}

/**
 * Evaluate a parsed constraint against the current assignment.
 * Returns true if the constraint is satisfied or if one of the variables
 * is unassigned (constraints are only checked when both sides are assigned).
 */
function evaluateConstraint(
  constraint: ParsedConstraint,
  assignment: Map<string, string>,
): boolean {
  const leftVal = assignment.get(constraint.left);
  const rightVal = assignment.get(constraint.right);

  // If either variable is unassigned, the constraint is not yet applicable
  if (leftVal === undefined || rightVal === undefined) return true;

  // Try numeric comparison first; fall back to string comparison
  const leftNum = Number(leftVal);
  const rightNum = Number(rightVal);
  const bothNumeric = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);

  switch (constraint.op) {
    case "==":
      return leftVal === rightVal;
    case "!=":
      return leftVal !== rightVal;
    case "<":
      return bothNumeric ? leftNum < rightNum : leftVal < rightVal;
    case ">":
      return bothNumeric ? leftNum > rightNum : leftVal > rightVal;
    case "<=":
      return bothNumeric ? leftNum <= rightNum : leftVal <= rightVal;
    case ">=":
      return bothNumeric ? leftNum >= rightNum : leftVal >= rightVal;
    default:
      return true;
  }
}

// --- CSP Solver ---

interface SolverResult {
  solved: boolean;
  assignment: Map<string, string>;
  backtracks: number;
  limitExceeded: boolean;
}

/**
 * Backtracking CSP solver with MRV (Minimum Remaining Values) heuristic.
 */
function solveCSP(
  variables: Array<{ name: string; domain: string[] }>,
  parsedConstraints: ParsedConstraint[],
): SolverResult {
  const assignment = new Map<string, string>();
  let backtracks = 0;

  // Build domain maps (mutable copies)
  const domains = new Map<string, string[]>();
  for (const v of variables) {
    domains.set(v.name, [...v.domain]);
  }

  // Get constraints relevant to a variable
  function getConstraintsFor(varName: string): ParsedConstraint[] {
    return parsedConstraints.filter((c) => c.left === varName || c.right === varName);
  }

  // MRV heuristic: select unassigned variable with smallest remaining domain
  function selectVariable(): string | null {
    let best: string | null = null;
    let bestSize = Infinity;

    for (const v of variables) {
      if (assignment.has(v.name)) continue;
      const dom = domains.get(v.name)!;
      if (dom.length < bestSize) {
        bestSize = dom.length;
        best = v.name;
      }
    }
    return best;
  }

  // Check if the current assignment is consistent with all constraints
  function isConsistent(): boolean {
    for (const c of parsedConstraints) {
      if (!evaluateConstraint(c, assignment)) return false;
    }
    return true;
  }

  // Recursive backtracking search
  function backtrack(): boolean {
    if (assignment.size === variables.length) return true;

    if (backtracks >= MAX_BACKTRACKS) return false;

    const varName = selectVariable();
    if (!varName) return false;

    const domain = domains.get(varName)!;

    for (const value of domain) {
      assignment.set(varName, value);

      if (isConsistent()) {
        if (backtrack()) return true;
      }

      assignment.delete(varName);
      backtracks++;

      if (backtracks >= MAX_BACKTRACKS) return false;
    }

    return false;
  }

  const solved = backtrack();

  return {
    solved,
    assignment,
    backtracks,
    limitExceeded: backtracks >= MAX_BACKTRACKS,
  };
}

// --- Prompt-based fallback ---

function buildFallbackPrompt(params: Static<typeof ConstraintParams>, reason: string): string {
  const varList = params.variables.map((v) => `  - ${v.name}: {${v.domain.join(", ")}}`).join("\n");
  const constraintList = params.constraints.map((c, i) => `  C${i + 1}. ${c}`).join("\n");

  const objectiveSection = params.objective ? `\n**Objective:** ${params.objective}` : "";

  return `## Constraint Satisfaction — Prompt-Based Fallback

**Reason for fallback:** ${reason}

**Variables and domains:**
${varList}

**Constraints:**
${constraintList}
${objectiveSection}

---

**Instructions — solve this constraint satisfaction problem:**

1. **Identify the most constrained variables** (those with the smallest domains or most constraints).
2. **Try assigning values** starting from the most constrained variables.
3. **Propagate constraints:** After each assignment, eliminate values from other variables' domains that would violate constraints.
4. **Backtrack** if a dead end is reached (a variable has no remaining valid values).
5. **Report a solution** if all variables are assigned consistently, or state that no solution exists.
${params.objective ? `6. **Optimize:** Among valid solutions, find the one that best satisfies: "${params.objective}"` : ""}

**Provide:**
- A complete assignment of values to variables that satisfies all constraints, or a proof that none exists.
- Key conflicts or bottlenecks encountered.`;
}

// --- Tool factory ---

export function createConstraintTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_constraint",
    label: "Constraint Satisfaction Reasoning",
    description:
      "Solve constraint satisfaction problems using an algorithmic backtracking solver with MRV heuristic. Falls back to prompt-based reasoning for large or complex problems.",
    parameters: ConstraintParams,
    async execute(_id: string, params: Static<typeof ConstraintParams>) {
      // Check variable limit
      if (params.variables.length > MAX_VARIABLES) {
        return textResult(
          buildFallbackPrompt(
            params,
            `Variable count (${params.variables.length}) exceeds the maximum of ${MAX_VARIABLES}.`,
          ),
        );
      }

      // Parse all constraints
      const parsed: ParsedConstraint[] = [];
      const unparseable: string[] = [];

      for (const raw of params.constraints) {
        const p = parseConstraint(raw);
        if (p) {
          parsed.push(p);
        } else {
          unparseable.push(raw);
        }
      }

      // If any constraints could not be parsed, fall back to prompt-based
      if (unparseable.length > 0) {
        return textResult(
          buildFallbackPrompt(
            params,
            `Could not parse ${unparseable.length} constraint(s): ${unparseable.map((u) => `"${u}"`).join(", ")}. Only simple binary constraints (e.g., "A != B", "X < Y") are supported algorithmically.`,
          ),
        );
      }

      // Validate that constraint variables exist in the variable list
      const varNames = new Set(params.variables.map((v) => v.name));
      const unknownVars: string[] = [];
      for (const c of parsed) {
        if (!varNames.has(c.left)) unknownVars.push(c.left);
        if (!varNames.has(c.right)) unknownVars.push(c.right);
      }

      if (unknownVars.length > 0) {
        const unique = [...new Set(unknownVars)];
        return textResult(
          buildFallbackPrompt(
            params,
            `Constraint(s) reference unknown variable(s): ${unique.join(", ")}. All constraint variables must be declared in the variables array.`,
          ),
        );
      }

      // Run the solver
      const result = solveCSP(params.variables, parsed);

      if (result.limitExceeded) {
        return textResult(
          buildFallbackPrompt(
            params,
            `Backtrack limit exceeded (${MAX_BACKTRACKS} backtracks). The problem is too large for the algorithmic solver.`,
          ),
        );
      }

      if (!result.solved) {
        const varList = params.variables
          .map((v) => `  - ${v.name}: {${v.domain.join(", ")}}`)
          .join("\n");
        const constraintList = params.constraints.map((c, i) => `  C${i + 1}. ${c}`).join("\n");

        return textResult(`## Constraint Satisfaction — No Solution Found

**Variables and domains:**
${varList}

**Constraints:**
${constraintList}

**Result:** No valid assignment exists that satisfies all constraints.
**Backtracks explored:** ${result.backtracks}

The constraints are over-constrained for the given variable domains. Consider relaxing constraints or expanding domains.`);
      }

      // Build solution output
      const solutionLines = params.variables
        .map((v) => `  ${v.name} = ${result.assignment.get(v.name)}`)
        .join("\n");

      const constraintChecks = params.constraints
        .map((c, i) => {
          const p = parsed[i];
          const lv = result.assignment.get(p.left);
          const rv = result.assignment.get(p.right);
          return `  C${i + 1}. ${c}  =>  ${lv} ${p.op} ${rv}  [SATISFIED]`;
        })
        .join("\n");

      const objectiveSection = params.objective
        ? `\n**Objective:** ${params.objective}\nNote: The algorithmic solver found a feasible solution. Evaluate whether this assignment optimally satisfies the objective above.`
        : "";

      return textResult(`## Constraint Satisfaction — Solution Found

**Assignment:**
${solutionLines}

**Constraint verification:**
${constraintChecks}

**Backtracks used:** ${result.backtracks}
${objectiveSection}

All ${params.constraints.length} constraint(s) satisfied across ${params.variables.length} variable(s).`);
    },
  };
}

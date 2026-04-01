/**
 * Game-Theoretic Reasoning Tool
 *
 * Analyzes strategic interactions between multiple agents using
 * game theory concepts: Nash equilibria, dominant strategies,
 * Pareto optimality, and mixed strategy considerations.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../../tools/common.js";

const GameTheoreticParams = Type.Object({
  players: Type.Array(Type.String(), {
    description: "List of player / agent identifiers involved in the game",
  }),
  strategies: Type.Record(Type.String(), Type.Array(Type.String()), {
    description:
      "Map from each player identifier to their available strategies (e.g., { 'Alice': ['cooperate', 'defect'], 'Bob': ['cooperate', 'defect'] })",
  }),
  payoffs: Type.Optional(
    Type.String({
      description:
        "Description of the payoff structure — how outcomes translate to utility for each player. Can be a textual description, a matrix, or reference to a known game type (e.g., 'Prisoner\\'s Dilemma')",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Additional context about the strategic situation, repeated game dynamics, information structure, or real-world domain",
    }),
  ),
});

export function createGameTheoreticTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "reason_game_theoretic",
    label: "Game-Theoretic Reasoning",
    description:
      "Analyze strategic interactions between agents using game theory. Identifies Nash equilibria, dominant strategies, Pareto-optimal outcomes, and recommends strategies given the players, their options, and the payoff structure.",
    parameters: GameTheoreticParams,
    async execute(_id: string, params: Static<typeof GameTheoreticParams>) {
      const playersList = params.players.map((p, i) => `  ${i + 1}. **${p}**`).join("\n");

      const strategiesSection = params.players
        .map((p) => {
          const strats = params.strategies[p];
          if (!strats || strats.length === 0) {
            return `  - **${p}:** (no strategies defined)`;
          }
          return `  - **${p}:** ${strats.join(", ")}`;
        })
        .join("\n");

      const payoffsSection = params.payoffs
        ? `\n**Payoff Structure:**\n${params.payoffs}`
        : "\n**Payoff Structure:** Not explicitly provided — infer reasonable payoffs from context and strategy names.";

      const contextSection = params.context ? `\n**Context:**\n${params.context}` : "";

      return textResult(`## Game-Theoretic Analysis

**Players:**
${playersList}

**Available Strategies:**
${strategiesSection}
${payoffsSection}
${contextSection}

---

**Instructions — perform a systematic game-theoretic analysis:**

### Step 1: Game Formulation
1. **Game type:** Classify the game (simultaneous/sequential, zero-sum/non-zero-sum, one-shot/repeated, complete/incomplete information).
2. **Payoff matrix:** If not provided, construct a plausible payoff matrix or game tree based on the strategies and context.
3. **Information structure:** What does each player know about the others' strategies and payoffs?

### Step 2: Dominant Strategy Analysis
For each player:
1. Does any strategy **strictly dominate** all others (always yields a higher payoff regardless of opponents' choices)?
2. Does any strategy **weakly dominate** others?
3. Apply **iterated elimination of dominated strategies** if applicable.

### Step 3: Nash Equilibrium Identification
1. **Pure strategy Nash equilibria:** Identify all strategy profiles where no player can unilaterally improve their payoff by deviating.
2. **Mixed strategy equilibria:** If no pure NE exists (or additionally), identify mixed strategy Nash equilibria with probability distributions.
3. For each equilibrium, state the strategy profile and the resulting payoffs.

### Step 4: Pareto Optimality
1. Identify all **Pareto-optimal outcomes** — those where no player can be made better off without making another worse off.
2. Compare Pareto outcomes with Nash equilibria. Is there a tension (e.g., Prisoner's Dilemma structure)?

### Step 5: Strategic Recommendations
1. **If cooperative play is possible:** What agreements could improve outcomes? Are they self-enforcing?
2. **If repeated:** How do strategies like tit-for-tat, grim trigger, or forgiveness affect long-run outcomes?
3. **Per-player recommendation:** For each player, recommend a strategy with justification.

### Output Summary
| Concept              | Result                         |
|----------------------|--------------------------------|
| Game Type            |                                |
| Dominant Strategies  |                                |
| Nash Equilibria      |                                |
| Pareto Outcomes      |                                |
| Key Tension          |                                |
| Recommendation       |                                |`);
    },
  };
}

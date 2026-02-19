/**
 * REASONING_METHODS — Complete catalog of 35 reasoning methods.
 *
 * Each entry specifies category, description, prompt template,
 * applicability conditions, whether it has an algorithmic component,
 * and an optional dedicated tool name.
 */

import type { ReasoningMethodEntry } from "./types.js";

export const REASONING_METHODS: Record<string, ReasoningMethodEntry> = {
  // ── Formal ────────────────────────────────────────────────────
  deductive: {
    category: "formal",
    description: "Derive conclusions from premises using logical rules",
    prompt: "Apply deductive logic: if premises are true, conclusion must be true.",
    applicable_when: "Premises are well-defined and truth-preserving inference is needed",
    algorithmic: false,
    dedicated_tool: "reason_deductive",
  },
  inductive: {
    category: "formal",
    description: "Generalize from specific observations",
    prompt: "Apply inductive reasoning: identify patterns and form general conclusions.",
    applicable_when: "Multiple observations are available and generalization is needed",
    algorithmic: false,
    dedicated_tool: "reason_inductive",
  },
  abductive: {
    category: "formal",
    description: "Infer best explanation for observations",
    prompt: "Apply abductive reasoning: what is the most likely explanation?",
    applicable_when: "Observations need explanation and multiple hypotheses exist",
    algorithmic: false,
    dedicated_tool: "reason_abductive",
  },
  analogical: {
    category: "formal",
    description: "Reason by analogy from similar situations",
    prompt: "Apply analogical reasoning: find structural similarities with known cases.",
    applicable_when: "A well-understood source domain can inform a target problem",
    algorithmic: false,
    dedicated_tool: "reason_analogical",
  },
  modal: {
    category: "formal",
    description: "Reason about possibility, necessity, and contingency",
    prompt: "Apply modal logic: evaluate what is possible, necessary, or contingent.",
    applicable_when: "Need to distinguish between what must be, could be, or happens to be true",
    algorithmic: false,
    dedicated_tool: "reason_modal",
  },
  deontic: {
    category: "formal",
    description: "Reason about obligations, permissions, and prohibitions",
    prompt: "Apply deontic logic: evaluate what ought to be, is permitted, or is forbidden.",
    applicable_when: "Normative rules and obligations govern the decision",
    algorithmic: false,
    dedicated_tool: "reason_deontic",
  },
  spatial: {
    category: "formal",
    description: "Reason about spatial relationships",
    prompt: "Apply spatial reasoning: analyze positions, distances, and arrangements.",
    applicable_when: "Physical layout, geography, or spatial relationships matter",
    algorithmic: false,
  },
  default_reasoning: {
    category: "formal",
    description: "Non-monotonic reasoning with defaults that can be overridden",
    prompt: "Apply default reasoning: assume typical defaults unless exceptions are known.",
    applicable_when: "Need to make assumptions that hold in typical cases but may have exceptions",
    algorithmic: false,
  },
  constraint_satisfaction: {
    category: "formal",
    description: "Find assignments satisfying all constraints",
    prompt:
      "Apply constraint satisfaction: find variable assignments that satisfy all constraints.",
    applicable_when: "Variables with domains and constraints need a consistent assignment",
    algorithmic: true,
    dedicated_tool: "reason_constraint",
  },

  // ── Probabilistic ─────────────────────────────────────────────
  bayesian: {
    category: "probabilistic",
    description: "Update probabilities given new evidence",
    prompt:
      "Apply Bayesian updating: P(H|E) = P(E|H)*P(H)/P(E). State priors, likelihood, and posterior.",
    applicable_when: "Prior beliefs exist and new evidence should update them",
    algorithmic: true,
    dedicated_tool: "reason_bayesian",
  },
  fuzzy: {
    category: "probabilistic",
    description: "Handle partial truth values with fuzzy membership",
    prompt: "Apply fuzzy logic: assign membership degrees and compute fuzzy outcomes.",
    applicable_when: "Concepts have vague boundaries and partial membership is appropriate",
    algorithmic: true,
    dedicated_tool: "reason_fuzzy",
  },
  decision_theory: {
    category: "probabilistic",
    description: "Maximize expected utility",
    prompt: "Apply decision theory: enumerate options, probabilities, utilities, compute EU.",
    applicable_when: "Clear options with quantifiable outcomes and probabilities exist",
    algorithmic: false,
  },
  statistical: {
    category: "probabilistic",
    description: "Analyze data distributions and statistical patterns",
    prompt: "Apply statistical reasoning: compute descriptive statistics and interpret patterns.",
    applicable_when: "Numerical data is available for analysis",
    algorithmic: true,
    dedicated_tool: "reason_statistical",
  },
  monte_carlo: {
    category: "probabilistic",
    description: "Estimate outcomes through random sampling simulation",
    prompt:
      "Apply Monte Carlo reasoning: simulate random scenarios to estimate probability distributions.",
    applicable_when: "Complex probability distributions need estimation through simulation",
    algorithmic: false,
  },
  pattern_recognition: {
    category: "probabilistic",
    description: "Identify recurring patterns in data or situations",
    prompt: "Apply pattern recognition: identify recurring structures, trends, and regularities.",
    applicable_when: "Historical data or observations contain latent patterns to discover",
    algorithmic: false,
  },

  // ── Causal ────────────────────────────────────────────────────
  causal: {
    category: "causal",
    description: "Identify cause-effect relationships",
    prompt: "Apply causal reasoning: identify mechanisms, confounders, and causal chains.",
    applicable_when: "Need to understand why something happened or will happen",
    algorithmic: false,
    dedicated_tool: "reason_causal",
  },
  counterfactual: {
    category: "causal",
    description: "What-if analysis of alternative scenarios",
    prompt: "Apply counterfactual reasoning: if X had been different, what would have changed?",
    applicable_when: "Need to evaluate alternative histories or hypothetical changes",
    algorithmic: false,
    dedicated_tool: "reason_counterfactual",
  },
  temporal: {
    category: "causal",
    description: "Reason about time-dependent sequences and dependencies",
    prompt: "Apply temporal reasoning: analyze sequences, dependencies, and timing.",
    applicable_when: "Events have temporal ordering, dependencies, or deadlines",
    algorithmic: true,
    dedicated_tool: "reason_temporal",
  },
  scenario: {
    category: "causal",
    description: "Explore multiple future scenarios from varying assumptions",
    prompt:
      "Apply scenario reasoning: explore how different assumptions lead to different outcomes.",
    applicable_when: "Future is uncertain and multiple plausible trajectories should be explored",
    algorithmic: false,
    dedicated_tool: "reason_scenario",
  },
  predictive: {
    category: "causal",
    description: "Forecast future states based on current trends and models",
    prompt: "Apply predictive reasoning: project current trends and models into future states.",
    applicable_when: "Current data and trends can inform forecasts about future states",
    algorithmic: false,
  },

  // ── Experience ────────────────────────────────────────────────
  heuristic: {
    category: "experience",
    description: "Apply rules of thumb",
    prompt: "Apply heuristic reasoning: use practical rules and shortcuts.",
    applicable_when: "Quick decisions are needed and proven rules of thumb exist",
    algorithmic: false,
  },
  cbr: {
    category: "experience",
    description: "Learn from past cases",
    prompt: "Apply case-based reasoning: retrieve, reuse, revise, retain.",
    applicable_when: "Similar past cases exist in the case library",
    algorithmic: false,
  },
  means_ends: {
    category: "experience",
    description: "Reduce gap between current and goal state",
    prompt: "Apply means-ends analysis: identify gaps and operators to close them.",
    applicable_when: "Clear current state and goal state with identifiable operators",
    algorithmic: false,
  },
  narrative: {
    category: "experience",
    description: "Construct coherent narratives to understand situations",
    prompt: "Apply narrative reasoning: construct a coherent story that explains the situation.",
    applicable_when: "Complex situations benefit from a story-based understanding",
    algorithmic: false,
  },
  model_based: {
    category: "experience",
    description: "Reason using mental models of system behavior",
    prompt: "Apply model-based reasoning: use a mental model of the system to predict behavior.",
    applicable_when: "A well-understood system model can predict behavior under conditions",
    algorithmic: false,
  },

  // ── Social ────────────────────────────────────────────────────
  game_theory: {
    category: "social",
    description: "Strategic interaction analysis",
    prompt: "Apply game theory: identify players, strategies, payoffs, and equilibria.",
    applicable_when: "Multiple agents with competing or aligned interests interact strategically",
    algorithmic: false,
    dedicated_tool: "reason_game_theoretic",
  },
  stakeholder: {
    category: "social",
    description: "Multi-perspective analysis",
    prompt: "Apply stakeholder analysis: identify interests, power, influence of each party.",
    applicable_when: "Multiple stakeholders with different interests are affected",
    algorithmic: false,
  },
  ethical: {
    category: "social",
    description: "Moral reasoning frameworks",
    prompt:
      "Apply ethical reasoning: consider utilitarian, deontological, and virtue perspectives.",
    applicable_when: "Actions have moral implications requiring principled evaluation",
    algorithmic: false,
    dedicated_tool: "reason_ethical",
  },
  dialectical: {
    category: "social",
    description: "Thesis-antithesis-synthesis dialectic",
    prompt: "Apply dialectical reasoning: examine thesis and antithesis to reach synthesis.",
    applicable_when: "Opposing viewpoints exist and synthesis may reveal deeper truth",
    algorithmic: false,
    dedicated_tool: "reason_dialectical",
  },
  consensus: {
    category: "social",
    description: "Aggregate preferences to find group agreement",
    prompt:
      "Apply consensus reasoning: aggregate diverse preferences to find acceptable agreement.",
    applicable_when: "Multiple agents or stakeholders need to reach a shared decision",
    algorithmic: false,
  },
  trust: {
    category: "social",
    description: "Evaluate trustworthiness based on interaction history",
    prompt: "Apply trust reasoning: evaluate reliability based on past interactions.",
    applicable_when: "Need to assess trustworthiness of an agent or source",
    algorithmic: true,
    dedicated_tool: "reason_trust",
  },
  theory_of_mind: {
    category: "social",
    description: "Model the beliefs and intentions of other agents",
    prompt: "Apply theory of mind: infer what other agents believe, want, and intend.",
    applicable_when: "Understanding another agent's perspective is critical for the decision",
    algorithmic: false,
  },

  // ── Meta ──────────────────────────────────────────────────────
  meta_reasoning: {
    category: "meta",
    description: "Select the best reasoning method for a problem",
    prompt: "Apply meta-reasoning: classify the problem and select the optimal reasoning method.",
    applicable_when: "Unclear which reasoning method is most appropriate",
    algorithmic: true,
    dedicated_tool: "reason_meta",
  },
  epistemic: {
    category: "meta",
    description: "Reason about knowledge, certainty, and ignorance",
    prompt: "Apply epistemic reasoning: evaluate what is known, uncertain, or unknown.",
    applicable_when: "Need to assess the state of knowledge and gaps in understanding",
    algorithmic: false,
  },
  reflective: {
    category: "meta",
    description: "Evaluate and improve one's own reasoning process",
    prompt: "Apply reflective reasoning: examine the reasoning process itself for biases and gaps.",
    applicable_when: "Need to check reasoning quality, identify biases, or improve the process",
    algorithmic: false,
  },
  optimization: {
    category: "meta",
    description: "Find best solution given objectives and constraints",
    prompt:
      "Apply optimization reasoning: define the objective function and find the optimal solution.",
    applicable_when: "A clear objective function exists with constraints to satisfy",
    algorithmic: false,
  },
};

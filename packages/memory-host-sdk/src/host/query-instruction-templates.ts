/**
 * Query instruction templates for embedding models that expect asymmetric
 * retrieval prompts. These are opt-in so generic OpenAI-compatible defaults stay
 * policy-neutral.
 */
const QUERY_INSTRUCTION_TEMPLATES = [
  {
    prefix: "qwen3-embedding",
    template:
      "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:{query}",
  },
  {
    prefix: "mxbai-embed-large",
    template: "Represent this sentence for searching relevant passages: {query}",
  },
] as const;

function normalizeTemplateMatchModel(model: string): string {
  const normalizedModel = model.trim().toLowerCase();
  const segments = normalizedModel.split("/").filter(Boolean);
  return segments.at(-1) ?? normalizedModel;
}

function matchesTemplateModelAlias(model: string, prefix: string): boolean {
  return (
    model === prefix ||
    model.startsWith(`${prefix}-`) ||
    model.startsWith(`${prefix}:`) ||
    model.includes(`-${prefix}`)
  );
}

export function applyQueryInstructionTemplate(model: string, queryText: string): string {
  const normalizedModel = normalizeTemplateMatchModel(model);
  const match = QUERY_INSTRUCTION_TEMPLATES.find(({ prefix }) =>
    matchesTemplateModelAlias(normalizedModel, prefix),
  );
  return match ? match.template.replace("{query}", () => queryText) : queryText;
}

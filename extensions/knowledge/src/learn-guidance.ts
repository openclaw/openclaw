import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type Capability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];

/** Tools a /learn turn needs to build subject pages, attached claims and supersession. */
export const KNOWLEDGE_LEARN_TOOL_NAMES = [
  "knowledge_attach_file",
  "knowledge_publish_batch",
  "knowledge_save_page",
  "knowledge_create_claim",
  "knowledge_correct",
  "knowledge_grep",
  "knowledge_lookup",
  "knowledge_ontology",
] as const;

/** Writes without which a learning turn would only produce unlinked notes. */
const REQUIRED = ["knowledge_save_page", "knowledge_create_claim", "knowledge_grep"];

/** /learn guidance for Knowledge; the method lives in knowledge-ingest's learning section. */
export const buildKnowledgeLearnGuidance: NonNullable<Capability["learnGuidanceBuilder"]> = ({
  availableTools,
}) => {
  if (!REQUIRED.every((tool) => availableTools.has(tool))) {
    return [];
  }
  const supersede = availableTools.has("knowledge_correct")
    ? " When someone explicitly replaces an earlier standing statement, supersede the old claim with `knowledge_correct`."
    : "";
  return [
    `Memory (Knowledge): follow the \`knowledge-ingest\` skill's "Learning from a set of sources" section. Organise lessons by subject: one page per person, organization, project, tool or other durable subject, with its current understanding in a State section. Save facts, decisions, preferences and commitments as claims attached to those pages, quoting retained originals. Mark a conclusion drawn from several passages as \`agent_inference\`.${supersede}`,
  ];
};

export type ZekeToolName =
  | "ask_zeke_context"
  | "search_zeke_context"
  | "explain_zeke_context_route"
  | "read_zeke_source"
  | "read_repo_file"
  | "grep_repo"
  | "glob_repo"
  | "propose_signal";

type JsonSchema = Record<string, unknown>;

const contextParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Free-text question to answer from Zeke context.",
    },
    project_id: {
      type: "string",
      description: "Project or product scope. Defaults to zekeflow-core.",
    },
    tier: {
      type: "string",
      description: "Work tier: brief, epic, roadmap, story, or ad-hoc.",
    },
    mission_id: {
      type: "string",
      description: "Optional mission/story id for traceability.",
    },
    allowed_sources: {
      type: "array",
      items: {
        type: "string",
        enum: ["ledger", "graphiti", "gitnexus", "zekeiq", "sqlite", "cognee", "learning"],
      },
      description:
        "Optional source allow-list. The server intersects this with the caller profile.",
    },
    privacy_scope: {
      type: "string",
      enum: ["shared", "entity_private", "personal_private"],
      description: "Requested privacy scope. personal_private is reserved and rejected in v1.",
    },
    max_sources: {
      type: "number",
      description: "Maximum number of sources to route to. Defaults to 4.",
    },
  },
  required: ["query"],
} as const satisfies JsonSchema;

export const ZEKE_TOOL_DEFINITIONS: Array<{
  name: ZekeToolName;
  label: string;
  description: string;
  parameters: JsonSchema;
}> = [
  {
    name: "ask_zeke_context",
    label: "Ask Zeke Context",
    description:
      "Ask the unified Zeke context broker for a synthesized answer grounded only in cited evidence.",
    parameters: contextParameters,
  },
  {
    name: "search_zeke_context",
    label: "Search Zeke Context",
    description:
      "Search the unified Zeke context broker and return evidence packets only, with no synthesized answer.",
    parameters: contextParameters,
  },
  {
    name: "explain_zeke_context_route",
    label: "Explain Zeke Context Route",
    description: "Explain why the Zeke context broker selected or skipped sources for a query.",
    parameters: contextParameters,
  },
  {
    name: "read_zeke_source",
    label: "Read Zeke Source",
    description: "Dereference one context-broker source_ref back to raw source material.",
    parameters: {
      type: "object",
      properties: {
        source_ref: {
          type: "string",
          description:
            "Canonical CTX-001 source_ref such as ledger:event/<event_id>, graphiti:episode/<group>/<uuid>, gitnexus:process/<name>, or cognee:<entity>/<dataset>/<id>.",
        },
      },
      required: ["source_ref"],
    },
  },
  {
    name: "read_repo_file",
    label: "Read Repo File",
    description:
      "Read one allowed repo-relative text file through the Sprout governed repo-read wrapper.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repo-relative file path to read, for example zekeflow/server.js. Absolute paths and traversal are rejected.",
        },
        max_bytes: {
          type: "number",
          description: "Maximum bytes to return, capped by the wrapper.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "grep_repo",
    label: "Grep Repo",
    description:
      "Search allowed repo files for literal text through the Sprout governed repo-read wrapper.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Literal text to search for.",
        },
        path: {
          type: "string",
          description: "Optional repo-relative file or directory scope.",
        },
        glob: {
          type: "string",
          description: "Optional repo-relative glob scope such as zekeflow/**/*.js.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Use case-sensitive matching. Default false.",
        },
        max_results: {
          type: "number",
          description: "Maximum matching lines to return, capped by the wrapper.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "glob_repo",
    label: "Glob Repo",
    description:
      "List allowed repo files matching a repo-relative glob through the Sprout governed repo-read wrapper.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Repo-relative glob pattern such as zekeflow/**/*.js.",
        },
        max_results: {
          type: "number",
          description: "Maximum file paths to return, capped by the wrapper.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_signal",
    label: "Propose Signal",
    description: "Propose a signal for Ross to confirm before it lands in the intake queue.",
    parameters: {
      type: "object",
      properties: {
        raw_input: {
          type: "string",
          description: "Verbatim signal text - Ross's words, not a paraphrase.",
        },
        proposal_summary: {
          type: "string",
          description: "Optional short title or summary surfaced in the approval preview.",
        },
        user_context: {
          type: "string",
          description: "Optional surrounding conversational context.",
        },
      },
      required: ["raw_input"],
    },
  },
];

export const ZEKE_TOOL_NAMES = ZEKE_TOOL_DEFINITIONS.map((tool) => tool.name);

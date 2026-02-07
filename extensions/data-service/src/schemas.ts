/**
 * TypeBox schemas for all Data-Service connector tool parameters.
 *
 * Note: org_id and user_id are NOT exposed as tool parameters.
 * They MUST be set via data-service.setContext gateway method.
 */

import { Type } from "@sinclair/typebox";

export const ConnectorExecuteSchema = Type.Object({
  connector: Type.String({
    description:
      "The connector type to use (e.g., 'brave_search', 'google_calendar', 'hubspot', 'slack'). Use connector_list to see available connectors.",
  }),
  action: Type.String({
    description:
      "The action to execute on the connector (e.g., 'search' for brave_search, 'create' for calendar events). Use connector_actions to see available actions.",
  }),
  input: Type.String({
    description:
      'JSON string containing the action input parameters. For brave_search: \'{"query": "your search query"}\'. For calendar: \'{"summary": "Meeting", "start_datetime": "...", "end_datetime": "..."}\'.',
  }),
  connector_id: Type.Optional(
    Type.String({
      description:
        "Optional connector instance ID. If not provided, the tool will look up the user's configured connector from Data-Service.",
    }),
  ),
});

export const ConnectorListSchema = Type.Object({
  category: Type.Optional(
    Type.String({
      description:
        "Optional category filter (e.g., 'productivity', 'crm', 'communication', 'search').",
    }),
  ),
});

export const ConnectorActionsSchema = Type.Object({
  connector: Type.String({
    description: "The connector type to get available actions for.",
  }),
});

export const ConnectorSchemaSchema = Type.Object({
  connector: Type.String({
    description: "The connector type (e.g., 'email', 'brave_search', 'tables').",
  }),
  action: Type.String({
    description: "The action name to get schema for (e.g., 'send', 'search', 'create').",
  }),
});

export const ConnectorLookupSchema = Type.Object({
  connector: Type.String({
    description: "The connector type to look up.",
  }),
});

export const UserConnectorsSchema = Type.Object({});

export const ConnectorSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Search query to find the right connector (e.g., 'linkedin', 'email', 'search', 'calendar'). Can be connector name or what you want to do.",
  }),
  action: Type.Optional(
    Type.String({
      description:
        "Optional: specific action you want to perform (e.g., 'send_message', 'send', 'search', 'create'). If provided, returns schema for this action.",
    }),
  ),
});

// ============================================================================
// Filesystem Tool Schemas (for S3-backed project virtual disk)
// ============================================================================

export const FsReadSchema = Type.Object({
  path: Type.String({
    description:
      "Relative path to the file within the project (e.g., 'documents/report.md', 'config.json')",
  }),
  start_line: Type.Optional(
    Type.Number({
      description:
        "Line number to start reading from (1-indexed). If omitted, reads from the beginning.",
    }),
  ),
  end_line: Type.Optional(
    Type.Number({
      description: "Line number to stop reading at (inclusive). If omitted, reads to the end.",
    }),
  ),
});

export const FsWriteSchema = Type.Object({
  path: Type.String({
    description:
      "Relative path to the file within the project (e.g., 'documents/report.md', 'data/config.json')",
  }),
  content: Type.String({
    description:
      "Content to write to the file. This will create a new file or overwrite an existing one.",
  }),
});

export const FsEditSchema = Type.Object({
  path: Type.String({
    description: "Relative path to the file within the project",
  }),
  old_content: Type.String({
    description:
      "The exact content to find in the file. Must match exactly (including whitespace).",
  }),
  new_content: Type.String({
    description: "The new content to replace the old content with.",
  }),
  replace_all: Type.Optional(
    Type.Boolean({
      description:
        "If true, replaces all occurrences. If false (default), replaces only the first occurrence.",
    }),
  ),
});

export const FsDeleteSchema = Type.Object({
  path: Type.String({
    description: "Relative path to the file to delete within the project",
  }),
});

export const FsListSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Relative path to the directory to list. If omitted, lists the project root directory.",
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        "If true, lists all files recursively. If false (default), lists only immediate children.",
    }),
  ),
});

export const FsMkdirSchema = Type.Object({
  path: Type.String({
    description: "Relative path of the directory to create within the project",
  }),
});

export const FsRmdirSchema = Type.Object({
  path: Type.String({
    description: "Relative path of the directory to delete within the project",
  }),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        "If true, deletes the directory and all its contents. If false (default), fails if directory is not empty.",
    }),
  ),
});

export const FsExistsSchema = Type.Object({
  path: Type.String({
    description: "Relative path to check for existence within the project",
  }),
});

export const FsStatSchema = Type.Object({
  path: Type.String({
    description: "Relative path to get metadata for within the project",
  }),
});

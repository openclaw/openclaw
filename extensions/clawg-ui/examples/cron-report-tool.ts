/**
 * Server-side `cron_report` tool that wraps cron job data in A2UI v0.9 schema.
 *
 * The agent calls this tool with an array of cron run objects. The execute
 * method wraps them in a fixed A2UI v0.9 component tree (cards with
 * startedAt, duration, model, tokensUsed, summary) and returns the result
 * as JSON text.  The `handleToolResultPersist` hook in index.ts detects the
 * A2UI wrapper and emits `ACTIVITY_SNAPSHOT` events automatically.
 */

const SURFACE_ID = "cron-report";
const CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

/**
 * Fixed A2UI v0.9 component tree for the cron report card layout.
 *
 * Renders a horizontal list of cards.  Each card shows:
 * - Top row: "Started" caption + start time heading
 * - Divider
 * - Model row: "Model" caption + model name
 * - Metrics row: "Tokens" + count, "Duration" + time
 * - Divider
 * - Summary: caption + body text
 */
const CRON_REPORT_SCHEMA = [
  {
    id: "root",
    component: "List",
    children: { componentId: "run-card", path: "/runs" },
    direction: "horizontal",
    align: "start",
  },
  { id: "run-card", component: "Card", child: "run-col" },
  {
    id: "run-col",
    component: "Column",
    children: [
      "time-row",
      "divider-1",
      "model-row",
      "tokens-row",
      "divider-2",
      "summary-label",
      "summary-text",
    ],
    align: "stretch",
  },

  {
    id: "time-row",
    component: "Row",
    children: ["started-label", "started-value"],
    justify: "spaceBetween",
    align: "center",
  },
  { id: "started-label", component: "Text", text: "Started", variant: "caption" },
  { id: "started-value", component: "Text", text: { path: "startedAt" }, variant: "h3" },

  { id: "divider-1", component: "Divider" },

  {
    id: "model-row",
    component: "Row",
    children: ["model-label", "model-value"],
    justify: "spaceBetween",
    align: "center",
  },
  { id: "model-label", component: "Text", text: "Model", variant: "caption" },
  { id: "model-value", component: "Text", text: { path: "model" }, variant: "body" },

  {
    id: "tokens-row",
    component: "Row",
    children: ["tokens-label", "tokens-value", "duration-label", "duration-value"],
    justify: "spaceBetween",
    align: "center",
  },
  { id: "tokens-label", component: "Text", text: "Tokens", variant: "caption" },
  { id: "tokens-value", component: "Text", text: { path: "tokensUsed" }, variant: "body" },
  { id: "duration-label", component: "Text", text: "Duration", variant: "caption" },
  { id: "duration-value", component: "Text", text: { path: "duration" }, variant: "body" },

  { id: "divider-2", component: "Divider" },

  { id: "summary-label", component: "Text", text: "Summary", variant: "caption" },
  { id: "summary-text", component: "Text", text: { path: "summary" }, variant: "body" },
];

interface CronRun {
  id: string;
  startedAt: string;
  duration: string;
  model: string;
  tokensUsed: string;
  summary: string;
}

/**
 * Tool factory for the `cron_report` server-side tool.
 *
 * Returns the tool when a sessionKey is present (i.e. within an AG-UI
 * request), or `null` otherwise.
 */
export function cronReportToolFactory(ctx: { sessionKey?: string }) {
  if (!ctx.sessionKey) return null;

  return {
    name: "cron_report",
    label: "Cron Report",
    description:
      "Display cron job run results as rich visual cards. Call this tool with an array of " +
      "cron run objects. Each run must have: id (unique string), startedAt (readable date/time), " +
      "duration (e.g. \"2m 14s\"), model (LLM model name), tokensUsed (formatted number string), " +
      "and summary (free-text description of what the run did and its status).",
    parameters: {
      type: "object" as const,
      properties: {
        runs: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const, description: "Unique run identifier" },
              startedAt: { type: "string" as const, description: "When the run started, e.g. 'Apr 5, 10:30 AM'" },
              duration: { type: "string" as const, description: "How long the run took, e.g. '2m 14s'" },
              model: { type: "string" as const, description: "LLM model used, e.g. 'claude-sonnet-4-6'" },
              tokensUsed: { type: "string" as const, description: "Total tokens consumed, e.g. '12,847'" },
              summary: { type: "string" as const, description: "Free-text summary of what the job did and its outcome" },
            },
            required: ["id", "startedAt", "duration", "model", "tokensUsed", "summary"],
          },
        },
      },
      required: ["runs"],
    },
    async execute(_toolCallId: string, args: unknown) {
      const { runs } = args as { runs: CronRun[] };

      const a2uiResult = JSON.stringify({
        a2ui_operations: [
          {
            version: "v0.9",
            createSurface: { surfaceId: SURFACE_ID, catalogId: CATALOG_ID },
          },
          {
            version: "v0.9",
            updateComponents: { surfaceId: SURFACE_ID, components: CRON_REPORT_SCHEMA },
          },
          {
            version: "v0.9",
            updateDataModel: { surfaceId: SURFACE_ID, path: "/", value: { runs } },
          },
        ],
      });

      return {
        content: [{ type: "text" as const, text: a2uiResult }],
        details: { a2ui: true },
      };
    },
  };
}

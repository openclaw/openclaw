/**
 * Arcade Plugin Configuration
 *
 * Defines the configuration schema and types for the Arcade.dev integration.
 */

import { z } from "zod";

// ============================================================================
// Configuration Schema
// ============================================================================

export const ToolkitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tools: z.array(z.string()).optional(),
});

export const ToolsFilterSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

export const ArcadeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  userId: z.string().optional(),
  baseUrl: z.string().default("https://api.arcade.dev"),
  toolPrefix: z.string().default("arcade"),
  toolkits: z.record(z.string(), ToolkitConfigSchema).optional(),
  tools: ToolsFilterSchema.optional(),
  autoAuth: z.boolean().default(true),
  cacheToolsTtlMs: z.number().default(300000), // 5 minutes
  useApiTools: z.boolean().default(false), // Include *Api toolkits (e.g., GithubApi, SlackApi)
});

export type ArcadeConfig = z.infer<typeof ArcadeConfigSchema>;
export type ToolkitConfig = z.infer<typeof ToolkitConfigSchema>;
export type ToolsFilter = z.infer<typeof ToolsFilterSchema>;

// ============================================================================
// Default Toolkits
// ============================================================================

/**
 * Popular Arcade toolkits with their common tool names
 */
export const ARCADE_TOOLKITS = {
  // Productivity
  gmail: {
    label: "Gmail",
    description: "Send, read, and manage emails",
    tools: [
      "Gmail.SendEmail",
      "Gmail.SearchMessages",
      "Gmail.GetMessage",
      "Gmail.ListMessages",
      "Gmail.CreateDraft",
      "Gmail.ListLabels",
    ],
  },
  "google-calendar": {
    label: "Google Calendar",
    description: "Manage calendar events",
    tools: [
      "GoogleCalendar.ListEvents",
      "GoogleCalendar.CreateEvent",
      "GoogleCalendar.UpdateEvent",
      "GoogleCalendar.DeleteEvent",
      "GoogleCalendar.GetEvent",
    ],
  },
  "google-drive": {
    label: "Google Drive",
    description: "Manage files and folders",
    tools: [
      "GoogleDrive.ListFiles",
      "GoogleDrive.GetFile",
      "GoogleDrive.CreateFile",
      "GoogleDrive.UpdateFile",
      "GoogleDrive.DeleteFile",
      "GoogleDrive.SearchFiles",
    ],
  },
  "google-docs": {
    label: "Google Docs",
    description: "Create and edit documents",
    tools: [
      "GoogleDocs.CreateDocument",
      "GoogleDocs.GetDocument",
      "GoogleDocs.UpdateDocument",
      "GoogleDocs.CreateDocumentFromText",
    ],
  },
  "google-sheets": {
    label: "Google Sheets",
    description: "Work with spreadsheets",
    tools: [
      "GoogleSheets.GetSpreadsheet",
      "GoogleSheets.GetValues",
      "GoogleSheets.UpdateValues",
      "GoogleSheets.AppendValues",
      "GoogleSheets.CreateSpreadsheet",
    ],
  },
  notion: {
    label: "Notion",
    description: "Manage pages and databases",
    tools: [
      "Notion.SearchPages",
      "Notion.GetPage",
      "Notion.CreatePage",
      "Notion.UpdatePage",
      "Notion.QueryDatabase",
    ],
  },
  asana: {
    label: "Asana",
    description: "Project and task management",
    tools: [
      "Asana.ListTasks",
      "Asana.CreateTask",
      "Asana.UpdateTask",
      "Asana.GetTask",
      "Asana.ListProjects",
    ],
  },
  linear: {
    label: "Linear",
    description: "Issue tracking",
    tools: [
      "Linear.ListIssues",
      "Linear.CreateIssue",
      "Linear.UpdateIssue",
      "Linear.GetIssue",
      "Linear.ListProjects",
    ],
  },
  jira: {
    label: "Jira",
    description: "Issue and project tracking",
    tools: [
      "Jira.SearchIssues",
      "Jira.CreateIssue",
      "Jira.UpdateIssue",
      "Jira.GetIssue",
      "Jira.ListProjects",
    ],
  },

  // Communication
  slack: {
    label: "Slack",
    description: "Send messages and manage channels",
    tools: [
      "Slack.PostMessage",
      "Slack.ListChannels",
      "Slack.GetChannelHistory",
      "Slack.SearchMessages",
      "Slack.ListUsers",
    ],
  },
  discord: {
    label: "Discord",
    description: "Send messages and manage servers",
    tools: [
      "Discord.SendMessage",
      "Discord.ListChannels",
      "Discord.GetMessages",
      "Discord.ListGuilds",
    ],
  },
  "ms-teams": {
    label: "Microsoft Teams",
    description: "Send messages and manage teams",
    tools: [
      "MSTeams.SendMessage",
      "MSTeams.ListChannels",
      "MSTeams.GetMessages",
      "MSTeams.ListTeams",
    ],
  },
  outlook: {
    label: "Outlook",
    description: "Email and calendar via Microsoft",
    tools: [
      "Outlook.SendEmail",
      "Outlook.ListMessages",
      "Outlook.GetMessage",
      "Outlook.ListEvents",
    ],
  },
  zoom: {
    label: "Zoom",
    description: "Video meetings",
    tools: [
      "Zoom.CreateMeeting",
      "Zoom.ListMeetings",
      "Zoom.GetMeeting",
      "Zoom.DeleteMeeting",
    ],
  },

  // Development
  github: {
    label: "GitHub",
    description: "Repository and issue management",
    tools: [
      "GitHub.ListRepos",
      "GitHub.GetRepo",
      "GitHub.ListIssues",
      "GitHub.CreateIssue",
      "GitHub.ListPullRequests",
      "GitHub.GetPullRequest",
      "GitHub.CreatePullRequest",
    ],
  },
  figma: {
    label: "Figma",
    description: "Design file access",
    tools: [
      "Figma.GetFile",
      "Figma.GetComments",
      "Figma.PostComment",
      "Figma.GetImages",
    ],
  },

  // Finance
  stripe: {
    label: "Stripe",
    description: "Payment processing",
    tools: [
      "Stripe.ListCustomers",
      "Stripe.GetCustomer",
      "Stripe.ListPayments",
      "Stripe.CreatePaymentLink",
    ],
  },
  hubspot: {
    label: "HubSpot",
    description: "CRM and marketing",
    tools: [
      "HubSpot.ListContacts",
      "HubSpot.GetContact",
      "HubSpot.CreateContact",
      "HubSpot.ListDeals",
    ],
  },
  salesforce: {
    label: "Salesforce",
    description: "CRM platform",
    tools: [
      "Salesforce.Query",
      "Salesforce.GetRecord",
      "Salesforce.CreateRecord",
      "Salesforce.UpdateRecord",
    ],
  },

  // Support
  zendesk: {
    label: "Zendesk",
    description: "Customer support",
    tools: [
      "Zendesk.ListTickets",
      "Zendesk.GetTicket",
      "Zendesk.CreateTicket",
      "Zendesk.UpdateTicket",
    ],
  },
  intercom: {
    label: "Intercom",
    description: "Customer messaging",
    tools: [
      "Intercom.ListConversations",
      "Intercom.GetConversation",
      "Intercom.ReplyToConversation",
    ],
  },

  // Search & Data
  "google-search": {
    label: "Google Search",
    description: "Web search",
    tools: ["GoogleSearch.Search"],
  },
  "google-news": {
    label: "Google News",
    description: "News search",
    tools: ["GoogleNews.SearchNewsStories", "GoogleNews.GetTopStories"],
  },
  firecrawl: {
    label: "Firecrawl",
    description: "Web scraping",
    tools: ["Firecrawl.Scrape", "Firecrawl.Crawl"],
  },

  // Databases
  postgres: {
    label: "PostgreSQL",
    description: "SQL database queries",
    tools: ["Postgres.Query", "Postgres.Execute"],
  },
  mongodb: {
    label: "MongoDB",
    description: "NoSQL database operations",
    tools: ["MongoDB.Find", "MongoDB.Insert", "MongoDB.Update", "MongoDB.Delete"],
  },
} as const;

export type ArcadeToolkitId = keyof typeof ARCADE_TOOLKITS;

// ============================================================================
// Config Helpers
// ============================================================================

/**
 * Resolve and validate Arcade configuration
 */
export function resolveArcadeConfig(raw: unknown): ArcadeConfig {
  const parsed = ArcadeConfigSchema.parse(raw ?? {});

  // Check for API key from environment if not in config
  if (!parsed.apiKey) {
    parsed.apiKey = process.env.ARCADE_API_KEY ?? process.env.ARCADE_KEY;
  }

  // Check for user ID from environment
  if (!parsed.userId) {
    parsed.userId = process.env.ARCADE_USER_ID ?? process.env.ARCADE_USER;
  }

  return parsed;
}

/**
 * Check if a tool name matches filter patterns
 */
export function matchesToolFilter(
  toolName: string,
  filter?: ToolsFilter,
): boolean {
  if (!filter) return true;

  const { allow, deny } = filter;

  // Check deny list first
  if (deny?.length) {
    for (const pattern of deny) {
      if (matchesPattern(toolName, pattern)) {
        return false;
      }
    }
  }

  // If no allowlist, allow by default
  if (!allow?.length) return true;

  // Check allowlist
  for (const pattern of allow) {
    if (matchesPattern(toolName, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Match a tool name against a glob-like pattern
 * Supports: *, exact match, prefix.*
 */
function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;

  // Handle wildcard patterns like "Gmail.*" or "*Search*"
  const regex = new RegExp(
    "^" + pattern.split("*").map(escapeRegex).join(".*") + "$",
    "i",
  );
  return regex.test(toolName);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Plugin Config Schema (for OpenClaw)
// ============================================================================

/**
 * Check if a toolkit name is an "Api" toolkit (e.g., GithubApi, SlackApi)
 */
export function isApiToolkit(toolkitName: string): boolean {
  return toolkitName.endsWith("Api");
}

export const arcadeConfigSchema = {
  parse(value: unknown): ArcadeConfig {
    return resolveArcadeConfig(value);
  },
  uiHints: {
    enabled: {
      label: "Enable Arcade Plugin",
    },
    apiKey: {
      label: "Arcade API Key",
      sensitive: true,
      placeholder: "arc_...",
    },
    userId: {
      label: "User ID",
      placeholder: "user@example.com",
    },
    baseUrl: {
      label: "API Base URL",
      advanced: true,
    },
    toolPrefix: {
      label: "Tool Name Prefix",
      advanced: true,
    },
    autoAuth: {
      label: "Auto-prompt Authorization",
    },
    cacheToolsTtlMs: {
      label: "Tool Cache TTL (ms)",
      advanced: true,
    },
    useApiTools: {
      label: "Include API Toolkits",
      description: "Include comprehensive API toolkits (e.g., GithubApi, SlackApi) with more tools",
    },
  },
};

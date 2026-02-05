/**
 * Scope definitions registry for the web UI.
 *
 * This is a client-side mirror of the server-side provider definitions,
 * containing only the scope-related data needed for UI rendering.
 */

import type { ConnectionProviderScopes, ScopePreset } from "./types";

const providers: Map<string, ConnectionProviderScopes> = new Map();

// GitHub scopes
providers.set("github", {
  providerId: "github",
  label: "GitHub",
  scopes: [
    {
      id: "repo",
      label: "Full repository access",
      description: "Read and write access to public and private repositories",
      risk: "high",
      recommended: true,
      examples: ["Clone private repositories", "Push commits", "Create branches", "Manage pull requests"],
      implies: ["repo:status", "repo_deployment", "public_repo"],
    },
    {
      id: "public_repo",
      label: "Public repositories only",
      description: "Read and write access to public repositories",
      risk: "medium",
      examples: ["Fork public repos", "Create public PRs", "Comment on issues"],
    },
    {
      id: "repo:status",
      label: "Commit statuses",
      description: "Read and write commit status",
      risk: "low",
      examples: ["Check CI status", "Update commit checks"],
    },
    {
      id: "read:org",
      label: "Read organization",
      description: "Read organization membership and team info",
      risk: "low",
      recommended: true,
      examples: ["List org members", "View team membership"],
    },
    {
      id: "read:user",
      label: "Read user profile",
      description: "Read user profile data",
      risk: "low",
      examples: ["View profile info", "Get email addresses"],
    },
    {
      id: "user:email",
      label: "Email addresses",
      description: "Access user email addresses",
      risk: "low",
      examples: ["Get verified emails"],
    },
    {
      id: "read:project",
      label: "Read projects",
      description: "Read access to projects",
      risk: "low",
      examples: ["View project boards", "List project items"],
    },
    {
      id: "workflow",
      label: "GitHub Actions workflows",
      description: "Update GitHub Actions workflow files",
      risk: "high",
      examples: ["Modify CI/CD pipelines", "Update workflow definitions"],
    },
    {
      id: "gist",
      label: "Gists",
      description: "Create and manage gists",
      risk: "low",
      examples: ["Create gists", "Update gists"],
    },
  ],
  categories: [
    {
      id: "repository",
      label: "Repository",
      description: "Access to repositories and code",
      scopes: ["repo", "public_repo", "repo:status"],
    },
    {
      id: "organization",
      label: "Organization",
      description: "Organization membership and teams",
      scopes: ["read:org"],
      collapsed: true,
    },
    {
      id: "user",
      label: "User",
      description: "User profile information",
      scopes: ["read:user", "user:email"],
      collapsed: true,
    },
    {
      id: "other",
      label: "Other",
      description: "Projects, workflows, and gists",
      scopes: ["read:project", "workflow", "gist"],
      collapsed: true,
    },
  ],
  presets: [
    {
      id: "read-only",
      label: "Read-only",
      description: "Read access to repos and org info",
      scopes: ["public_repo", "repo:status", "read:org", "read:user", "read:project"],
    },
    {
      id: "developer",
      label: "Developer",
      description: "Full repo access and organization membership",
      scopes: ["repo", "read:org", "read:user", "user:email", "read:project"],
    },
    {
      id: "full-access",
      label: "Full access",
      description: "All repository, workflow, and project permissions",
      scopes: ["repo", "read:org", "workflow", "read:project", "read:user", "user:email", "gist"],
    },
  ],
});

// Slack scopes
providers.set("slack", {
  providerId: "slack",
  label: "Slack",
  scopes: [
    {
      id: "chat:write",
      label: "Send messages",
      description: "Send messages as the bot",
      risk: "medium",
      required: true,
      examples: ["Post messages to channels", "Send DMs"],
    },
    {
      id: "channels:read",
      label: "View public channels",
      description: "View basic info about public channels",
      risk: "low",
      recommended: true,
      examples: ["List channels", "Get channel info"],
    },
    {
      id: "channels:history",
      label: "Read public channel history",
      description: "Read messages in public channels the bot is in",
      risk: "medium",
      recommended: true,
      examples: ["Search messages", "Read channel history"],
    },
    {
      id: "im:history",
      label: "Read DM history",
      description: "Read message history in DMs with the bot",
      risk: "medium",
      recommended: true,
      examples: ["Respond to DMs", "Search DM history"],
    },
    {
      id: "users:read",
      label: "View users",
      description: "View basic user info",
      risk: "low",
      recommended: true,
      examples: ["List users", "Get user profiles"],
    },
    {
      id: "reactions:write",
      label: "Add reactions",
      description: "Add and remove emoji reactions",
      risk: "low",
      recommended: true,
      examples: ["React to messages", "Acknowledge tasks"],
    },
    {
      id: "files:read",
      label: "View files",
      description: "View files shared in channels",
      risk: "medium",
      examples: ["Download shared files"],
    },
    {
      id: "files:write",
      label: "Upload files",
      description: "Upload and manage files",
      risk: "medium",
      examples: ["Share files", "Upload images"],
    },
  ],
  categories: [
    {
      id: "messaging",
      label: "Messaging",
      description: "Send and customize messages",
      scopes: ["chat:write"],
    },
    {
      id: "channels",
      label: "Channels",
      description: "Read and access channels",
      scopes: ["channels:read", "channels:history"],
    },
    {
      id: "direct-messages",
      label: "Direct Messages",
      description: "Access DMs with the bot",
      scopes: ["im:history"],
    },
    {
      id: "other",
      label: "Other",
      description: "Users, reactions, and files",
      scopes: ["users:read", "reactions:write", "files:read", "files:write"],
      collapsed: true,
    },
  ],
  presets: [
    {
      id: "read-only",
      label: "Read-only",
      description: "Read channels and users, no messaging",
      scopes: ["channels:read", "channels:history", "users:read"],
    },
    {
      id: "messaging",
      label: "Messaging",
      description: "Basic messaging in channels and DMs",
      scopes: ["chat:write", "channels:read", "channels:history", "im:history", "users:read", "reactions:write"],
    },
  ],
});

// Google scopes
providers.set("google", {
  providerId: "google",
  label: "Google Workspace",
  scopes: [
    {
      id: "openid",
      label: "OpenID Connect",
      description: "Basic authentication",
      risk: "low",
      required: true,
    },
    {
      id: "profile",
      label: "Profile info",
      description: "View your basic profile info",
      risk: "low",
      required: true,
    },
    {
      id: "email",
      label: "Email address",
      description: "View your email address",
      risk: "low",
      required: true,
    },
    {
      id: "https://www.googleapis.com/auth/gmail.readonly",
      label: "Read emails",
      description: "Read all emails and settings",
      risk: "high",
      examples: ["Search emails", "Read inbox", "View labels"],
    },
    {
      id: "https://www.googleapis.com/auth/gmail.send",
      label: "Send emails",
      description: "Send emails on your behalf",
      risk: "high",
      examples: ["Send emails", "Reply to emails"],
    },
    {
      id: "https://www.googleapis.com/auth/calendar.readonly",
      label: "Read calendars",
      description: "View your calendars and events",
      risk: "low",
      recommended: true,
      examples: ["View events", "Check availability"],
    },
    {
      id: "https://www.googleapis.com/auth/calendar.events",
      label: "Manage events",
      description: "View and edit events on your calendars",
      risk: "medium",
      examples: ["Create events", "Update events", "Delete events"],
    },
    {
      id: "https://www.googleapis.com/auth/drive.readonly",
      label: "Read Drive files",
      description: "View and download your Google Drive files",
      risk: "medium",
      recommended: true,
      examples: ["List files", "Download files", "Search files"],
    },
    {
      id: "https://www.googleapis.com/auth/drive.file",
      label: "Files created by app",
      description: "View and manage files created by this app",
      risk: "low",
      examples: ["Upload files", "Manage app files"],
    },
  ],
  categories: [
    {
      id: "profile",
      label: "Profile",
      description: "Basic profile information",
      scopes: ["openid", "profile", "email"],
    },
    {
      id: "gmail",
      label: "Gmail",
      description: "Email access",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
      collapsed: true,
    },
    {
      id: "calendar",
      label: "Calendar",
      description: "Calendar access",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
    },
    {
      id: "drive",
      label: "Drive",
      description: "File storage",
      scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"],
    },
  ],
  presets: [
    {
      id: "read-only",
      label: "Read-only",
      description: "View calendars and files without write access",
      scopes: [
        "openid",
        "profile",
        "email",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    },
    {
      id: "productivity",
      label: "Productivity",
      description: "Calendar and Drive access",
      scopes: [
        "openid",
        "profile",
        "email",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ],
    },
  ],
});

// Notion scopes
providers.set("notion", {
  providerId: "notion",
  label: "Notion",
  scopes: [
    {
      id: "read_content",
      label: "Read content",
      description: "Read pages and databases you share with this integration",
      risk: "low",
      required: true,
      examples: ["Read page content", "Query databases", "List pages"],
    },
    {
      id: "update_content",
      label: "Update content",
      description: "Edit pages and databases you share with this integration",
      risk: "medium",
      recommended: true,
      examples: ["Edit pages", "Update database entries", "Create content"],
    },
    {
      id: "insert_content",
      label: "Create content",
      description: "Create new pages and databases",
      risk: "medium",
      recommended: true,
      examples: ["Create pages", "Add database entries", "Create databases"],
    },
    {
      id: "read_comments",
      label: "Read comments",
      description: "Read comments on pages you share with this integration",
      risk: "low",
      examples: ["View discussions", "Read feedback"],
    },
    {
      id: "create_comments",
      label: "Create comments",
      description: "Add comments to pages you share with this integration",
      risk: "low",
      examples: ["Add feedback", "Participate in discussions"],
    },
  ],
  categories: [
    {
      id: "content",
      label: "Content",
      description: "Page and database access",
      scopes: ["read_content", "update_content", "insert_content"],
    },
    {
      id: "comments",
      label: "Comments",
      description: "Comments and discussions",
      scopes: ["read_comments", "create_comments"],
      collapsed: true,
    },
  ],
  presets: [
    {
      id: "read-only",
      label: "Read-only",
      description: "Read pages and databases without write access",
      scopes: ["read_content", "read_comments"],
    },
    {
      id: "full-access",
      label: "Full access",
      description: "Read, create, and update all shared content",
      scopes: ["read_content", "update_content", "insert_content", "read_comments", "create_comments"],
    },
  ],
});

/**
 * Get scope configuration for a provider.
 */
export function getProviderScopes(providerId: string): ConnectionProviderScopes | undefined {
  return providers.get(providerId);
}

/**
 * Get all registered providers.
 */
export function getAllProviderScopes(): ConnectionProviderScopes[] {
  return Array.from(providers.values());
}

/**
 * Get presets for a provider.
 */
export function getProviderPresets(providerId: string): ScopePreset[] {
  return providers.get(providerId)?.presets ?? [];
}

/**
 * Get scopes for a preset.
 */
export function getPresetScopes(providerId: string, presetId: string): string[] | undefined {
  const provider = providers.get(providerId);
  const preset = provider?.presets?.find((p) => p.id === presetId);
  return preset?.scopes;
}

/**
 * Get default scopes (required + recommended) for a provider.
 */
export function getDefaultScopes(providerId: string): string[] {
  const provider = providers.get(providerId);
  if (!provider) return [];
  return provider.scopes.filter((s) => s.required || s.recommended).map((s) => s.id);
}

/**
 * Expand scopes to include implied scopes.
 */
export function expandScopes(providerId: string, scopeIds: string[]): string[] {
  const provider = providers.get(providerId);
  if (!provider) return scopeIds;

  const scopeMap = new Map(provider.scopes.map((s) => [s.id, s]));
  const result = new Set(scopeIds);

  const addImplied = (id: string) => {
    const scope = scopeMap.get(id);
    if (scope?.implies) {
      for (const implied of scope.implies) {
        if (!result.has(implied)) {
          result.add(implied);
          addImplied(implied);
        }
      }
    }
  };

  for (const id of scopeIds) {
    addImplied(id);
  }

  // Always include required scopes
  for (const scope of provider.scopes) {
    if (scope.required) {
      result.add(scope.id);
    }
  }

  return Array.from(result);
}

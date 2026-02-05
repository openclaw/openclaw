"use client";

import * as React from "react";
import { Check, ExternalLink, Settings2, RefreshCw, AlertCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectionWizardWithScopes } from "./ConnectionWizardWithScopes";
import { useConnectionManager, type ConnectionStatus } from "@/hooks/useConnectionManager";
import { getDefaultScopes } from "@/lib/scopes";

interface Connection {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  authMethods: Array<{
    id: string;
    label: string;
    description: string;
    type: "oauth" | "api_key" | "token";
    badge?: string;
    fields?: Array<{
      id: string;
      label: string;
      placeholder?: string;
      type?: "text" | "password" | "url";
      helpText?: string;
      required?: boolean;
      multiline?: boolean;
      rows?: number;
    }>;
    scopes?: string[];
    ctaLabel?: string;
    ctaHint?: string;
  }>;
  syncOptions?: Array<{
    id: string;
    label: string;
    description: string;
    defaultEnabled?: boolean;
  }>;
}

interface ConnectionsSectionWithOAuthProps {
  className?: string;
  gatewayBaseUrl?: string;
}

// Simple SVG icons for integrations
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" />
      <path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" />
      <path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" />
      <path fill="#ECB22E" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

function NotionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.84-.046.933-.56.933-1.167V6.354c0-.606-.233-.933-.746-.886l-15.177.887c-.56.046-.747.326-.747.933zm14.337.746c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.747 0-.933-.234-1.494-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.886.747-.933l3.222-.187zM2.735 0.608l13.682-.886c1.68-.14 2.1.046 2.8.606l3.876 2.707c.467.327.607.42.607.933v15.857c0 1.026-.373 1.633-1.68 1.727l-15.458.933c-.98.047-1.448-.093-1.962-.747L1.242 18.96c-.56-.7-.793-1.214-.793-1.821V2.055c0-.793.373-1.4 1.353-1.447z" />
    </svg>
  );
}

function LinearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M1.16 6.16a11.94 11.94 0 0 1 16.68-5L1.16 17.84a11.94 11.94 0 0 1 0-11.68zm.56 12.8L18.4 2.28a12 12 0 0 1 3.32 4.56l-13.6 13.6a11.94 11.94 0 0 1-6.4-1.48zM22.84 7.6a11.94 11.94 0 0 1-10.8 15.24z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

// Connection definitions with OAuth support
const CONNECTION_DEFINITIONS: Connection[] = [
  {
    id: "github",
    name: "GitHub",
    icon: <GitHubIcon className="h-6 w-6" />,
    description: "Sync repositories and issues with your agents",
    authMethods: [
      {
        id: "github-oauth",
        label: "GitHub OAuth",
        description: "Connect your GitHub account and select repositories",
        type: "oauth",
        badge: "Recommended",
        scopes: ["repo", "read:org", "read:project"],
        ctaLabel: "Continue with GitHub",
        ctaHint: "You can fine-tune repo access after authorization.",
      },
      {
        id: "github-pat",
        label: "Personal Access Token",
        description: "Use a fine-grained or classic token",
        type: "api_key",
        fields: [
          {
            id: "token",
            label: "Personal Access Token",
            placeholder: "ghp_xxxxxxxxxxxxxxxxxxxxx",
            type: "password",
            helpText: "Store a token with repo and workflow access as needed.",
          },
          {
            id: "repoAllowlist",
            label: "Repo allowlist (optional)",
            placeholder: "org/repo-one\\norg/repo-two",
            multiline: true,
            rows: 3,
            helpText: "Limit access to specific repos. Leave blank to allow all.",
            required: false,
          },
        ],
      },
    ],
    syncOptions: [
      { id: "syncIssues", label: "Sync issues", description: "Keep issue updates in sync.", defaultEnabled: true },
      { id: "syncPulls", label: "Sync pull requests", description: "Track PRs and review status.", defaultEnabled: true },
      { id: "syncDeploys", label: "Sync deployments", description: "Surface deploy statuses in activity feeds.", defaultEnabled: false },
    ],
  },
  {
    id: "google",
    name: "Google",
    icon: <GoogleIcon className="h-6 w-6" />,
    description: "Connect Google Calendar, Drive, and Gmail",
    authMethods: [
      {
        id: "google-oauth",
        label: "Google OAuth",
        description: "Sign in with Google and grant access",
        type: "oauth",
        badge: "Recommended",
        scopes: ["gmail.readonly", "calendar.readonly", "drive.readonly"],
        ctaLabel: "Continue with Google",
        ctaHint: "You can narrow scopes per workspace later.",
      },
      {
        id: "google-api-key",
        label: "Service Account / API Key",
        description: "Use a service account or API key for shared resources",
        type: "api_key",
        fields: [
          {
            id: "serviceAccountJson",
            label: "Service Account JSON",
            placeholder: "{\\n  \"type\": \"service_account\", ...\\n}",
            multiline: true,
            rows: 4,
            helpText: "Paste the full JSON key from Google Cloud.",
          },
          {
            id: "delegatedUser",
            label: "Delegated user (optional)",
            placeholder: "user@company.com",
            helpText: "Impersonate a user for domain-wide delegation.",
            required: false,
          },
        ],
      },
    ],
    syncOptions: [
      { id: "syncCalendar", label: "Calendar events", description: "Sync calendars and availability.", defaultEnabled: true },
      { id: "syncDrive", label: "Drive files", description: "Index Drive content for search.", defaultEnabled: true },
      { id: "syncGmail", label: "Gmail messages", description: "Let agents summarize and draft emails.", defaultEnabled: false },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    icon: <SlackIcon className="h-6 w-6" />,
    description: "Send and receive messages through Slack",
    authMethods: [
      {
        id: "slack-oauth",
        label: "Slack OAuth",
        description: "Install the app in a workspace",
        type: "oauth",
        badge: "Recommended",
        scopes: ["chat:write", "channels:read", "im:history"],
        ctaLabel: "Continue with Slack",
      },
      {
        id: "slack-tokens",
        label: "Bot + App Tokens",
        description: "Use bot tokens for Socket Mode or internal apps",
        type: "token",
        fields: [
          {
            id: "botToken",
            label: "Bot Token",
            placeholder: "xoxb-123456789-xxx",
            type: "password",
          },
          {
            id: "appToken",
            label: "App Token (Socket Mode)",
            placeholder: "xapp-123456789-xxx",
            type: "password",
            required: false,
          },
          {
            id: "defaultChannel",
            label: "Default channel (optional)",
            placeholder: "#ops or C012ABCDEF",
            required: false,
          },
        ],
      },
    ],
    syncOptions: [
      { id: "syncChannels", label: "Channel history", description: "Sync recent channel messages.", defaultEnabled: true },
      { id: "syncDMs", label: "Direct messages", description: "Allow agents to respond in DMs.", defaultEnabled: false },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    icon: <NotionIcon className="h-6 w-6" />,
    description: "Sync pages and databases with your workspace",
    authMethods: [
      {
        id: "notion-oauth",
        label: "Notion OAuth",
        description: "Authorize with Notion and pick pages",
        type: "oauth",
        badge: "Recommended",
        ctaLabel: "Continue with Notion",
      },
      {
        id: "notion-token",
        label: "Internal Integration Token",
        description: "Use a token for shared pages/databases",
        type: "api_key",
        fields: [
          {
            id: "integrationToken",
            label: "Integration Token",
            placeholder: "secret_xxxxxxxxxxxxxx",
            type: "password",
          },
          {
            id: "workspaceId",
            label: "Workspace ID (optional)",
            placeholder: "workspace-id",
            required: false,
          },
        ],
      },
    ],
    syncOptions: [
      { id: "syncPages", label: "Pages", description: "Index pages and sub-pages.", defaultEnabled: true },
      { id: "syncDatabases", label: "Databases", description: "Sync databases and views.", defaultEnabled: true },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    icon: <LinearIcon className="h-6 w-6" />,
    description: "Track issues and projects from Linear",
    authMethods: [
      {
        id: "linear-oauth",
        label: "Linear OAuth",
        description: "Connect your Linear workspace",
        type: "oauth",
        badge: "Recommended",
        scopes: ["read", "write"],
        ctaLabel: "Continue with Linear",
      },
      {
        id: "linear-api-key",
        label: "Personal API Key",
        description: "Use a personal API key",
        type: "api_key",
        fields: [
          {
            id: "apiKey",
            label: "API Key",
            placeholder: "lin_api_xxxxxxxxxxxxxx",
            type: "password",
          },
          {
            id: "teamId",
            label: "Default Team ID (optional)",
            placeholder: "team-id",
            required: false,
          },
        ],
      },
    ],
    syncOptions: [
      { id: "syncIssues", label: "Issues", description: "Sync issue updates.", defaultEnabled: true },
      { id: "syncProjects", label: "Projects", description: "Track projects and milestones.", defaultEnabled: true },
      { id: "syncRoadmap", label: "Roadmap", description: "Keep product roadmap in view.", defaultEnabled: false },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    icon: <DiscordIcon className="h-6 w-6" />,
    description: "Connect your Discord servers and channels",
    authMethods: [
      {
        id: "discord-oauth",
        label: "Discord OAuth",
        description: "Install your bot into servers",
        type: "oauth",
        badge: "Recommended",
        scopes: ["bot", "applications.commands"],
        ctaLabel: "Continue with Discord",
      },
      {
        id: "discord-token",
        label: "Bot Token",
        description: "Use a bot token from the Developer Portal",
        type: "token",
        fields: [
          {
            id: "botToken",
            label: "Bot Token",
            placeholder: "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.XXXXXX.XXXXXXXXX",
            type: "password",
          },
          {
            id: "applicationId",
            label: "Application ID (optional)",
            placeholder: "123456789012345678",
            required: false,
          },
        ],
      },
    ],
    syncOptions: [
      { id: "syncServers", label: "Server activity", description: "Sync guilds and channels.", defaultEnabled: true },
      { id: "syncDMs", label: "Direct messages", description: "Allow DM routing.", defaultEnabled: false },
    ],
  },
];

// Providers that have full OAuth implementation in the backend
const OAUTH_ENABLED_PROVIDERS = ["github", "google", "slack", "notion"];

export function ConnectionsSectionWithOAuth({
  className,
  gatewayBaseUrl = "",
}: ConnectionsSectionWithOAuthProps) {
  const {
    statuses,
    loading,
    error,
    connect,
    disconnect,
    fetchAllStatuses,
    storeCredentials,
    clearError,
  } = useConnectionManager(gatewayBaseUrl);

  const [activeConnectionId, setActiveConnectionId] = React.useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const activeConnection = CONNECTION_DEFINITIONS.find(
    (connection) => connection.id === activeConnectionId
  );

  // Fetch statuses on mount
  React.useEffect(() => {
    fetchAllStatuses(OAUTH_ENABLED_PROVIDERS);
  }, [fetchAllStatuses]);

  const handleRefreshStatuses = async () => {
    setRefreshing(true);
    await fetchAllStatuses(OAUTH_ENABLED_PROVIDERS);
    setRefreshing(false);
  };

  const handleOpenWizard = (id: string) => {
    setActiveConnectionId(id);
    setWizardOpen(true);
  };

  const handleDisconnect = async (connectionId: string) => {
    await disconnect(connectionId);
  };

  const getConnectionStatus = (connectionId: string): ConnectionStatus => {
    return statuses[connectionId] || { connected: false };
  };

  const isLoading = (connectionId: string): boolean => {
    return loading[connectionId] || false;
  };

  // Check if a provider supports full OAuth (for scope selection)
  const supportsOAuth = (connectionId: string): boolean => {
    return OAUTH_ENABLED_PROVIDERS.includes(connectionId);
  };

  return (
    <Card className={cn("", className)}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Connections</CardTitle>
            <CardDescription>
              Connect external services and integrations to enhance your agents.
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshStatuses}
            disabled={refreshing}
            className="gap-2"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>{error}</span>
              <Button variant="ghost" size="sm" onClick={clearError}>
                Dismiss
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          {CONNECTION_DEFINITIONS.map((connection) => {
            const status = getConnectionStatus(connection.id);
            const isConnected = status.connected;
            const connectionLoading = isLoading(connection.id);

            return (
              <Card key={connection.id} className="p-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                    {connection.icon}
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{connection.name}</h4>
                      {connectionLoading ? (
                        <Badge variant="outline" className="gap-1">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Loading...
                        </Badge>
                      ) : isConnected ? (
                        <Badge variant="success" className="gap-1">
                          <Check className="h-3 w-3" />
                          Connected
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {connection.description}
                    </p>
                    {isConnected && status.email && (
                      <p className="text-xs text-muted-foreground">
                        Connected as: {status.email}
                      </p>
                    )}
                    {isConnected && status.scopes && status.scopes.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {status.scopes.slice(0, 3).map((scope) => (
                          <Badge
                            key={scope}
                            variant="outline"
                            className="text-[10px] font-normal"
                          >
                            {scope}
                          </Badge>
                        ))}
                        {status.scopes.length > 3 && (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            +{status.scopes.length - 3} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    variant={isConnected ? "outline" : "default"}
                    size="sm"
                    onClick={() => handleOpenWizard(connection.id)}
                    disabled={connectionLoading}
                    className="gap-2"
                  >
                    {isConnected ? (
                      <>
                        <Settings2 className="h-4 w-4" />
                        Manage
                      </>
                    ) : (
                      <>
                        <ExternalLink className="h-4 w-4" />
                        Connect
                      </>
                    )}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </CardContent>

      {activeConnection && (
        <ConnectionWizardWithScopes
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          connection={{
            ...activeConnection,
            connected: getConnectionStatus(activeConnection.id).connected,
            lastSync: getConnectionStatus(activeConnection.id).lastSync,
          }}
          onConnect={async (payload) => {
            const method = activeConnection.authMethods.find(
              (m) => m.id === payload.authMethodId
            );
            if (!method) return;

            if (method.type === "oauth") {
              // Get scopes from wizard payload
              const scopes = payload.scopes || getDefaultScopes(activeConnection.id);
              await connect({
                providerId: activeConnection.id,
                scopes,
              });
            } else {
              // Store API key/token credentials
              await storeCredentials(activeConnection.id, payload.values);
            }
          }}
          onDisconnect={
            getConnectionStatus(activeConnection.id).connected
              ? async () => handleDisconnect(activeConnection.id)
              : undefined
          }
          enableScopeSelection={supportsOAuth(activeConnection.id)}
        />
      )}
    </Card>
  );
}

export default ConnectionsSectionWithOAuth;

export const WORKSPACE_OPTIONS = [
  { id: "golden", label: "Golden Investors", color: "amber" },
  { id: "ras", label: "RAS Logic", color: "emerald" },
  { id: "mustadem", label: "Mustadem", color: "sky" },
  { id: "anteja", label: "Anteja ECG", color: "rose" },
] as const;

export type WorkspaceId = (typeof WORKSPACE_OPTIONS)[number]["id"];

export const DEFAULT_WORKSPACE: WorkspaceId = "golden";

// isValidWorkspaceId lives in workspaces-server.ts to avoid bundling db.ts into client code

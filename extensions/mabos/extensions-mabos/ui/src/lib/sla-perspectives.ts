import type { SLAPerspective } from "./types";

export const perspectives: SLAPerspective[] = [
  {
    id: "status",
    label: "Status",
    description: "Default task status view",
    columns: [
      { id: "backlog", title: "Backlog", color: "var(--text-muted)", statuses: ["backlog"] },
      { id: "todo", title: "To Do", color: "var(--accent-blue)", statuses: ["todo"] },
      {
        id: "in_progress",
        title: "In Progress",
        color: "var(--accent-orange)",
        statuses: ["in_progress"],
      },
      { id: "review", title: "Review", color: "var(--accent-purple)", statuses: ["review"] },
      { id: "done", title: "Done", color: "var(--accent-green)", statuses: ["done"] },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    description: "Marketing campaign workflow",
    columns: [
      {
        id: "ideation",
        title: "Ideation",
        color: "var(--accent-blue)",
        statuses: ["backlog", "todo"],
      },
      {
        id: "production",
        title: "Production",
        color: "var(--accent-orange)",
        statuses: ["in_progress"],
      },
      {
        id: "approval",
        title: "Review & Approval",
        color: "var(--accent-purple)",
        statuses: ["review"],
      },
      { id: "live", title: "Live / Published", color: "var(--accent-green)", statuses: ["done"] },
    ],
  },
  {
    id: "software",
    label: "Development",
    description: "Software development lifecycle",
    columns: [
      { id: "backlog", title: "Backlog", color: "var(--text-muted)", statuses: ["backlog"] },
      {
        id: "sprint",
        title: "Sprint",
        color: "var(--accent-blue)",
        statuses: ["todo", "in_progress"],
      },
      {
        id: "code-review",
        title: "Code Review",
        color: "var(--accent-purple)",
        statuses: ["review"],
      },
      { id: "deployed", title: "Deployed", color: "var(--accent-green)", statuses: ["done"] },
    ],
  },
];

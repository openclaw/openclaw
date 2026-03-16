---
title: "Agents"
summary: "The Agents section covers browsing the marketplace, viewing the org chart, managing installed agents, configuring registries, and monitoring agent health."
---

# Agents

The **Agents** section is where you manage all agents. You can browse available agents, view the organization structure, manage installed agents, configure registries, and check health status.

## Browse

**Path:** `/agents/browse`

Browse is the agent marketplace. See all available agents from connected registries and any bundles you've created.

### Tier badges

Every agent card shows a tier badge indicating its position in the hierarchy:

| Badge             | Tier   | Role                                     |
| ----------------- | ------ | ---------------------------------------- |
| **T1 Core**       | Tier 1 | COO-level coordinator (Operator1)        |
| **T2 Dept Head**  | Tier 2 | Department head (Neo, Morpheus, Trinity) |
| **T3 Specialist** | Tier 3 | Worker agents                            |

### Agent cards

Each card shows:

- Agent name, role, and department
- Version and key capabilities
- Install status

Click a card to see full details. Click **Install** to add it (you'll see a spinner while installing). Deprecated agents show a sunset warning.

### Filtering and search

Use the search box to filter by name, ID, role, or keyword tags. The filter tabs narrow to a category:

| Tab                  | Shows                           |
| -------------------- | ------------------------------- |
| **All**              | Every agent in all registries   |
| **Department Heads** | Tier 2 managers only            |
| **Specialists**      | Tier 3 workers only             |
| **Core**             | Tier 1 core agents              |
| **Bundles**          | Custom bundles you have created |

Each tab label shows the count in parentheses.

### View modes

Toggle between **grid** (card layout) and **table** (sortable columns) using the buttons in the top-right. The preference is persisted per browser in `localStorage`.

### Bundles

A bundle is a saved set of agents for easy team setup. Each bundle card shows agent count, install status, and progress.

**Create a bundle:** Click **Create Bundle**, give it a name, and select which agents to include.

**Edit or delete:** Use the pencil or trash icons on the bundle card. Deleting only removes the bundle definition; installed agents stay.

**View in organization chart:** Click the branch icon to filter the org chart to just this bundle's agents.

---

## Organization

**Path:** `/agents/organization`

View the entire agent hierarchy as an interactive org chart. Nodes are agents; lines show who reports to whom.

### Layout

Agents are arranged top-down by tier:

```
Operator1 (T1 COO)
├── Neo (T2 CTO) ── Engineering workers
├── Morpheus (T2 CMO) ── Marketing workers
└── Trinity (T2 CFO) ── Finance workers
```

The minimap in the bottom-left shows the full graph at a glance. Standard React Flow pan/zoom controls are in the bottom-right.

### Department colors

Each department has a distinct node accent color shown in the legend overlay (top-right of the canvas):

| Department  | Color  |
| ----------- | ------ |
| Operations  | teal   |
| Engineering | blue   |
| Finance     | amber  |
| Marketing   | purple |

### Interacting with nodes

Right-click or hover a node to reveal its action menu:

| Action               | Description                                      |
| -------------------- | ------------------------------------------------ |
| **Preview**          | Open the agent detail sheet                      |
| **Edit config**      | Open the config editor for this agent            |
| **Clone**            | Open Create Agent pre-filled from this agent     |
| **Add specialist**   | Create a new Tier 3 agent reporting to this node |
| **Enable / Disable** | Toggle the agent without uninstalling it         |
| **Delete**           | Remove the agent from the registry               |
| **Health**           | Open the health check dialog                     |

### Bundle filter

Select a bundle from the **Bundle selector** dropdown (top toolbar) to filter the org chart to only the agents in that bundle. The bundle overlay (bottom-left of canvas) shows the bundle name, version, agent count, and install status. From there you can **Deploy Bundle** (installs all un-installed agents) or **Delete** the bundle.

**Clear** the bundle filter to return to the full hierarchy. The active bundle is reflected in the URL query string (`?bundle=<id>`), so the filtered view is bookmarkable and linkable.

### Creating / editing bundles from the org chart

Use **Save as Bundle** (when no filter is active) to create a bundle from the current visible graph. Use **Edit Bundle** (when a bundle is active) to modify its name, description, or agent list.

---

## Installed

**Path:** `/agents/installed`

See which agents are deployed and active on your system. This shows what's running, unlike Browse which shows what's available.

### Scopes

Each installed agent has a scope indicating where its config files live:

| Scope     | Location                             |
| --------- | ------------------------------------ |
| `local`   | Per-machine, not committed to repo   |
| `project` | Repo-level, committed alongside code |
| `user`    | User-level, shared across projects   |

### Agent status

Agents can be `active` or `disabled`. A disabled agent has its workspace preserved but is excluded from routing until re-enabled. The disable reason (if any) is shown in the table.

### Actions per agent

| Action               | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| **Config**           | Open the configuration editor                                      |
| **Enable / Disable** | Toggle routing without removing the agent                          |
| **Clone**            | Create a new agent pre-filled from this one                        |
| **View logs**        | Navigate to the agent's session logs                               |
| **Workspace files**  | Expand inline to browse workspace files (SOUL.md, AGENTS.md, etc.) |
| **Remove**           | Uninstall the agent and delete workspace files                     |

### Inline workspace file browser

Click the folder icon on an agent row to expand a file tree of its workspace. You can view, edit, and save individual files (SOUL.md, IDENTITY.md, AGENTS.md, etc.) inline without leaving the page. Changes are saved via the gateway RPC.

### Saving the agent list as a bundle

The **Save as Bundle** button in the toolbar captures the current installed set as a named bundle for re-deployment on other machines.

---

## Registries

**Path:** `/agents/registries`

Registries are sources of agent definitions. You can add custom or private registries here (the default registry is included).

### Registry fields

| Field              | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| **ID**             | Machine-readable identifier                                                     |
| **Name**           | Display name                                                                    |
| **URL**            | Endpoint serving the agent manifest JSON                                        |
| **Visibility**     | `public` (no auth) or `private` (requires token)                                |
| **Auth token env** | Environment variable name containing the bearer token (private registries only) |

### Adding a registry

Click **Add Registry** and fill in the form. For private registries, set `Auth token env` to the name of an environment variable (e.g. `MY_REGISTRY_TOKEN`) that holds the token — the value is never stored in the UI, only the env var name.

### Sync

Each registry card shows:

- Agent count (populated after a sync)
- Last synced timestamp
- Enable / disable toggle
- Manual **Sync** button to pull the latest manifest

Disabled registries are skipped during marketplace browsing and agent installs.

### Bundled registries

Registries marked as **bundled** are provided by the platform and cannot be deleted, only disabled.

---

## Health

**Path:** `/agents/health`

The Health page runs diagnostic checks across all installed agents and reports the results. It also surfaces agents that need a workspace upgrade to match the latest manifest.

### Health status levels

| Status       | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| **Healthy**  | All checks pass                                         |
| **Degraded** | One or more warnings (non-critical)                     |
| **Error**    | One or more failures (agent may not function correctly) |

### Check types

Each agent runs a set of named checks. Common checks include:

- **workspace_exists** — the agent's workspace directory is present
- **soul_file** — `SOUL.md` exists and is non-empty
- **identity_file** — `IDENTITY.md` is present
- **agents_file** — `AGENTS.md` is present
- **config_valid** — the agent manifest validates against the schema
- **version_match** — installed version matches the registry manifest

### Auto-fix

For checks that have a known fix, a **Fix** button appears inline. Clicking it opens a preview dialog showing exactly what the fix will do (e.g. regenerate a missing file, update a config value). Confirm to apply.

The **Fix All** button (top toolbar) runs auto-fixes for every fixable issue across all agents in one pass.

### Deploy / upgrade

The **Deploy Status** tab (or column in table view) shows agents that have a newer version available in the registry. The **Upgrade** action updates the agent's workspace files to the latest manifest version without reinstalling.

The **Deploy All Pending** button applies all available upgrades in one operation.

### View modes

Switch between grid (health cards) and table (compact sortable list) using the toggle in the toolbar. The table view supports sorting by name, tier, scope, and status.

---
summary: "Author, inspect, and add Template bundles as ordinary agents"
read_when:
  - You are authoring or validating a CLAW.md manifest
  - You want to add a new agent from a Template
  - You need to understand what remains after deleting that agent
title: "Templates"
---

# `openclaw templates`

A Template is a portable setup for a new OpenClaw agent. It can include agent
instructions, workspace files, skills, plugins, MCP servers, and automations.
**Add is a one-way action:** it creates an ordinary agent and installs its
requirements. It does not create an installed Template to manage. Adding the same
Template again creates another agent.

After Add, manage the agent with [agent commands](/cli/agents), its automations
with [cron commands](/automation/cron-jobs), and shared dependencies with their
ordinary plugin or MCP controls. There are no Template status, update, remove, or
export commands. To use a newer release, Add it as another agent.

Enable **Templates** in **Settings → Labs** before adding one. On a headless installation, set
`gateway.controlUi.experimental.templates` to `true` in OpenClaw config.
Authoring and inspecting local Template packages do not require the Labs toggle.

`templates add` accepts a ClawHub Template reference (`@publisher/slug`), a canonical
local package directory, or `CLAW.md` with YAML frontmatter. The reference uses the
publisher's ClawHub handle, as skill references do, including for a Template whose
package name is the unscoped slug. Other source-reading commands remain local-only.
Packages must declare `package.json.openclaw.template` as a safe package-relative
path whose filename is `CLAW.md`, such as `CLAW.md` or `nested/CLAW.md`. The obsolete
`openclaw.claw` selector and JSON Template manifests are rejected, including in downloaded archives.
`CLAW.md` and `package.json` must contain valid UTF-8.
If inspection reports an encoding error, re-encode the source file as UTF-8 and retry;
Add refuses it before creating an agent or workspace.
Publishing and searching Templates through ClawHub use the separate registry
surface. The Control UI can browse official and community Templates from **Pages → Templates** at `/templates`
when **Templates** is enabled in **Settings → Labs**.

## Create with an agent

Ask the agent, “create a new template from this agent.” The bundled
`create-template` skill prepares a request-specific private draft and opens
review in that same conversation. No sidebar setup or special command is
required. The agent proposes portable behavior with an input, job, output, and
authority boundary; it does not publish, return a review link, or create or
fork a session. Review requires Templates enabled in Labs, an active administrator
Control UI connection, and a workspace on the Gateway host. If review is unavailable,
the proposal stays private.

The optional **Create Template** action in the agent's left-sidebar row menu
still invokes the same skill in that agent's existing main chat. Pinned agents
keep this action in a focused row menu.

The inline review card shows the exact archive files and declared skill, plugin,
MCP, and automation requirements. Open an item to inspect its contents, or use
**View all** to inspect the archive files. Review is read-only. To change a name,
description, file, or requirement, ask the agent to revise its private proposal
in the same conversation, then inspect the fresh review. The agent's display
name, ClawHub package slug, and authenticated publisher are separate identities.
The package includes only newly authored proposal contents; it does not copy the
source workspace, memories, or raw conversations. Known private paths and
credential-like text are rejected. Review the remaining text for personal facts
and private context.

Sign in with `clawhub login` on the Gateway host. **Publish** uploads the exact
reviewed artifact using that account. An agent turn cannot authorize publication.
The card stays in the conversation and shows **Pending** while ClawHub checks
the submission; **View submission** opens its ClawHub page. Once the registry
confirms publication, the card shows **Published** and offers **Copy link**.
Others can then discover the Template and Add it as an ordinary agent.

## Author locally

`openclaw templates draft <workspace> --json` initializes an empty private
proposal in that workspace and returns its unique `draftId` and path. It does
not copy source files, start a model turn, contact ClawHub, or publish. Each
invocation creates a distinct proposal; retain the returned ID instead of
searching for a latest draft. The bundled skill uses this command when a chat
request did not arrive with a UI-created draft.

Create a minimal project, validate its inputs, preview it without mutation,
and build an immutable package artifact:

```bash
openclaw templates create ./incident-triage
openclaw templates validate ./incident-triage
openclaw templates dev ./incident-triage
openclaw templates build ./incident-triage --out ./incident-triage-1.0.0.tgz
```

A package contains `package.json`, `CLAW.md`, and any files selected by its
manifest. `create` writes only `package.json` and `CLAW.md` and refuses to merge
into a nonempty directory. Project validation rejects package scripts and
lifecycle hooks. `dev` builds the same package artifact and checks its Add
requirements locally without installing packages, contacting ClawHub,
starting an agent turn, enabling automations, or changing OpenClaw state.
Requirements needing online preflight appear as blockers. `build` creates a
deterministic `.tgz` and refuses to overwrite an existing file.

`validate` and `build` accept a project-directory symlink and resolve the
canonical project root. Manifest confinement and managed source-file checks
remain unchanged.

For `create`, omit `--name` and `--agent-id` to use default identities. Explicitly
empty values are invalid and fail before project files are written.

A minimal `package.json` identifies the package and its manifest:

```json
{
  "name": "@acme/incident-triage-template",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "template": "CLAW.md" }
}
```

`CLAW.md` starts with YAML frontmatter. Its Markdown body becomes the new
agent's `SOUL.md`:

```md
---
schemaVersion: 1
agent:
  id: incident-triage
  name: Incident triage
categories: [operations, research]
workspace:
  bootstrapFiles: {}
skills: []
plugins: []
mcpServers: {}
automations: []
---

# Incident triage

Review incoming incidents, identify severity and ownership, and leave
a concise handoff with evidence.
```

`categories` is optional. Declare one to three distinct lowercase slugs for
catalog discovery; the receiving registry decides which category names it
accepts. Categories do not change the agent's runtime behavior.

`CLAW.md` is the sole configuration entry point. Put native agent settings
under `agent`, and dependencies in `skills` and `plugins`. Each entry selects
either a bundled package-relative folder with `path`, or an exact ClawHub release
with `ref` and `version`; do not combine those forms.
The retired `packages`, `profiles`, and `metadata.openclaw.config` declarations
are rejected with migration guidance. Remove the profile directory after moving
its supported settings into `agent`; retain `schemaVersion: 1`.

A package may add named bootstrap files and other workspace files from
package-relative sources. These go into the new agent's dedicated workspace:

```yaml
workspace:
  bootstrapFiles:
    AGENTS.md:
      source: workspace/AGENTS.md
  files:
    - source: workspace/reference/policy.md
      path: reference/policy.md
```

An optional package-root `BOOTSTRAP.md` supplies first-run instructions.
The package may also declare exact ClawHub skill and plugin requirements,
MCP servers, and scheduled automations:

```yaml
skills:
  - path: skills/incident-checklist
  - ref: incident-triage
    version: 1.0.0
plugins:
  - ref: "@acme/audit-plugin"
    version: 2.0.0
mcpServers:
  statuspage:
    command: npx
    args: ["--yes", "@acme/statuspage-mcp@1.0.0"]
    env:
      STATUSPAGE_TOKEN: "${STATUSPAGE_TOKEN}"
automations:
  - id: daily-summary
    name: Daily incident summary
    schedule: { cron: "0 9 * * *", timezone: UTC }
    session: main
    message: Summarize active incidents.
```

A bundled skill folder must contain a valid root `SKILL.md`. Add installs that
folder under the new agent's ordinary workspace `skills/` directory, using its
native skill identity. Supporting files are included automatically, including
binary assets. Declare only folders you intend to share; undeclared skill
folders are not installed or counted as dependencies. Bundled contents show their
name and package-relative path; they have no invented registry version or
standalone ClawHub verification claim.

Bundled skill and plugin folders use the same bounded selection: regular files
only, at most 1 MiB per file, 20 MiB across bundled dependencies, 4,096 entries
per folder, 4,096 selected bundled files in total, and 16 directory levels. `.git` and `node_modules` directories are
excluded regardless of case. Links, nonregular files, unsafe portable paths,
overlapping bundled directories, and conflicting skill identities or workspace
destinations are rejected. Build and Add reject changed source bytes or folder
membership after review. File modes follow ordinary Template packaging.

Use `automations` for scheduled work. The retired `cronJobs` key is rejected;
move its declarations to `automations` and remove `cronJobs`.

Add preserves each automation's required `session`: `main` runs in the new
agent's main conversation, while `isolated` runs in a separate session.
Declared automations start with no channel delivery; Add accepts but does not
apply `delivery`. To post a summary to a channel, configure delivery in the
automation's settings after Add. Previously added jobs keep their saved session
target; change those in the automation's settings if needed.

Environment values remain unresolved references; never package credentials.
Shared plugins and MCP servers must match existing declarations exactly or Add
reports the conflict without replacing them. Plugin and skill trust warnings
require explicit consent. Automations are assigned to the new agent.
If a declared plugin still needs setup, a referenced environment variable is
missing, or an OAuth MCP server is not authorized, Add creates the declared
automations paused. Their schedules, prompts, and imported scratch stay intact.
Connect the requirement through its ordinary plugin or MCP controls, then enable
the jobs through the agent's automation controls; Add does not create substitute
routines or automatically enable paused jobs later.

A package may declare `agent.heartbeat` in `CLAW.md` or include
`HEARTBEAT.md`. Add converts those inputs into ordinary interval automations
and private job scratch instead of installing heartbeat configuration. Legacy
`tasks:` entries become separate automations, and the remaining checklist stays
in the monitor's scratch. An `every: 0m` declaration stays disabled.
The Add review shows each converted job with its interval and owner delivery;
existing cron schedules keep their meaning.
Gateway review responses represent interval schedules as `{ everyMs }`, where
`everyMs` is a positive integer, and
owner delivery as `owner`, alongside the existing `{ cron, timezone }` schedules
and the `none` delivery of declared automations.

Add creates a job disabled until its imported scratch is saved and verified.
If scratch import conflicts with another edit, or its write cannot be confirmed,
Add reports a partial result and keeps the new agent and jobs for inspection.
Check their scratch and enabled state before retrying; Add does not overwrite
concurrent edits to make the import succeed.

Native settings under `agent` include `groupChat`, `sandbox`, `tools`,
`memory`, `heartbeat`, and `humanDelay`. The native `tools.profile` field
selects a built-in tool policy; its grants are bounded and frozen when Add
creates the agent. Host policy still constrains every grant. A Template cannot
set a model, provider, credentials, or named delegate agents.

```yaml
agent:
  id: incident-triage
  tools:
    profile: coding
    allow: [read, write]
    fs: { workspaceOnly: true }
  sandbox: { mode: all, workspaceAccess: ro }
  memory: { search: { enabled: false } }
```

Set `enabled: false` on an automation to install it paused; omitting the field
keeps the enabled default. Jobs belong to the new agent. First-run instructions
in `BOOTSTRAP.md` should find that agent's declared job, including disabled jobs,
and update its timezone, tools, or timeout through ordinary automation controls.
Enable that same job after setup and the user's activation choice; avoid creating
a duplicate job for the same recipe.

Package and workspace paths must stay inside the package root. Manifests are
limited to 1 MiB, package metadata to 256 KiB, and workspace files have
per-file and aggregate limits. Selected files become package content, so
review them for secrets before building or publishing.

<a id="inspect-and-preview"></a>

## Inspect and Add

Inspect a source before using it:

```bash
openclaw templates inspect ./incident-triage
```

Add it to create a new ordinary agent:

```bash
openclaw templates add ./incident-triage
```

Add a published ClawHub Template directly, or preview the same flow first:

```bash
openclaw templates add @openclaw/api-integration-engineer --dry-run --json
openclaw templates add @openclaw/api-integration-engineer
```

With a running Gateway, Add sends the ClawHub name to that Gateway for an exact
version review and installation. The Gateway chooses the new workspace;
`--workspace` is rejected instead of being ignored. Local paths still take
precedence over registry names and require the Gateway to be stopped.

Offline Add uses the same installer and local scheduler after acquiring exclusive
state ownership. Explicitly paused automations remain paused.

A registry name resolves the latest published release to an exact version and
immutable artifact digest before planning. OpenClaw uses its existing registry
trust checks, verifies the downloaded artifact, and safely extracts it under
bounded package limits. The extracted source is temporary and is cleaned up
after planning or Add; it is not an installed Template lifecycle. An existing
local path takes precedence over a registry name; use `./name` to make a local
source explicit.

Registry previews require network access but do not create an agent, workspace,
installed dependency, or retained Template source. Review the exact version,
digest, requirements, and trust warnings in `--dry-run --json` output. A warned
Template release requires `--acknowledge-clawhub-risk` when adding it. Template
approval never approves its skill or plugin dependencies: their existing trust
acknowledgments and `--accept-capabilities` checks still apply independently.

Each Add chooses an unused agent ID. The CLI reports that ID so you can open
or configure the agent afterward. The Control UI opens the new agent's pending
chat immediately. Sending becomes available when its instruction files, canonical
conversation, and active runtime are ready, while remaining setup continues. The
first assistant response is a normal personality/SOUL greeting, not a saved canned
greeting or a message sent on your behalf. Later setup failure retains the exposed
agent and conversation; completion does not replace an existing draft.

The installer shows a card for each newly installed plugin and an automation-created
notice as each routine is added. Paused routines stay paused until their setup
prerequisites are ready. Actual installation failures appear in the plugin card or
a concise automation-failed notice; continue setup in the same agent. Successful
skill and MCP setup, absent optional files, and empty categories stay silent. There
is no final setup receipt or second model recap. Declared package bootstrap still
follows shared setup; MCP configuration alone does not prove a working connection.

`--dry-run --json` remains available for automation or local-source inspection.
`--agent-id` selects an unused ID. `--workspace` selects a new path for local
preview or offline Add. Ordinary Add binds its review internally and does not
require a separate plan token. Trust warnings and plugin capabilities still
require their separate explicit acknowledgements.

For `add` and `dev`, an explicitly empty `--agent-id` is invalid. Omit the option
to use the default unused ID.

Gateway Add review responses describe schedules as either `{ cron, timezone }`
or `{ everyMs }`, where `everyMs` is a positive integer in milliseconds. Delivery
is `owner` for converted heartbeat jobs and `none` for declared automations.

CLI Add from a local source requires exclusive offline state ownership; it refuses
to run while a Gateway owns that state. For published ClawHub Templates, both the
CLI and Control UI can Add through a running Gateway. Offline Add uses the same
session, local agent runtime, and scheduler
owners without starting scheduled execution. `--json` suppresses conversational
terminal output but keeps the ordinary conversation and per-result install notices.

Add reuses matching shared dependencies, installs missing requirements, and
assigns the declared automations. An existing agent or workspace is never
overwritten. If Add fails before exposing the agent, newly created resources are
cleaned up where safe; preexisting resources remain untouched. If the result says
the agent was retained, continue in that agent and inspect the specific error
instead of adding another copy.

## Remove the agent

Deleting an agent added from a Template is the same as deleting any other agent:

```bash
openclaw agents delete incident-triage
```

The ordinary agent deletion flow removes the agent's dedicated workspace,
including its local instructions and skills, and automations assigned to that
agent. It also removes files or automations the user added later to that agent.
Shared plugins, MCP servers, and other host-level integrations remain installed;
remove them separately through their ordinary controls when no longer needed.
There is no Template ownership record or reverse-install operation.

## Command reference

| Command                              | Purpose                                           |
| ------------------------------------ | ------------------------------------------------- |
| `templates draft <workspace>`        | Initialize a private proposal without publishing. |
| `templates create [path]`            | Create a minimal local Template project.          |
| `templates validate [path]`          | Validate project inputs and package contents.     |
| `templates dev [path]`               | Build and preview locally without mutation.       |
| `templates build [path] --out <tgz>` | Build a deterministic package artifact.           |
| `templates inspect <source>`         | Inspect a canonical package or `CLAW.md`.         |
| `templates add <source>`             | Create a new agent and install its requirements.  |

Use `--json` for experimental machine-readable output. Validation errors,
blocked requirements, and failed additions exit `1`.
Gateway-owned Add reports the native `agentId`, `status`, and `readiness` result.
A partial result exits `1`. A lost Gateway reply reports an unknown outcome;
inspect the agent and its automations before retrying, since no local fallback
or automatic replay is attempted.

Human-readable reports sanitize terminal control characters in Template fields
and project paths. `--json` retains the original field values for machine processing.

## See also

- [Agents](/cli/agents)
- [Skills](/tools/skills)
- [Plugins](/tools/plugin)
- [Cron jobs](/automation/cron-jobs)
- [MCP configuration](/gateway/config-extensions#mcp)

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

The CLI accepts a local package directory, `CLAW.md`, or grouped JSON manifest.
JSON manifests, `package.json`, and OpenClaw YAML profiles must contain valid UTF-8.
If inspection reports an encoding error, re-encode the source file as UTF-8 and retry;
Add refuses it before creating an agent or workspace.
Publishing and searching Templates through ClawHub use the separate registry
surface. The Control UI can browse official and community Templates from **Pages → Templates** at `/templates`
when **Templates** is enabled in **Settings → Labs**.

## Create with an agent

With Templates enabled in Labs, choose **Create Template** from the agent's left-sidebar
row menu. Pinned agents keep this action in a focused row menu. The action sends
the bundled `$create-template` skill invocation into that agent's existing main
chat. The agent proposes portable behavior with an input, job, output, and
authority boundary, then writes its private draft in that conversation. When
the draft is ready, the Control UI opens a review modal; the agent does not
return a review link or create or fork a session. This flow currently requires
a workspace on the Gateway host.

The review modal shows the exact archive files and
declared skill, plugin, MCP, and automation requirements. The Name field is
the new agent's display name, defaulted to readable title case; it does not
change the package slug used as the Template's registry identity. Change the name
or description and uncheck any optional workspace file or requirement before
publishing. **Ask for changes** returns to the same chat; review the rebuilt
package after the agent revises the draft. The package includes only newly
authored proposal contents; it does not copy the source workspace, memories,
or raw conversations. Known private paths and credential-like text are
rejected. Review the remaining text for personal facts and private context.

Sign in with `clawhub login` on the Gateway host. **Publish to ClawHub** uploads
the exact reviewed artifact using that account; changing the selection
requires another review. The editable Name is the agent display name; the
ClawHub package slug and authenticated publisher are separate identities. An
agent turn cannot authorize publication. After submission, a dismissing
notification confirms that publication is pending security review and links
to the Template's ClawHub page.
After ClawHub makes it public, others can discover it and Add it as an ordinary agent.

## Author locally

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
packages: []
mcpServers: {}
cronJobs: []
---

# Incident triage

Review incoming incidents, identify severity and ownership, and leave
a concise handoff with evidence.
```

`categories` is optional. Declare one to three distinct lowercase slugs for
catalog discovery; the receiving registry decides which category names it
accepts. Categories do not change the agent's runtime behavior.

OpenClaw automatically discovers the optional `profiles/openclaw.yml` file.
No manifest pointer is required. Other harnesses may discover their own
conventional profile, such as `profiles/codex.yml`, without changing the
portable manifest.

The older `metadata.openclaw.config` pointer is deprecated but still read, so
packages published against it keep working. Reading one reports a
`deprecated_openclaw_profile_pointer` warning; move that file to
`profiles/openclaw.yml` and remove the metadata entry. A pointer that is not a
package-relative `.yml`/`.yaml` path is rejected, and a pointer that references
a different file while `profiles/openclaw.yml` also exists is rejected as a
conflict.

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
packages:
  - kind: skill
    source: clawhub
    ref: incident-triage
    version: 1.0.0
  - kind: plugin
    source: clawhub
    ref: "@acme/audit-plugin"
    version: 2.0.0
mcpServers:
  statuspage:
    command: npx
    args: ["--yes", "@acme/statuspage-mcp@1.0.0"]
    env:
      STATUSPAGE_TOKEN: "${STATUSPAGE_TOKEN}"
cronJobs:
  - id: daily-summary
    name: Daily incident summary
    schedule: { cron: "0 9 * * *", timezone: UTC }
    session: isolated
    message: Summarize active incidents.
```

Environment values remain unresolved references; never package credentials.
Shared plugins and MCP servers must match existing declarations exactly or Add
reports the conflict without replacing them. Plugin and skill trust warnings
require explicit consent. Automations are assigned to the new agent.

Older packages may declare `agent.heartbeat` in the OpenClaw profile or include
`HEARTBEAT.md`. Add converts those inputs into ordinary interval automations
and private job scratch instead of installing heartbeat configuration. Legacy
`tasks:` entries become separate automations, and the remaining checklist stays
in the monitor's scratch. An `every: 0m` declaration stays disabled.
The Add review shows each converted job with its interval and owner delivery;
existing cron schedules and `none` or last-channel delivery keep their meaning.
Gateway review responses represent interval schedules as `{ everyMs }`, where
`everyMs` is a positive integer, and
owner delivery as `owner`, alongside the existing `{ cron, timezone }` schedules
and `none` or `last-channel` delivery variants.

Add creates a job disabled until its imported scratch is saved and verified.
If scratch import conflicts with another edit, or its write cannot be confirmed,
Add reports a partial result and keeps the new agent and jobs for inspection.
Check their scratch and enabled state before retrying; Add does not overwrite
concurrent edits to make the import succeed.

OpenClaw discovers optional harness settings from `profiles/openclaw.yml`.
Those settings can refine the agent's tools, sandbox, memory search, and
extension requirements, but cannot set a model, provider, credentials, or
named delegate agents. Host policy still constrains every grant. Foreign
harness profiles are ignored by OpenClaw. A released older
`metadata.openclaw.config` profile pointer is still read with a deprecation
warning; new packages should use the conventional profile path.

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

Each Add chooses an unused agent ID. The CLI reports that ID so you can open
or configure the agent afterward. The Control UI opens the new agent's chat
and starts with "What can you do?" after a successful Add.

`--dry-run --json` remains available for automation or offline inspection.
`--agent-id` and `--workspace` override the default destination with an
unused ID or new path. Ordinary Add does not require a separate plan or
review token. Exceptional trust warnings can still require explicit consent.

Gateway Add review responses describe schedules as either `{ cron, timezone }`
or `{ everyMs }`, where `everyMs` is a positive integer in milliseconds. Delivery
values are `none`, `last-channel`, or `owner`.

Add reuses matching shared dependencies, installs missing requirements,
creates the agent and its workspace, and assigns its automations. An existing
agent or workspace is never overwritten. If Add fails, inspect the specific
error and retry after resolving it; newly created resources are cleaned up
where safe, while resources that existed before Add are left alone.

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

| Command                              | Purpose                                          |
| ------------------------------------ | ------------------------------------------------ |
| `templates create [path]`            | Create a minimal local Template project.         |
| `templates validate [path]`          | Validate project inputs and package contents.    |
| `templates dev [path]`               | Build and preview locally without mutation.      |
| `templates build [path] --out <tgz>` | Build a deterministic package artifact.          |
| `templates inspect <source>`         | Inspect a package or grouped manifest.           |
| `templates add <source>`             | Create a new agent and install its requirements. |

Use `--json` for experimental machine-readable output. Validation errors,
blocked requirements, and failed additions exit `1`.

Human-readable reports sanitize terminal control characters in Template fields
and project paths. `--json` retains the original field values for machine processing.

## See also

- [Agents](/cli/agents)
- [Skills](/tools/skills)
- [Plugins](/tools/plugin)
- [Cron jobs](/automation/cron-jobs)
- [MCP configuration](/gateway/config-extensions#mcp)

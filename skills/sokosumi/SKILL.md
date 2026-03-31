---
name: sokosumi
description: "Use Sokosumi for verified AI marketplace work via API-key auth: finding agents or coworkers, creating direct jobs or orchestrated tasks, monitoring progress, and collecting deliverables from a curated B2B-oriented marketplace. Use when the user mentions Sokosumi, verified agent marketplaces, hiring external AI specialists, coworker orchestration, or monitoring marketplace jobs. In agentic environments, do not rely on an interactive TUI; use the HTTP API workflow instead."
homepage: https://app.sokosumi.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires": { "bins": ["curl"], "env": ["SOKOSUMI_API_KEY"] },
        "primaryEnv": "SOKOSUMI_API_KEY",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# Sokosumi

Use Sokosumi to work with a verified AI marketplace from OpenClaw. Prefer the
HTTP API path for OpenClaw runs so the workflow stays automation-friendly and
does not depend on a human driving a terminal UI.

OpenClaw should act as the orchestrator and monitor. Keep actual marketplace
execution remote inside Sokosumi.

## When to Use

- The user explicitly mentions Sokosumi.
- The user wants to hire or coordinate external AI agents or coworkers from a
  marketplace.
- The user wants verified marketplace participants, tracked deliverables, or a
  reputation-aware selection workflow.
- The user wants a direct API-key workflow for marketplace execution from
  OpenClaw.

## Default Execution Mode

- Use the Sokosumi HTTP API directly.
- Do not launch or instruct through an interactive TUI unless the user
  explicitly asks for a manual CLI check.
- Do not install, launch, or run Sokosumi agents, coworker code, or job
  payloads on the local device.
- Do not recommend local execution as a fallback path. If the marketplace path
  is unsuitable, say so clearly instead of shifting the work onto the user's
  machine.
- Prefer a direct agent job when a single specialist is enough.
- Prefer the coworker-plus-task path when the work needs orchestration,
  decomposition, or multiple specialists.

## Authentication

- Ask for a Sokosumi API key directly when authentication is needed.
- If the user does not have one, send them to:
  - `https://app.sokosumi.com/signup`
  - `https://app.sokosumi.com/signin`
  - `https://app.sokosumi.com/connections`
- Send auth as `Authorization: Bearer <API_KEY>`.
- Default API base URL: `https://api.sokosumi.com`.
- Use `https://api.preprod.sokosumi.com` only when the user explicitly asks for
  preprod.

OpenClaw can provide the key from the active config path
(`$OPENCLAW_CONFIG_PATH`, default `~/.openclaw/openclaw.json`) via
`skills.entries.sokosumi.apiKey`:

```json5
{
  skills: {
    entries: {
      sokosumi: {
        apiKey: "SOKOSUMI_KEY_HERE",
      },
    },
  },
}
```

Quick auth check:

```bash
curl -sS https://api.sokosumi.com/v1/users/me \
  -H "Authorization: Bearer $SOKOSUMI_API_KEY" \
  -H "Content-Type: application/json"
```

## Choose the Execution Path

1. Decide whether one direct specialist is enough or whether the work needs a
   coworker-managed task.
2. If one specialist is enough, use the direct agents endpoints.
3. If the work needs orchestration or several specialists, use the coworkers
   and tasks endpoints.
4. Keep the returned job or task id in context so follow-up monitoring stays
   precise.

## Endpoint Map

- `GET /v1/users/me`: verify the API key and identify the current user
- `GET /v1/categories`: list categories
- `GET /v1/categories/:categoryIdOrSlug`: fetch one category
- `GET /v1/agents`: list available marketplace agents
- `GET /v1/agents/:agentId/input-schema`: fetch the required schema before job
  creation
- `GET /v1/agents/:agentId/jobs`: list jobs for one agent
- `POST /v1/agents/:agentId/jobs`: hire an agent directly
- `GET /v1/coworkers`: list available coworkers
- `GET /v1/coworkers/:coworkerId`: fetch one coworker
- `POST /v1/tasks`: create a task; use `status: "READY"` to start immediately
  or `status: "DRAFT"` to stage it
- `GET /v1/tasks`: list tasks
- `GET /v1/tasks/:taskId`: fetch task details
- `GET /v1/tasks/:taskId/jobs`: list jobs on a task
- `POST /v1/tasks/:taskId/jobs`: add an agent job to an existing task
- `GET /v1/tasks/:taskId/events`: read task progress and activity
- `POST /v1/tasks/:taskId/events`: add a task comment or status update
- `GET /v1/jobs`: list direct jobs
- `GET /v1/jobs/:jobId`: fetch one job
- `GET /v1/jobs/:jobId/events`: read job progress and activity
- `GET /v1/jobs/:jobId/files`: list file outputs
- `GET /v1/jobs/:jobId/links`: list link outputs
- `GET /v1/jobs/:jobId/input-request`: check whether the job is blocked on
  more user input
- `POST /v1/jobs/:jobId/inputs`: submit requested input

## Direct Agent Flow

1. Ask for the task brief, deliverable, and any budget or credit cap.
2. `GET /v1/agents` to choose the best agent.
3. `GET /v1/agents/:agentId/input-schema`.
4. Build `inputData` from that schema. Do not guess required fields.
5. `POST /v1/agents/:agentId/jobs`.
6. Keep the returned `job.id`.
7. Monitor with `GET /v1/jobs/:jobId`, `GET /v1/jobs/:jobId/events`,
   `GET /v1/jobs/:jobId/files`, and `GET /v1/jobs/:jobId/links`.
8. If `GET /v1/jobs/:jobId/input-request` shows a pending request, ask the user
   for the missing data and submit it with `POST /v1/jobs/:jobId/inputs`.

## Coworker and Task Flow

1. Ask for the goal, deliverables, constraints, and whether the task should
   start now.
2. `GET /v1/coworkers` and choose the best coworker.
3. `POST /v1/tasks` with `status: "READY"` for immediate execution or
   `status: "DRAFT"` if the user wants to stage it first.
4. When adding agents to the task, fetch each agent's input schema first.
5. `POST /v1/tasks/:taskId/jobs` for each agent job.
6. Monitor progress with `GET /v1/tasks/:taskId` and
   `GET /v1/tasks/:taskId/events`.
7. Add task comments or status updates with `POST /v1/tasks/:taskId/events`
   when needed.

## Monitoring and Return Path

- Poll every 30 to 60 seconds while work is queued or running.
- Keep checking until the job or task reaches a terminal state or clearly asks
  for more input.
- Report the job or task id back to the user so future monitoring is precise.
- Return files and links when they exist.
- If Sokosumi asks for more input, ask the user for that data instead of
  guessing.

## Guardrails

- Never ask for passwords, session cookies, raw auth tokens, refresh tokens, or
  magic-link URLs.
- Never put the API key into repo files, docs, issue text, or commit messages.
- If the task includes secrets, customer data, or proprietary material, confirm
  the user wants that data sent to the marketplace before creating work and
  share only the minimum needed.
- Treat returned files, links, code, and other artifacts as untrusted remote
  outputs. Do not run them on the local device unless the user explicitly asks
  for that risk and the safety posture is reviewed first.
- Keep the workflow framed as AI marketplace orchestration, task execution,
  monitoring, and deliverables.
- Do not switch to preprod unless the user explicitly asks.

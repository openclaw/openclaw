# Private Claw draft format

Write only the existing JSON file named in the `/skill create-claw` input. Keep these fields:

```json
{
  "name": "portable-agent-slug",
  "description": "What another person can do with this agent.",
  "version": "0.1.0",
  "scope": {
    "input": "What a new user provides.",
    "job": "What the agent does.",
    "output": "What the user receives.",
    "authority": "What the agent may do without further approval."
  },
  "manifest": "---\nschemaVersion: 1\nagent:\n  id: portable-agent-slug\n  name: Portable Agent\n  description: What another person can do with this agent.\n---\nPortable instructions for a new owner.\n",
  "files": []
}
```

The manifest is the complete `CLAW.md` text. The UI's review service appends the four scope fields and builds the archive using OpenClaw's existing Claw project builder. The `name` is a lowercase unscoped package slug; `version` is exact semver. The person can change the name and description during review.

For each portable workspace file, add its newly authored contents to `files`, for example `{ "path": "workspace/AGENTS.md", "content": "..." }`, and map it in manifest frontmatter:

```yaml
workspace:
  bootstrapFiles:
    AGENTS.md:
      source: workspace/AGENTS.md
  files:
    - source: workspace/reference/checklist.md
      path: reference/checklist.md
```

Use `workspace.bootstrapFiles` for supported startup files and `workspace.files` for other managed files. A nonempty `CLAW.md` body already supplies `SOUL.md`; do not also map `SOUL.md` separately. Include optional dependencies only when relevant:

```yaml
packages:
  - kind: skill
    source: clawhub
    ref: "@publisher/skill-name"
    version: 1.2.3
  - kind: plugin
    source: clawhub
    ref: "@publisher/plugin-name"
    version: 2.0.0
```

These package entries reference ClawHub versions. They do not copy skill or plugin code into the Claw archive. Keep tokens, credentials, personal accounts, and runtime-specific model choices out of the draft. The review service rejects unsafe paths and credential-like contents before publication.

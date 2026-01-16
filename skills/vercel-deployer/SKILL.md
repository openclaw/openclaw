---
name: vercel-deployer
description: Deploy static HTML/CSS pages to Vercel when the user asks for a landing page, report, or shareable website link.
---

# Vercel Deployer

Generate HTML content and deploy it immediately to Vercel using the opie.website domain.

## Capabilities

- Create & deploy: takes HTML content, creates a local project folder, and deploys it to Vercel.
- Alias: attempts to assign a subdomain (e.g., `project-name.opie.website`).
- Update: can overwrite existing projects if the project name matches an existing one.

## Usage Instructions for the Agent

When a user asks for a website or visual:

1. Generate the full HTML/CSS/JS content.
2. Determine a URL-safe `project_slug` (e.g., `q1-sales-report`).
3. Call the `scripts/deploy.py` script with the content and slug.
4. Return the final URL to the user.

## Requirements

- The Vercel CLI must be installed on the host machine (`npm i -g vercel`).
- `VERCEL_TOKEN` must be set in the Clawdbot configuration or system environment.
- `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are managed automatically by the script.
- `VERCEL_SCOPE` (team ID) can be set via env var if needed.

## Script Usage

Run the python script located in this skill's `scripts/` directory.

```bash
python3 scripts/deploy.py --name "my-page-name" --content "<html>...</html>"
```

## Tips

- Validate the JSON output to confirm the deployment succeeded.
- If aliasing fails, provide the fallback `*.vercel.app` URL.

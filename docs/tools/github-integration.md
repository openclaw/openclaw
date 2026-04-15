---
summary: "Connect OpenClaw to GitHub for repository management, pull requests, and commits using MCP and the native GitHub skill"
read_when:
  - You want to manage GitHub repositories from OpenClaw
  - You need to create pull requests or commits via the agent
  - You are setting up the GitHub MCP server
title: "GitHub Integration"
---

# GitHub Integration

OpenClaw can interact with GitHub to manage repositories, pull requests, issues, and commits. The primary and recommended method is using the **GitHub MCP Server**, which provides a rich set of agent tools. For users who prefer a CLI-based workflow, the **GitHub Skill** is also available as an optional alternative.

<Note>
This guide covers how to set up GitHub access so your agent can perform source control tasks on your behalf.
</Note>

## Phase 1: Obtain a GitHub Token

To get started, you need a GitHub Personal Access Token (PAT).

1.  Visit your [GitHub Token Settings](https://github.com/settings/tokens).
2.  Generate a new token (Classic or Fine-grained).
3.  Select the following scopes:
    *   `repo` (full control of private repositories)
    *   `workflow` (required if managing GitHub Actions)
    *   `user` (to read user profile data)
4.  Copy and save your token securely.

---

## Phase 2: Secure Configuration

OpenClaw supports multiple ways to store your GitHub token. We recommend using **SecretRef** for better security.

### Option A: SecretRef (Recommended)

SecretRef avoids storing your raw token in the `openclaw.json` config file.

1.  Add your token to your environment or a secure store as `GITHUB_TOKEN`.
2.  Reference it in your OpenClaw configuration:

```bash
openclaw config set "secrets.github_token" --secret-input-mode ref
```

### Option B: Environment Variable (Faster for Local)

For a quick local setup, you can export the token directly in your shell:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN="your_token_here"
```

---

## Phase 3: Enable the GitHub MCP Server

The **GitHub MCP Server** (`@modelcontextprotocol/server-github`) is the primary way to expose GitHub tools to your agent.

1.  **Add the server to OpenClaw:**

```bash
openclaw mcp set github '{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
  }
}'
```

<Note>
If you used Option B in Phase 2, ensure the `env` key matches your environment variable name.
</Note>

2.  **Verify the installation:**

```bash
openclaw mcp list
```

You should see `github` in the list with a set of tools (e.g., `create_repository`, `create_pull_request`).

---

## Phase 4: Practical Usage Examples

Once the server is enabled, you can instruct your agent to perform GitHub tasks using natural language:

### Repository Management
*   *"Create a new repository named 'my-awesome-project' on my GitHub account."*
*   *"List all my repositories that contain the word 'claw'."*

### Pull Requests & Issues
*   *"Create a pull request from the 'branch-v2' to 'main' with the title 'Feature Update'."*
*   *"Summarize the last 5 issues in the openclaw/openclaw repository."*

### Commits & Files
*   *"Commit the current changes in this directory to GitHub with the message 'Fixed layout styling'."*
*   *"Get the content of README.md from the 'production' branch of owner/repo."*

---

## Phase 5: Optional Alternative (GitHub Skill)

If you already use the [GitHub CLI (`gh`)](https://cli.github.com/) and prefer a CLI-based workflow, you can enable the native **GitHub Skill**.

1.  **Enable the skill:**

```bash
openclaw skills install github
```

2.  **Verify readiness:**

```bash
openclaw skills info github
```

The GitHub skill allows the agent to run `gh` commands directly. It is particularly useful for tasks like checking CI runs (`gh run list`) or advanced API queries (`gh api`).

<Tip>
The GitHub MCP server is generally preferred for agentic workflows because it provides structured tools that the agent can reason about more effectively than raw CLI output.
</Tip>

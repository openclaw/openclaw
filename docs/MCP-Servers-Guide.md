<!-- markdownlint-disable MD060 -->

# MCP Servers Guide

## Claude Code + OpenClaw Compatible

> Config location: `~/.claude.json` (user scope)
> OpenClaw config: `openclaw.json` (same MCP format)
> Last updated: 2026-02-20

---

## ALREADY INSTALLED (23 servers)

### With API Key

| #   | Name       | Package                     | Status           | Key                  |
| --- | ---------- | --------------------------- | ---------------- | -------------------- |
| 1   | perplexity | `@perplexity-ai/mcp-server` | INSTALLED        | `PERPLEXITY_API_KEY` |
| 2   | gemini     | _(user configured)_         | TO INSTALL LATER | `GEMINI_API_KEY`     |
| 3   | openai     | _(user configured)_         | TO INSTALL LATER | `OPENAI_API_KEY`     |

### Free (No API Key)

| #   | Name                | Package                                            | What It Does                               |
| --- | ------------------- | -------------------------------------------------- | ------------------------------------------ |
| 1   | memory              | `@modelcontextprotocol/server-memory`              | Persistent knowledge graph across sessions |
| 2   | sequential-thinking | `@modelcontextprotocol/server-sequential-thinking` | Step-by-step complex reasoning             |
| 3   | duckduckgo          | `@qwang07/duck-duck-mcp`                           | Free privacy-friendly web search           |
| 4   | docs-fetcher        | `@cdugo/docs-fetcher-mcp`                          | Fetch library docs (JS, Python, Java)      |
| 5   | git                 | `@modelcontextprotocol/server-git`                 | Read, search, manipulate git repos         |
| 6   | time                | `@modelcontextprotocol/server-time`                | Timezone conversions                       |
| 7   | fetch               | `@modelcontextprotocol/server-fetch`               | Fetch & convert web content                |
| 8   | mermaid             | `@narasimhaponnada/mermaid-mcp-server`             | Generate 22+ diagram types                 |
| 9   | arxiv               | `arxiv-mcp-server`                                 | Search & analyze research papers           |
| 10  | filesystem          | `@modelcontextprotocol/server-filesystem`          | Secure file ops on ~/Users/tg              |
| 11  | puppeteer           | `@modelcontextprotocol/server-puppeteer`           | Browser automation & screenshots           |
| 12  | sqlite              | `@berthojoris/mcp-sqlite-server`                   | SQLite database operations                 |
| 13  | kubernetes          | `mcp-server-kubernetes`                            | K8s cluster management                     |
| 14  | notifications       | `mcp-notifications`                                | macOS desktop notifications                |
| 15  | markitdown          | `markitdown-mcp-npx`                               | Convert PDF/Word/Excel/images to markdown  |
| 16  | excel               | `@negokaz/excel-mcp-server`                        | Read/write Excel & CSV files               |
| 17  | apple-shortcuts     | `mcp-server-apple-shortcuts`                       | Trigger macOS Shortcuts automations        |
| 18  | xcodebuild          | `xcodebuildmcp`                                    | Build iOS/macOS Xcode projects             |
| 19  | npm-docs            | `@bsmi021/mcp-npm_docs-server`                     | NPM package docs & metadata                |
| 20  | dns                 | `@cenemiljezweb/dns-mcp-server`                    | DNS lookups & network diagnostics          |
| 21  | whois               | `@domaindetails/whois-mcp`                         | Domain WHOIS lookups (877+ TLDs)           |
| 22  | screenshot          | `universal-screenshot-mcp`                         | Web & system screenshots                   |

---

## TO INSTALL - API KEY REQUIRED

These are the must-have MCP servers that need API keys. They work on both Claude Code and OpenClaw.

### Search & Research

| Name         | Package                              | API Key Needed   | What It Does                          | Get Key                         |
| ------------ | ------------------------------------ | ---------------- | ------------------------------------- | ------------------------------- |
| Brave Search | `@anthropic/brave-search-mcp-server` | `BRAVE_API_KEY`  | Web + local search, privacy-focused   | <https://brave.com/search/api/> |
| Exa          | `exa-mcp-server`                     | `EXA_API_KEY`    | Semantic search, find similar content | <https://exa.ai/>               |
| Tavily       | `tavily-mcp`                         | `TAVILY_API_KEY` | AI-optimized web search for agents    | <https://tavily.com/>           |

**Install commands:**

```bash
claude mcp add brave-search -s user -- npx -y @anthropic/brave-search-mcp-server -e BRAVE_API_KEY=your-key
claude mcp add exa -s user -- npx -y exa-mcp-server -e EXA_API_KEY=your-key
claude mcp add tavily -s user -- npx -y tavily-mcp -e TAVILY_API_KEY=your-key
```

### Web Scraping & Content

| Name        | Package                      | API Key Needed      | What It Does                                           | Get Key                  |
| ----------- | ---------------------------- | ------------------- | ------------------------------------------------------ | ------------------------ |
| Firecrawl   | `firecrawl-mcp`              | `FIRECRAWL_API_KEY` | Scrape websites to clean markdown, JS rendering, batch | <https://firecrawl.dev/> |
| Jina Reader | `@anthropic/jina-reader-mcp` | `JINA_AI_API_KEY`   | Convert any URL to clean formatted text                | <https://jina.ai/>       |

**Install commands:**

```bash
claude mcp add firecrawl -s user -- npx -y firecrawl-mcp -e FIRECRAWL_API_KEY=your-key
claude mcp add jina -s user -- npx -y @anthropic/jina-reader-mcp -e JINA_AI_API_KEY=your-key
```

### Productivity & Integrations

| Name   | Package                        | API Key Needed    | What It Does                               | Get Key                                 |
| ------ | ------------------------------ | ----------------- | ------------------------------------------ | --------------------------------------- |
| Notion | `@anthropic/notion-mcp-server` | `NOTION_API_KEY`  | Read/write Notion pages, databases, tasks  | <https://www.notion.so/my-integrations> |
| Slack  | `@anthropic/slack-mcp-server`  | `SLACK_BOT_TOKEN` | Send/read Slack messages, search channels  | <https://api.slack.com/apps>            |
| Linear | `@anthropic/linear-mcp-server` | `LINEAR_API_KEY`  | Issue tracking, project management         | <https://linear.app/settings/api>       |
| GitHub | `@anthropic/github-mcp-server` | `GITHUB_TOKEN`    | Full GitHub API: PRs, issues, CI/CD, repos | <https://github.com/settings/tokens>    |

**Install commands:**

```bash
claude mcp add notion -s user -- npx -y @anthropic/notion-mcp-server -e NOTION_API_KEY=your-key
claude mcp add slack -s user -- npx -y @anthropic/slack-mcp-server -e SLACK_BOT_TOKEN=your-token
claude mcp add linear -s user -- npx -y @anthropic/linear-mcp-server -e LINEAR_API_KEY=your-key
claude mcp add github -s user -- npx -y @anthropic/github-mcp-server -e GITHUB_TOKEN=your-token
```

### Cloud & Infrastructure

| Name     | Package                          | API Key Needed          | What It Does                        | Get Key                                         |
| -------- | -------------------------------- | ----------------------- | ----------------------------------- | ----------------------------------------------- |
| Supabase | `@anthropic/supabase-mcp-server` | `SUPABASE_ACCESS_TOKEN` | Postgres, auth, storage, 20+ tools  | <https://supabase.com/dashboard/account/tokens> |
| AWS      | `aws-mcp`                        | AWS credentials         | EC2, S3, IAM, CloudWatch management | <https://console.aws.amazon.com/iam>            |

**Install commands:**

```bash
claude mcp add supabase -s user -- npx -y @anthropic/supabase-mcp-server -e SUPABASE_ACCESS_TOKEN=your-token
claude mcp add aws -s user -- npx -y aws-mcp -e AWS_ACCESS_KEY_ID=your-key -e AWS_SECRET_ACCESS_KEY=your-secret
```

### Design & Frontend

| Name  | Package                       | API Key Needed    | What It Does                         | Get Key                                |
| ----- | ----------------------------- | ----------------- | ------------------------------------ | -------------------------------------- |
| Figma | `@anthropic/figma-mcp-server` | `FIGMA_API_TOKEN` | Read Figma designs, generate UI code | <https://www.figma.com/developers/api> |

**Install commands:**

```bash
claude mcp add figma -s user -- npx -y @anthropic/figma-mcp-server -e FIGMA_API_TOKEN=your-token
```

### LLM Providers

| Name       | Package                     | API Key Needed       | What It Does                  | Get Key                                  |
| ---------- | --------------------------- | -------------------- | ----------------------------- | ---------------------------------------- |
| Gemini     | _(varies)_                  | `GEMINI_API_KEY`     | Google Gemini models          | <https://aistudio.google.com/apikey>     |
| OpenAI     | _(varies)_                  | `OPENAI_API_KEY`     | GPT models                    | <https://platform.openai.com/api-keys>   |
| Perplexity | `@perplexity-ai/mcp-server` | `PERPLEXITY_API_KEY` | AI search (ALREADY INSTALLED) | <https://www.perplexity.ai/settings/api> |

### All-In-One Search (combines multiple providers)

| Name       | Package          | API Key Needed                                                                                                               | What It Does                                                                        |
| ---------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Omnisearch | `mcp-omnisearch` | Any combo of: `TAVILY_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, `JINA_AI_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY` | Unified search across all providers. Only enables providers whose keys you provide. |

**Install command:**

```bash
claude mcp add omnisearch -s user -- npx -y mcp-omnisearch \
  -e BRAVE_API_KEY=your-key \
  -e TAVILY_API_KEY=your-key \
  -e EXA_API_KEY=your-key \
  -e JINA_AI_API_KEY=your-key \
  -e FIRECRAWL_API_KEY=your-key
```

---

## OpenClaw Configuration

All the same MCP servers work in OpenClaw. Add them to your `openclaw.json`:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@package/name"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

OpenClaw uses the exact same MCP format as Claude Code — copy servers between them freely.

---

## Quick Reference

**Manage servers:**

```bash
claude mcp list                # List all servers
claude mcp get <name>          # Show server details
claude mcp remove <name>       # Remove a server
```

**Check status inside Claude Code:**

```
/mcp
```

**Config file location:**

```
~/.claude.json
```

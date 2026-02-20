<p align="center">
  <img src="resources/home-screen.png" alt="Mission Control Dashboard — AI Agent Management Interface" width="100%" />
</p>

<h1 align="center">// MISSION CONTROL</h1>

<p align="center">
  <strong>A real-time dashboard to manage, monitor, and orchestrate your AI agents</strong>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#%EF%B8%8F-setup">Setup</a> •
  <a href="#-tech-stack">Tech Stack</a> •
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/React-19-blue?logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-38B2AC?logo=tailwind-css" alt="Tailwind CSS 4" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
</p>

---

**Mission Control** is an open-source, real-time command-center dashboard for [OpenClaw](https://github.com/openclaw/openclaw) — the open-source AI agent framework. It gives you a visual interface to create tasks, dispatch them to AI agents, monitor agent activity, and track progress through a Kanban-style workflow.

Think of it as **your personal AI operations center** — a single pane of glass for everything your AI agents are doing.

---

## Quick Start

Run Mission Control instantly with a single command — no cloning required:

```bash
npx openclaw-dashboard
```

The interactive setup wizard will ask for:

| Prompt          | Default                | Description                                   |
| --------------- | ---------------------- | --------------------------------------------- |
| **Gateway URL** | `ws://127.0.0.1:18789` | Your OpenClaw gateway WebSocket address       |
| **Auth Token**  | —                      | Authentication token from your gateway config |
| **Port**        | `3000`                 | Port to serve the dashboard on                |

Once configured, Mission Control starts in **under 1 second** and opens at `http://localhost:3000`.

---

## Features

### Kanban Task Board

Organize AI agent work across five workflow stages with drag-and-drop:

- **Inbox** -> **Assigned** -> **In Progress** -> **Review** -> **Done**
- Create tasks with priority levels (Low, Medium, High, Urgent)
- Drag tasks between columns to update status
- Task cards show assigned agent, priority badge, and time elapsed

### Agent Monitoring

- Real-time agent status (Online / Offline / Busy)
- View connected agents with model info and capabilities
- Dispatch tasks directly to specific agents
- Track which agent is working on what

### Live Terminal

- Floating, collapsible terminal panel (slides from right)
- Real-time activity feed with color-coded entries
- Timestamps for every event (task created, agent assigned, status changes)
- Toggle visibility with the terminal button in the header

### Mission Management

- Group related tasks into missions
- Track mission progress and completion status
- Organize complex multi-task workflows

### Dark & Light Mode

- Beautiful dark mode with glassmorphism effects (default)
- Clean light mode with proper contrast
- One-click toggle in the header

### Real-Time Sync

- WebSocket connection to OpenClaw gateway
- Live status indicator (System Online / Offline)
- Auto-reconnection on connection loss
- Instant UI updates when agents complete work

### Plugin Ecosystem Integration

- Plugin Registry view showing all 26+ installed Claude Code plugins
- ~400+ skills from local plugins spanning business, engineering, AI/ML, security, DevOps, and more
- 7 MCP server integrations (Atlassian, Figma, GitLab, Greptile, Laravel, Linear)
- 11 AI Specialists (6 engineering + 5 business/leadership)
- Browse plugins organized by category with full skill and agent listings

### API Key Management

- Add, remove, and toggle API keys for 11+ AI providers
- Supported providers: OpenAI, Anthropic, Google Gemini, Groq, Mistral, OpenRouter, xAI, Hugging Face, Cerebras, Amazon Bedrock, Azure OpenAI
- One-click connection testing to verify key validity
- Instant enable/disable toggling per provider

### Local Model Management

- Ollama integration for locally-running models
- Auto-detect available Ollama models on the host machine
- Register, configure, and monitor local models from the dashboard
- Custom base URL support for self-hosted providers

### New Views

- **Plugin Registry** (`#plugins`) — Browse all installed plugins organized by category, with skill counts and agent listings
- Enhanced **Skills Dashboard** (`#skills`) — Unified view of gateway + plugin skills across all categories
- Enhanced **Settings** (`#settings`) — Now includes API key management and local model configuration sections
- Enhanced **All Tools** (`#all-tools`) — Complete ecosystem directory combining gateway tools, plugin skills, MCP servers, and AI specialists

---

## What People Build with OpenClaw

OpenClaw is one of the fastest-growing open-source AI agent frameworks. Here's what the community is using it for:

### Developer & DevOps Workflows

- **Automated debugging** — Agents that triage errors, find root causes, and suggest fixes
- **CI/CD orchestration** — Cron-triggered agents that run builds, tests, and deployments
- **Codebase management** — Agents that refactor, audit, and document code autonomously
- **GitHub automation** — Auto-review PRs, manage issues, and enforce coding standards

### Research & Analysis

- **Multi-source research** — Agents that synthesize information from docs, APIs, and the web
- **Data extraction** — Automated web scraping and data transformation pipelines
- **Competitive analysis** — Agents that monitor industry changes and produce reports

### Business Operations

- **Email & calendar management** — Agents that draft responses, schedule meetings, and prioritize inbox
- **Customer support** — Autonomous agents that handle support queries via Telegram, Slack, or Discord
- **Financial analysis** — Agents that process invoices, track expenses, and generate forecasts
- **Legal document processing** — Automated contract review and compliance checking

### Personal Productivity

- **Task management** — Agents integrated with Notion, Obsidian, Things 3, and Apple Reminders
- **Smart home automation** — Agents that control IoT devices based on context
- **Health monitoring** — Agents that track habits and provide insights

### Platform Integrations

- Accessible from **Telegram, WhatsApp, Slack, Discord, and iMessage**
- 5,700+ community-built skills on **ClawHub** (the public skill registry)
- Model-agnostic — works with GPT, Claude, Gemini, DeepSeek, or local models via Ollama

> **Mission Control** is how you manage all of this from a single dashboard — monitoring long-running agents, dispatching tasks, reviewing results, and orchestrating complex multi-agent workflows.

---

## Setup

### Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **OpenClaw Gateway** running locally or remotely ([setup guide](https://github.com/openclaw/openclaw))

### Option 1: npx (Recommended)

```bash
npx openclaw-dashboard
```

No installation required. The wizard handles everything.

### Option 2: Clone & Run

```bash
# Clone the repository
git clone https://github.com/openclaw/openclaw.git
cd openclaw/mission-control

# Install dependencies
npm install

# Configure environment
cp .env.example .env.local
```

Edit `.env.local` with your settings:

```env
# OpenClaw Gateway
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_AUTH_TOKEN=your_auth_token_here
```

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Option 3: Production Build

```bash
npm run build
npm start
```

The production build uses Next.js standalone output for minimal footprint and fast startup (~35ms).

---

## Configuration

| Environment Variable   | Required | Default                | Description                                |
| ---------------------- | -------- | ---------------------- | ------------------------------------------ |
| `OPENCLAW_GATEWAY_URL` | No       | `ws://127.0.0.1:18789` | WebSocket URL of your OpenClaw gateway     |
| `OPENCLAW_AUTH_TOKEN`  | Yes      | —                      | Auth token from your gateway's config file |
| `MISSION_CONTROL_API_KEY` | No    | —                      | API bearer key for protecting Mission Control API routes |
| `MISSION_CONTROL_USE_GATEWAY_TOKEN_FOR_API_AUTH` | No | `false` | When `true`, reuse `OPENCLAW_AUTH_TOKEN` as API key if `MISSION_CONTROL_API_KEY` is unset |
| `MISSION_CONTROL_CSRF_PROTECTION` | No | `false` | Enables CSRF checks on mutating API routes |
| `PORT`                 | No       | `3000`                 | Port number for the dashboard              |

### Finding Your Auth Token

Your OpenClaw auth token is in your gateway configuration file (usually `~/.clawdbot/clawdbot.json`):

```json
{
  "auth_token": "your_token_here"
}
```

---

## Tech Stack

| Technology                                      | Purpose                                         |
| ----------------------------------------------- | ----------------------------------------------- |
| [Next.js 16](https://nextjs.org/)               | Full-stack React framework with App Router      |
| [React 19](https://react.dev/)                  | UI components with React Compiler               |
| [TypeScript 5](https://www.typescriptlang.org/) | Type-safe development                           |
| [Tailwind CSS 4](https://tailwindcss.com/)      | Utility-first styling                           |
| [Radix UI](https://www.radix-ui.com/)           | Accessible, unstyled UI primitives              |
| [shadcn/ui](https://ui.shadcn.com/)             | Pre-built component library                     |
| [SQLite](https://www.sqlite.org/)               | Lightweight local database (via better-sqlite3) |
| [dnd-kit](https://dndkit.com/)                  | Drag-and-drop for Kanban board                  |
| [Lucide Icons](https://lucide.dev/)             | Beautiful icon set                              |

### Project Structure

```
mission-control/
├── bin/
│   └── cli.mjs              # npx entry point & setup wizard
├── src/
│   ├── app/
│   │   ├── page.tsx          # Main dashboard (Kanban, Agents, Missions)
│   │   ├── globals.css       # Design tokens & theme variables
│   │   └── api/
│   │       ├── tasks/        # CRUD + dispatch + comments
│   │       ├── agents/       # Agent listing from gateway
│   │       ├── missions/     # Mission management
│   │       ├── activity/     # Activity log feed
│   │       ├── plugins/      # Plugin catalog API
│   │       ├── settings/
│   │       │   ├── api-keys/ # API key management
│   │       │   └── models/   # Local model management
│   │       └── openclaw/     # Gateway status endpoint
│   ├── components/           # Reusable UI components (shadcn)
│   └── lib/
│       ├── db.ts             # SQLite database & schema
│       ├── openclaw-client.ts # WebSocket client for gateway
│       └── plugin-scanner.ts # Plugin directory scanner
├── data/                     # SQLite database (auto-created)
└── public/                   # Static assets
```

---

## API Reference

Mission Control exposes 52+ REST API endpoints. Key routes:

| Method     | Endpoint                          | Description                                |
| ---------- | --------------------------------- | ------------------------------------------ |
| `GET`      | `/api/tasks`                      | List tasks (filter by status, agent, etc.) |
| `POST`     | `/api/tasks`                      | Create a new task                          |
| `PATCH`    | `/api/tasks`                      | Update task fields                         |
| `POST`     | `/api/tasks/dispatch`             | Dispatch task to an AI agent               |
| `POST`     | `/api/tasks/rework`               | Re-dispatch a task                         |
| `GET/POST` | `/api/tasks/comments`             | List or add task comments                  |
| `GET`      | `/api/agents`                     | List connected agents from gateway         |
| `*`        | `/api/agents/specialists/*`       | AI specialist CRUD, recommendations        |
| `GET/POST` | `/api/missions`                   | Mission CRUD                               |
| `GET/POST` | `/api/employees`                  | Employee CRUD                              |
| `*`        | `/api/employees/access`           | Employee account access control            |
| `GET`      | `/api/employees/hierarchy`        | Org chart hierarchy                        |
| `POST`     | `/api/chat`                       | Agent conversation                         |
| `*`        | `/api/chat/sessions`              | Chat session management                    |
| `*`        | `/api/chat/council`               | Multi-agent council chat                   |
| `*`        | `/api/profiles`                   | User profile management                    |
| `*`        | `/api/workspaces`                 | Workspace CRUD                             |
| `*`        | `/api/accounts`                   | Account management                         |
| `GET`      | `/api/search`                     | Global search                              |
| `GET`      | `/api/openclaw/status`            | Gateway connection status                  |
| `POST`     | `/api/orchestrator`               | Dispatch parallel tasks                    |
| `GET`      | `/api/activity`                   | Activity log feed                          |
| `GET`      | `/api/auth/session`               | Auth session                               |
| `GET`      | `/api/csrf-token`                 | CSRF token                                 |
| `GET`      | `/api/plugins`                    | Plugin catalog with skills, agents, and MCP servers |
| `GET`      | `/api/settings/api-keys`          | List all configured API keys               |
| `POST`     | `/api/settings/api-keys`          | Add a new API key                          |
| `PATCH`    | `/api/settings/api-keys`          | Update/toggle an API key                   |
| `DELETE`   | `/api/settings/api-keys`          | Remove an API key                          |
| `GET`      | `/api/settings/models`            | List registered local models               |
| `POST`     | `/api/settings/models`            | Register a new local model                 |
| `PATCH`    | `/api/settings/models`            | Update local model configuration           |
| `DELETE`   | `/api/settings/models`            | Remove a local model                       |

Full endpoint map: see [DIRECTORY.md](./DIRECTORY.md#-api-endpoint-map)

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/your-username/openclaw.git`
3. **Create a branch**: `git checkout -b feature/your-feature`
4. **Make changes** and test locally
5. **Submit a Pull Request**

### Development

```bash
# Install dependencies
npm install

# Start dev server with hot-reload
npm run dev

# Run linter
npm run lint

# Production build
npm run build
```

---

## License

This project is licensed under the [MIT License](../LICENSE).

---

## Links

- [OpenClaw Framework](https://github.com/openclaw/openclaw) — The AI agent framework
- [OpenClaw Website](https://openclaw.ai/) — Official website
- [Report a Bug](https://github.com/openclaw/openclaw/issues) — Found an issue? Let us know
- [Request a Feature](https://github.com/openclaw/openclaw/issues) — Have an idea? We'd love to hear it

---

<p align="center">
  Built with care for the AI agent community
</p>

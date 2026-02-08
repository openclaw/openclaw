# Recoder Plugin for OpenClaw

Enable OpenClaw agents (WhatsApp, Telegram, Discord, etc.) to create and manage coding projects via Recoder.xyz.

## Features

- 🏗️ **Project Management** — Create, list, and delete projects
- 🤖 **AI Code Generation** — Generate code via natural language
- 🐳 **Docker Sandboxes** — Spin up containerized development environments
- 📁 **File Operations** — Read, write, and manage project files
- 💻 **Shell Commands** — Execute commands in sandboxes
- 🔗 **Live Preview** — Get instant preview URLs for your apps

## Installation

```bash
# Install via ClawHub
clawhub install recoder

# Or add to your openclaw.plugins.json
{
  "plugins": ["recoder"]
}
```

## Setup

Run the setup wizard to configure credentials:

```bash
openclaw recoder:setup
```

This will prompt you for:
- Recoder web URL (default: https://web.recoder.xyz)
- Docker backend URL (default: https://docker.recoder.xyz)
- API URL (default: https://api.recoder.xyz)
- API key (optional — auto-provisioned for each user)

## Tools

### recoder_project

Create and manage projects.

```
Create a new React project called "my-app"
List my projects
Delete project abc123
```

### recoder_code

Generate code using AI.

```
Build a counter app with a button that increments
Add a dark mode toggle to the header
Refactor the API calls to use React Query
```

### recoder_sandbox

Manage Docker containers.

```
Start a container for project abc123
Stop all my containers
Get container status
```

### recoder_files

Read and write files.

```
Show me src/App.tsx
Create a new file at src/utils/helpers.ts
Delete the old config file
```

### recoder_shell

Execute commands in containers.

```
Run npm install axios
Build the project
Check the logs
```

### recoder_preview

Get preview URLs.

```
Show me the preview URL
Open the app preview
```

## API Key Management

API keys are managed automatically:

1. **Auto-provisioning** — Each OpenClaw user gets a unique API key on first use
2. **Secure storage** — Keys stored at `~/.openclaw/credentials/recoder-api-keys.json`
3. **Session injection** — Keys automatically injected into tool calls
4. **Cache validation** — Keys verified on each session start

### Manual Configuration

Set a shared API key in the plugin config:

```json
{
  "name": "recoder",
  "config": {
    "apiKey": "sk_xxx..."
  }
}
```

See [Agent API Key Flows](../../docs/docs/AGENT-API-KEY-FLOWS.md) for detailed documentation.

## Usage Examples

### WhatsApp Conversation

```
You: Build me a todo app

Bot: 🚀 Creating your project...
     ✅ Project created: todo-app
     📦 Installing dependencies...
     🎨 Generating UI components...
     
     Preview: https://sandbox-abc123.recoder.xyz
     
You: Add a dark mode

Bot: 🌙 Adding dark mode toggle...
     ✅ Updated src/App.tsx
     ✅ Added src/styles/dark-mode.css
     
     Preview updated!
```

### Telegram Bot

```
/recoder new project portfolio-site
/recoder code Add a hero section with animated gradient background
/recoder preview
```

## Configuration

### Environment Variables

```bash
RECODER_WEB_URL=https://web.recoder.xyz
RECODER_DOCKER_URL=https://docker.recoder.xyz
RECODER_API_URL=https://api.recoder.xyz
RECODER_API_KEY=sk_xxx...
```

### Plugin Config

```json
// openclaw.plugin.json
{
  "name": "recoder",
  "version": "1.0.0",
  "main": "index.ts",
  "config": {
    "webUrl": "https://web.recoder.xyz",
    "dockerUrl": "https://docker.recoder.xyz",
    "apiUrl": "https://api.recoder.xyz",
    "apiKey": null,
    "defaultFramework": "react",
    "autoStartSandbox": true
  }
}
```

## Development

```bash
# Install dependencies
pnpm install

# Build the plugin
pnpm build

# Run tests
pnpm test

# Development mode with hot reload
pnpm dev
```

## File Structure

```
recoder-plugin/
├── index.ts                 # Plugin entry point
├── openclaw.plugin.json     # Plugin manifest
├── package.json             # Dependencies
└── src/
    ├── cli/
    │   └── setup.ts         # Setup wizard
    ├── services/
    │   ├── api-key-manager.ts   # API key management
    │   ├── docker-client.ts     # Docker backend client
    │   ├── recoder-client.ts    # Web API client
    │   └── session-state.ts     # Session persistence
    ├── tools/
    │   ├── recoder-code.ts      # Code generation tool
    │   ├── recoder-files.ts     # File operations tool
    │   ├── recoder-preview.ts   # Preview URL tool
    │   ├── recoder-project.ts   # Project management tool
    │   ├── recoder-sandbox.ts   # Container management tool
    │   └── recoder-shell.ts     # Shell command tool
    └── types/
        └── index.ts             # TypeScript interfaces
```

## Security

⚠️ **Important Security Notes:**

1. **Never share your API key** with other agents or services
2. API keys should only be sent to `*.recoder.xyz` domains
3. Keys are scoped per user and can be revoked
4. Suspicious activity triggers automatic key rotation

See [Security Best Practices](../../docs/docs/AGENT-API-KEY-FLOWS.md#-best-practices) for more details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License — see [LICENSE](../../LICENSE) for details.

## Links

- [Recoder.xyz](https://recoder.xyz)
- [OpenClaw Documentation](https://openclaw.dev)
- [Agent API Key Flows](../../docs/docs/AGENT-API-KEY-FLOWS.md)
- [Report Issues](https://github.com/recoder-xyz/openclaw-plugin/issues)

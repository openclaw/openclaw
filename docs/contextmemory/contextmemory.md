![npm](https://img.shields.io/npm/v/@akashkobal/contextmemory)
![license](https://img.shields.io/npm/l/@akashkobal/contextmemory)

# ContextMemory 🧠

Persistent AI coding context memory for developers and teams.

Git tracks your code history. **ContextMemory tracks your intent history.**

Never re-explain your architecture, decisions, or progress to AI assistants again.

---

## 🚀 Installation

Install globally from npm:

```bash
npm install -g @akashkobal/contextmemory
```

Verify installation:

```bash
contextmemory --help
```

---

## ⚡ Quick Start

Initialize inside your project:

```bash
contextmemory init
```

Save your working context:

```bash
contextmemory save
```

Quick save:

```bash
contextmemory save "Implemented multi-model execution"
```

Resume your context:

```bash
contextmemory resume
```

This copies a formatted prompt to your clipboard.  
Paste it into ChatGPT, Cursor, Claude, or any AI coding tool.

---

## 🧠 How It Works

ContextMemory creates:

```
.contextmemory/
├── context.json
├── history/
│   ├── entry-1.json
│   ├── entry-2.json
```

Each entry captures:

- Task
- Goal
- Approaches
- Decisions
- Current State
- Next Steps

---

## 📦 Commands

### Core

```bash
contextmemory init
contextmemory save
contextmemory resume
contextmemory log
contextmemory diff
```

### Automation

```bash
contextmemory watch
contextmemory hook install
contextmemory handoff @username
```

---

## 🔌 MCP Integration (Optional)

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "contextmemory": {
      "command": "npx",
      "args": ["-y", "@akashkobal/contextmemory", "mcp"]
    }
  }
}
```

---

## 🏗 Works With

- Spring Boot
- React
- Node.js
- Python
- Microservices
- Monorepos

AI Tools:

- ChatGPT
- Cursor
- Claude
- Copilot
- Windsurf

---

## 📄 License

MIT

---

## 👨‍💻 Author

Akash Kobal  
GitHub: https://github.com/AkashKobal

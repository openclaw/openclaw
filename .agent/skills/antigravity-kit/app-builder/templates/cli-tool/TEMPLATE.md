---
name: cli-tool
description: Node.js CLI tool template principles. Commander.js, interactive prompts.
---

# CLI Tool Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ |
| Language | TypeScript |
| CLI Framework | Commander.js |
| Prompts | Inquirer.js |
| Output | chalk + ora |
| Config | cosmiconfig |

---

## Directory Structure

```
project-name/
├── src/
│   ├── index.ts         # Entry point
│   ├── cli.ts           # CLI setup
│   ├── commands/        # Command handlers
│   ├── lib/
│   │   ├── config.ts    # Config loader
│   │   └── logger.ts    # Styled output
│   └── types/
├── bin/
│   └── cli.js           # Executable
└── package.json
```

---

## CLI Design Principles

| Principle | Description |
|-----------|-------------|
| Subcommands | Group related actions |
| Options | Flags with defaults |
| Interactive | Prompts when needed |
| Non-interactive | Support --yes flags |

---

## Key Components

| Component | Purpose |
|-----------|---------|
| Commander | Command parsing |
| Inquirer | Interactive prompts |
| Chalk | Colored output |
| Ora | Spinners/loading |
| Cosmiconfig | Config file discovery |

---

## Setup Steps

1. Create project directory
2. `npm init -y`
3. Install deps: `npm install commander @inquirer/prompts chalk ora cosmiconfig`
4. Configure bin in package.json
5. `npm link` for local testing

---

## Publishing

```bash
npm login
npm publish
```

---

## Best Practices

- Provide helpful error messages
- Support both interactive and non-interactive modes
- Use consistent output styling
- Validate inputs with Zod
- Exit with proper codes (0 success, 1 error)

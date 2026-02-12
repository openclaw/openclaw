# PenPot Design Plugin — Connectors

This plugin uses a local MCP server to communicate with PenPot's backend API.

## Required Environment Variables

| Variable              | Required | Description                                                |
| --------------------- | -------- | ---------------------------------------------------------- |
| `PENPOT_ACCESS_TOKEN` | Yes      | Access token from PenPot Settings > Access Tokens          |
| `PENPOT_BASE_URL`     | No       | PenPot instance URL (default: `https://design.penpot.app`) |

## Setup

1. Open PenPot and go to **Settings > Access Tokens**
2. Create a new token with any name
3. Set the `PENPOT_ACCESS_TOKEN` environment variable with the token value
4. If using a self-hosted instance, also set `PENPOT_BASE_URL`

## Server

The MCP server runs as a local Node.js process (`server/index.js`). Install its dependencies before first use:

```bash
cd server && npm install
```

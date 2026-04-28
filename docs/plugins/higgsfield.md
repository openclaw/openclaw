---
title: Higgsfield MCP
summary: Use Higgsfield AI image and video generation from OpenClaw via the official remote MCP server.
---

# Higgsfield MCP

OpenClaw includes a bundled Higgsfield MCP plugin that connects MCP-capable
agent turns to Higgsfield's official remote MCP server.

The bundle uses Higgsfield's published MCP connector endpoint:

```json
{
  "url": "https://mcp.higgsfield.ai/mcp"
}
```

## Enable the plugin

Bundled MCP plugins are disabled until explicitly enabled. Enable Higgsfield with:

```bash
openclaw plugins enable higgsfield
```

## Requirements

- A Higgsfield account
- Access to the official Higgsfield MCP connector at
  [higgsfield.ai/mcp](https://higgsfield.ai/mcp)

No API key is required in OpenClaw. Higgsfield authenticates users through the
remote MCP connector flow.

## Tools

The official Higgsfield MCP connector provides tools for creative generation and
asset workflows, including:

- image generation across Higgsfield-supported models
- video generation from text, references, and images
- generation history and asset browsing
- reusable characters and visual references
- presets and production-oriented campaign workflows

Generation tools may run asynchronously. Poll with the matching status or result
tool until the job is complete, then use the returned asset URL.

## Security and cost notes

- Higgsfield generations consume the user's Higgsfield credits; confirm before bulk or expensive runs.
- Image-to-video tools may require publicly reachable input image URLs or uploaded assets.
- Generated asset URLs can be time-limited. Archive important outputs promptly.
- Do not paste Higgsfield session tokens or account credentials into prompts, chat messages, or logs.

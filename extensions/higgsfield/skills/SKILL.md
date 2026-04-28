---
name: higgsfield
summary: Use the official Higgsfield remote MCP server for AI image and video generation.
description: Generate Higgsfield images/videos, browse assets, train characters, inspect presets/models/history, and manage generation jobs via the official Higgsfield MCP connector.
---

# Higgsfield MCP

Use this skill when the user asks for Higgsfield image/video generation or wants to inspect Higgsfield jobs, assets, presets, models, generation history, or character references.

## Requirements

The bundled MCP connector points to Higgsfield's official remote MCP endpoint:

`https://mcp.higgsfield.ai/mcp`

No API keys are configured in OpenClaw. The user authenticates with their Higgsfield account through the MCP connector flow.

## Typical flow

1. Check available models, presets, or history when the request depends on them.
2. Generate the image or video using the official Higgsfield MCP tools.
3. Poll asynchronous generations until completion when the tool returns a pending job.
4. Return downloadable output URLs or attach saved media when the caller asks for delivery.

## Notes

- Higgsfield generations consume the user's Higgsfield credits; confirm before expensive or bulk runs.
- Image-to-video tools may require accessible input image URLs or uploaded assets.
- Results can be time-limited on the Higgsfield side; archive important outputs promptly.

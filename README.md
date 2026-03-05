# MCP Web Adapter

Standalone module extracted from OpenClaw to provide a browser-based interaction layer for any Model Context Protocol (MCP) server.

## Features
- **Chrome Extension**: Direct tab attachment and interaction.
- **CDP Relay Server**: A lightweight background process that bridges the extension to CDP-capable clients.
- **Web Parsing Skill**: Specialized logic for content extraction (e.g., novel downloading).

## MCP Setup

To use this adapter with an MCP server (such as Claude Desktop or any MCP-compatible agent):

### 1. Start the Relay Server
Run the standalone relay server to listen for extension connections.
```bash
cd server
node extension-relay.js
```
The server defaults to port `18792`. Ensure you have an authentication token set in your environment (e.g., `MCP_WEB_ADAPTER_TOKEN`).

### 2. Install the Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` directory.
4. Open the extension options and set the **Relay Port** (`18792`) and the **Auth Token**.

### 3. Connect MCP
Point your MCP server's browser/CDP configuration to the relay URL:
`http://127.0.0.1:18792/json`

Now your MCP server can interact with the attached browser tab as a standard CDP target.

## Directory Structure
- `extension/`: Chrome extension source code.
- `server/`: Standalone Node.js relay server.
- `skills/`: Extracted scraping and parsing logic.

# Browser Control Architecture

Clawdbot implements a Client-Server architecture to control a browser instance (Chrome/Chromium) using Playwright Core and the Chrome DevTools Protocol (CDP).

## Execution Flow

The flow from a user's chat command (e.g., "Open YouTube") to the actual browser action involves the following steps:

1.  **Command Parsing (Agent Side)**
    *   **File:** `src/agents/tools/browser-tool.ts`
    *   The AI agent runtime identifies the intent and invokes the `browser` tool.
    *   The `execute` function is called with parameters like `{ action: "open", targetUrl: "https://youtube.com" }`.

2.  **Request Dispatch (Client Side)**
    *   **File:** `src/browser/client.ts`
    *   The tool implementation calls the corresponding client function, e.g., `browserOpenTab`.
    *   This function sends an HTTP POST request to the local gateway server (e.g., `http://127.0.0.1:18789/tabs/open`).

3.  **Request Handling (Server Side)**
    *   **File:** `src/browser/server.ts`
    *   The Express server listens for requests and routes them via `registerBrowserRoutes`.
    *   **File:** `src/browser/routes/tabs.ts` (implied)
    *   The specific route handler processes the request.

4.  **Browser Automation (Core Logic)**
    *   **File:** `src/browser/pw-session.ts`
    *   The handler calls functions like `createPageViaPlaywright`.
    *   This module manages the persistent connection to the browser using `chromium.connectOverCDP`.
    *   Playwright methods (e.g., `page.goto()`) execute the actual action in the browser.

## Context Maintenance

The system maintains context to ensure continuity across multiple interactions:

*   **Persistent Connection:** `src/browser/pw-session.ts` keeps a persistent `cached` connection object to the browser.
*   **Page State:** A `WeakMap` named `pageStates` stores per-page data, including:
    *   `console`: Recent console messages.
    *   `requests`: Recent network activity.
    *   `errors`: Page crashes or exceptions.
*   **Element References:** The `roleRefsByTarget` map caches "AI-friendly" element references (e.g., `e12` mapped to Playwright locators). This allows the agent to refer to elements by stable IDs in subsequent "act" commands (click, type, etc.).

## Error Handling

Errors are handled at multiple levels to ensure resilience:

*   **Agent Level (`src/agents/tools/browser-tool.ts`):**
    *   Catches exceptions during tool execution.
    *   Specifically handles "404: tab not found" errors, which can occur if a Chrome extension relay disconnects. It provides helpful error messages prompting the user to re-attach the tab.
*   **Browser Level (`src/browser/pw-session.ts`):**
    *   Attaches event listeners like `page.on("pageerror", ...)` to capture unhandled exceptions within the browser page.
    *   These errors are stored in the `pageStates` for the agent to inspect via the `status` or `console` actions.
*   **Connection Level:**
    *   Implements retry logic in `connectBrowser` to handle transient connection failures when establishing the CDP session.

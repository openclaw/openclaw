---
name: webmcp
description: Integrate, operate, and manage Google's Web Model Context Protocol (WebMCP) for browser-based AI agent interactions. Use when adding WebMCP to a web app, registering/managing tools, debugging agent-tool communication, writing declarative HTML annotations, or verifying WebMCP integration health. Covers both imperative (navigator.modelContext JS API) and declarative (HTML attribute) patterns.
---

# WebMCP — Web Model Context Protocol

Operate and extend WebMCP integrations for browser-based AI agents (Gemini in Chrome 146+).

## Protocol Overview

WebMCP standardises the interface between browser AI agents and web applications. Two patterns:

- **Imperative (Pattern B):** Register tools via `navigator.modelContext.registerTool()` — for background processes, data retrieval, complex workflows
- **Declarative (Pattern A):** Add `toolname` + `tooldescription` HTML attributes to visible elements — for forms, buttons, simple actions

Both patterns coexist. Use hybrid approach for full coverage.

## Browser Requirements

| Requirement | Value                                                |
| ----------- | ---------------------------------------------------- |
| Browser     | Chrome Canary 146+                                   |
| Flag        | `chrome://flags/#enable-ai-link`                     |
| API         | `navigator.modelContext`                             |
| Security    | User prompt before execution; page-context isolation |

## Operation Protocol

### Adding WebMCP to a New Project

1. Copy `webmcp.ts` utility to project's lib directory
2. Copy `webmcp.d.ts` type augmentation to source root (for React `toolname`/`tooldescription` support)
3. Create a Provider component that calls `registerAllTools()` on mount, `unregisterAllTools()` on unmount
4. Wire Provider into app root layout (wrap children)
5. Add declarative annotations to visible interactive elements
6. Verify: production build passes, console shows `[WebMCP] Successfully registered N/N tools`

### Registering an Imperative Tool

```typescript
import { registerWebMCPTool } from "./lib/webmcp";

// In app initialisation (e.g., useEffect, provider mount)
registerWebMCPTool(
  "toolName", // unique camelCase identifier
  {
    description: "What the tool does in natural language",
    input: {
      paramName: { description: "Param description", type: "string" },
    },
  },
  async ({ paramName }) => {
    // Execute logic, return JSON-serialisable result
    return { success: true, data: result };
  },
);
```

**Tool naming:** Use `{app}_{action}` convention (e.g., `gw2_create_project`).

**Schema rules:**

- `inputSchema.type` must be `"object"`
- Mark `required` fields explicitly
- Use `enum` for constrained values
- Set `readOnly: true` on non-mutating tools

### Adding Declarative Annotations

```tsx
<form
  toolname="submitOrder"
  tooldescription="Submit a new purchase order with items and shipping address"
>
  <input name="item" toolname="orderItem" tooldescription="Product name or SKU to order" />
  <button type="submit">Place Order</button>
</form>
```

**Rules:**

- Only works on **visible DOM elements** — hidden elements need imperative pattern
- `toolname` must be unique camelCase
- `tooldescription` is optional but strongly recommended
- Never put PII in descriptions (visible to agents)

### Testing WebMCP Integration

1. **Unit tests:** Verify tool registry completeness, schema validation, endpoint mapping, error handling, graceful degradation
2. **Build verification:** Production build must pass with WebMCP provider in layout
3. **Console check:** Open DevTools → look for `[WebMCP] Successfully registered N/N tools`
4. **Browser test:** Chrome Canary 146+ with flag → `navigator.modelContext` should exist
5. **Agent test:** Ask Gemini to use a registered tool — browser prompts for permission

### Error Handling

All tool executors must return structured responses:

```typescript
// Success
{
  content: [{ type: "text", text: JSON.stringify({ success: true, data }) }];
}

// Error
{
  content: [{ type: "text", text: JSON.stringify({ error: true, message, status }) }];
}
```

Never throw from executors — catch errors, return structured error content.

### Security Policy

| Rule                   | Detail                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| **Permission-first**   | Browser prompts user before agent executes any tool                    |
| **Context isolation**  | Tools run with page's auth (cookies, tokens) — no privilege escalation |
| **No PII in metadata** | Never put sensitive data in `tooldescription` or tool `description`    |
| **Read-only flagging** | Set `readOnly: true` on all non-mutating tools                         |
| **Input validation**   | JSON Schema on all inputs; reject unknown properties                   |
| **Error containment**  | Catch all errors in executors; never expose stack traces               |

### Common Pitfalls

| Issue                                | Cause                                    | Fix                                                       |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------- |
| `navigator.modelContext` undefined   | Wrong browser or flag not enabled        | Chrome Canary 146+, enable flag                           |
| TypeScript error on `toolname`       | Missing `.d.ts` type augmentation        | Add `webmcp.d.ts` to source root                          |
| Declarative tools invisible to agent | Elements hidden or not in DOM            | Use imperative pattern for hidden logic                   |
| Import alias resolution failure      | `@/*` alias doesn't map to component dir | Use relative imports or fix tsconfig paths                |
| Tools register but agent can't call  | CORS or auth issue                       | Tools inherit page context — ensure user is authenticated |

## GW2 Implementation Reference

The GW2 Compliance Assistant has a complete WebMCP integration. For implementation details and patterns:

- See `references/gw2-implementation.md` for the full tool registry, categories, and architecture
- 15 tools across 6 categories (projects, documents, assessment, reference, export, health)
- React Context provider with auto-registration lifecycle
- 39-test suite covering all tool aspects

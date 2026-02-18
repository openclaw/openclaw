# WebMCP Operation Protocol & Policy

## 1. Tool Lifecycle Management

### Registration

- Register all tools on app mount via Provider component
- Log registration count: `[WebMCP] Successfully registered N/N tools`
- If partial failure: log failed tool names, continue with successful ones
- If WebMCP unavailable: log debug message, app functions normally without agent support

### Deregistration

- Unregister all tools on app unmount (SPA navigation, page close)
- Prevents stale tool references in browser agent context

### Hot Reload (Development)

- On HMR: Provider re-mounts → tools re-register automatically
- No manual intervention needed

## 2. Tool Design Policy

### Naming Convention

```
{app}_{verb}_{noun}
```

Examples: `gw2_create_project`, `gw2_list_compliance_rules`, `gw2_export_gap_analysis`

### Schema Requirements

- Every tool must have `inputSchema` with `type: "object"`
- Required fields listed in `required` array
- Constrained values use `enum`
- Numeric bounds use `minimum`/`maximum`
- String bounds use `minLength`/`maxLength`
- `description` on every input property (agents use these to understand parameters)

### Read/Write Classification

- **readOnly: true** — GET operations, queries, exports, health checks
- **readOnly: false** — POST/PUT/DELETE operations, mutations, approvals
- Agents treat readOnly tools as safe to call without mutation warnings

### Response Format

All tools return:

```typescript
{
  content: [
    {
      type: "text",
      text: string, // JSON.stringify'd payload
    },
  ];
}
```

Success payload: `{ success: true, data: <response> }`
Error payload: `{ error: true, status?: number, message: string, type?: string }`

## 3. Security Protocol

### Principle of Least Privilege

- Tools operate with the page's existing auth context only
- No token injection, no privilege escalation
- If user is not authenticated, tools return 401 errors (handled gracefully)

### Data Classification

| Classification             | In Tool Metadata         | In Tool Responses       |
| -------------------------- | ------------------------ | ----------------------- |
| Public (app features)      | ✅ Allowed               | ✅ Allowed              |
| User data (names, IDs)     | ❌ Never in descriptions | ✅ Allowed in responses |
| Credentials (tokens, keys) | ❌ Never                 | ❌ Never                |
| Internal URLs / paths      | ❌ Never in descriptions | ⚠️ Minimise             |

### Audit Trail

- All tool executions go through standard API routes → existing logging applies
- Browser shows permission prompt → user-visible audit
- Console logs registration/execution events (debug mode)

## 4. Deployment Protocol

### Pre-Deployment Checklist

- [ ] All tests passing (`npx vitest run tests/webmcp.test.ts`)
- [ ] Production build succeeds (`next build`)
- [ ] Provider wired in root layout
- [ ] Type definitions in source root
- [ ] No PII in any tool/input descriptions
- [ ] ReadOnly flags correct on all tools
- [ ] Error handling tested (network failures, auth failures)

### Post-Deployment Verification

1. Open production URL in Chrome Canary 146+
2. Open DevTools Console
3. Verify: `[WebMCP] Successfully registered N/N tools`
4. If debug mode: check `[WebMCPProvider] Status changed:` log
5. Test one read-only tool via Gemini prompt

### Rollback

- WebMCPProvider has `autoRegister={false}` prop — set to disable without removing code
- Or remove `<WebMCPProvider>` from layout for full disable
- App functions normally without WebMCP (graceful degradation by design)

## 5. Extension Protocol

### Adding a New Tool

1. Define tool in `webmcp.ts`:

   ```typescript
   const newTool: WebMCPToolInput = {
     name: 'app_verb_noun',
     description: 'Natural language description',
     readOnly: true|false,
     inputSchema: { type: 'object', properties: {...}, required: [...] },
     execute: async (params) => safeFetch(...)
   };
   ```

2. Add to `ALL_TOOLS` array (maintain category ordering)

3. Update `TOOL_CATEGORIES` slice indices if category boundaries shift

4. Add corresponding test cases:
   - Schema validation (required fields, enums)
   - API endpoint mapping
   - ReadOnly flag

5. Verify: tests pass, build succeeds

### Adding a Declarative Form

1. Create component with `toolname` and `tooldescription` on the `<form>` element
2. Add `toolname`/`tooldescription` on individual inputs for granular discovery
3. Implement `onSubmit` handler with API call
4. Component must be **visible in DOM** — hidden forms won't be discovered

### Removing a Tool

1. Remove from `ALL_TOOLS` array
2. Update `TOOL_CATEGORIES` slice indices
3. Remove corresponding tests
4. Remove declarative components if applicable
5. `unregisterTool(name)` is called automatically on provider unmount

## 6. Monitoring

### Health Indicators

| Signal         | Healthy                                 | Unhealthy                    |
| -------------- | --------------------------------------- | ---------------------------- |
| Console log    | `registered N/N tools`                  | `Failed to register tool: X` |
| Provider state | `{ available: true, registered: true }` | `{ error: '...' }`           |
| Tool execution | Returns structured content              | Throws or hangs              |
| Browser API    | `navigator.modelContext` exists         | `undefined`                  |

### Incident Response

1. **Tools not registering:** Check browser version, flag status, console errors
2. **Tool execution fails:** Check API endpoint health, auth state, network
3. **Agent can't find tools:** Verify elements visible (declarative) or registration logged (imperative)
4. **Type errors in build:** Verify `webmcp.d.ts` exists and is included in `tsconfig.json` `include`

## 7. Versioning Policy

- WebMCP API is experimental — expect breaking changes from Chrome team
- Pin to specific Chrome Canary version for CI testing
- Monitor [WebMCP Explainer](https://github.com/explainers-by-googlers/web-model-context-protocol) for spec changes
- When `navigator.modelContext` API signature changes: update `webmcp.ts` types first, then implementations
- Maintain backward compatibility: check API existence before calling (already implemented via `isWebMCPAvailable()`)

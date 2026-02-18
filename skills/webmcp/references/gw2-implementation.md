# GW2 WebMCP Implementation Reference

Reference implementation at `/home/i/clawd/projects/gw2-compliance-agent/`.

## File Map

| File                                   | Purpose                                                             | Lines |
| -------------------------------------- | ------------------------------------------------------------------- | ----- |
| `app/lib/webmcp.ts`                    | 15 imperative tools with JSON Schema, fetch wrapper, error handling | ~715  |
| `app/components/WebMCPProvider.tsx`    | React Context, lifecycle management, hooks, DevTools panel          | ~385  |
| `app/components/WebMCPDeclarative.tsx` | 4 declarative form components with HTML annotations                 | ~695  |
| `app/webmcp.d.ts`                      | React type augmentation for `toolname`/`tooldescription`            | ~16   |
| `app/layout.tsx`                       | Provider wired: `<WebMCPProvider autoRegister={true}>` wraps app    | —     |
| `tests/webmcp.test.ts`                 | 39 tests (registry, schema, endpoints, errors, lifecycle)           | ~450  |

## Tool Registry (15 tools)

### Projects (3)

| Tool                 | Method | Endpoint                 | ReadOnly |
| -------------------- | ------ | ------------------------ | -------- |
| `gw2_create_project` | POST   | `/api/projects`          | false    |
| `gw2_list_projects`  | GET    | `/api/projects?{params}` | true     |
| `gw2_get_project`    | GET    | `/api/projects/{id}`     | true     |

### Documents (2)

| Tool                  | Method | Endpoint                | ReadOnly |
| --------------------- | ------ | ----------------------- | -------- |
| `gw2_upload_document` | POST   | `/api/documents/upload` | false    |
| `gw2_get_document`    | GET    | `/api/documents/{id}`   | true     |

### Assessment (4)

| Tool                         | Method | Endpoint                  | ReadOnly |
| ---------------------------- | ------ | ------------------------- | -------- |
| `gw2_start_assessment`       | POST   | `/api/agent/assess`       | false    |
| `gw2_get_assessment_status`  | GET    | `/api/agent/status/{id}`  | true     |
| `gw2_get_assessment_results` | GET    | `/api/agent/results/{id}` | true     |
| `gw2_approve_assessment`     | POST   | `/api/agent/approve/{id}` | false    |

### Reference (2)

| Tool                           | Method | Endpoint                          | ReadOnly |
| ------------------------------ | ------ | --------------------------------- | -------- |
| `gw2_list_compliance_rules`    | GET    | `/api/compliance-rules?{params}`  | true     |
| `gw2_browse_reference_library` | GET    | `/api/reference-library?{params}` | true     |

### Export (3)

| Tool                            | Method | Endpoint                                       | ReadOnly |
| ------------------------------- | ------ | ---------------------------------------------- | -------- |
| `gw2_export_submission_package` | GET    | `/api/export/submission-package/{id}?{params}` | true     |
| `gw2_export_compliance_matrix`  | GET    | `/api/export/compliance-matrix/{id}?{params}`  | true     |
| `gw2_export_gap_analysis`       | GET    | `/api/export/gap-analysis/{id}?{params}`       | true     |

### Health (1)

| Tool               | Method | Endpoint      | ReadOnly |
| ------------------ | ------ | ------------- | -------- |
| `gw2_health_check` | GET    | `/api/health` | true     |

## Architecture

```
layout.tsx
  └── WebMCPProvider (autoRegister=true)
        ├── mount: registerAllTools() → navigator.modelContext.registerTool(×15)
        ├── unmount: unregisterAllTools()
        └── context: useWebMCP(), useWebMCPReady()
              ├── available: boolean
              ├── registered: boolean
              ├── toolCount: number
              ├── registeredTools: string[]
              └── refresh(): re-register all tools
```

## Declarative Components

| Component                   | `toolname`             | Form Fields                                                      |
| --------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `WebMCPProjectForm`         | `gw2_create_project`   | title, description, buildingType, address, height, floors, units |
| `WebMCPDocumentUploadForm`  | `gw2_upload_document`  | file, documentType, description                                  |
| `WebMCPProjectSearch`       | `gw2_list_projects`    | status, sortBy, sortOrder, limit                                 |
| `WebMCPAssessmentStartForm` | `gw2_start_assessment` | scope checkboxes, document selection                             |

## Key Patterns

### Fetch wrapper with structured errors

All tools use `safeFetch()` which catches network errors and non-OK responses, returning structured `{ content: [{ type: 'text', text: JSON.stringify(...) }] }` — never throws.

### Base URL resolution

`getBaseURL()` returns `window.location.origin` in browser, falls back to `'https://gw2.world'` server-side.

### Import path caveat

GW2's tsconfig maps `@/*` → `./src/*`. Files in `app/` must use relative imports (e.g., `../lib/webmcp`), not `@/lib/webmcp`.

## Test Coverage

| Suite                  | Tests  | Covers                                                             |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| Tool Registry          | 7      | Count, duplicates, naming, descriptions, schemas, executors, flags |
| Tool Categories        | 7      | Category counts, sum validation                                    |
| Tool Lookup            | 2      | Valid/invalid name lookup                                          |
| Schema Validation      | 6      | Required fields, enum consistency, document types, scope           |
| API Endpoint Mapping   | 6      | URL construction, HTTP methods, query params                       |
| Browser Detection      | 2      | Available/unavailable states                                       |
| Registration Lifecycle | 4      | Register, unregister, error recovery, unavailable                  |
| Error Handling         | 2      | Network failure, non-OK response                                   |
| **Total**              | **39** |                                                                    |

Run: `npx vitest run tests/webmcp.test.ts`

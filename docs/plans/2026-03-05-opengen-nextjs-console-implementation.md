# OpenGen Next.js Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current static OpenGen web entry with a full Next.js console (pages + APIs) while preserving current generation capability and adding productized navigation, task views, and settings diagnostics.

**Architecture:** Use a Big Bang migration to a single Next.js App Router runtime. Route Handlers (`app/api/*`) become the HTTP layer, while `src/codegen/*` remains the generation domain layer. Build enterprise-style multi-page UI (`overview/generate/tasks/settings`) with structured result rendering and task history endpoints.

**Tech Stack:** Next.js (App Router), React, TypeScript, Vitest, Testing Library, Node.js fs/path, existing `src/codegen/*` services.

---

Execution notes:

- Follow `@superpowers:test-driven-development` for each task.
- Run final validation with `@superpowers:verification-before-completion`.
- Keep commits small and frequent (one commit per task).

### Task 1: Bootstrap Next.js Workspace for OpenGen Console

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Create: `apps/opengen-console/package.json`
- Create: `apps/opengen-console/next.config.ts`
- Create: `apps/opengen-console/tsconfig.json`
- Create: `apps/opengen-console/app/layout.tsx`
- Create: `apps/opengen-console/app/page.tsx`
- Create: `apps/opengen-console/app/globals.css`
- Create: `test/scripts/opengen-nextjs-setup.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("opengen nextjs setup", () => {
  it("registers the app workspace and dev script", () => {
    const ws = fs.readFileSync("pnpm-workspace.yaml", "utf8");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

    expect(ws).toContain("apps/opengen-console");
    expect(pkg.scripts["opengen:dev"]).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/opengen-nextjs-setup.test.ts`
Expected: FAIL because workspace entry and script are missing.

**Step 3: Write minimal implementation**

- Add `apps/opengen-console` as a workspace entry in `pnpm-workspace.yaml`.
- Add root scripts in `package.json`:

```json
{
  "scripts": {
    "opengen:dev": "pnpm --dir apps/opengen-console dev",
    "opengen:build": "pnpm --dir apps/opengen-console build",
    "opengen:start": "pnpm --dir apps/opengen-console start",
    "opengen:test": "pnpm --dir apps/opengen-console test"
  }
}
```

- Create `apps/opengen-console` with minimal Next.js App Router structure.

**Step 4: Run test to verify it passes**

Run:

- `pnpm install`
- `pnpm vitest run test/scripts/opengen-nextjs-setup.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: bootstrap opengen nextjs console workspace" \
  pnpm-workspace.yaml \
  package.json \
  apps/opengen-console/package.json \
  apps/opengen-console/next.config.ts \
  apps/opengen-console/tsconfig.json \
  apps/opengen-console/app/layout.tsx \
  apps/opengen-console/app/page.tsx \
  apps/opengen-console/app/globals.css \
  test/scripts/opengen-nextjs-setup.test.ts
```

### Task 2: Add Shared Codegen Service Adapter for Next APIs

**Files:**

- Create: `apps/opengen-console/lib/codegen-service.ts`
- Create: `apps/opengen-console/lib/codegen-service.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createGenerationTask } from "./codegen-service";

describe("codegen service", () => {
  it("rejects missing description", async () => {
    await expect(createGenerationTask({ description: "", type: "web" })).rejects.toThrow(
      "description",
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/opengen-console test -- codegen-service.test.ts`
Expected: FAIL because service does not exist yet.

**Step 3: Write minimal implementation**

Implement `createGenerationTask` with:

- Input validation for `description` and `type`
- `createLLMClientFromEnv()` + `createOrchestrator(...)`
- PM-stage workflow config parity with current behavior
- Return task result object from `executeTask`

Example core function signature:

```ts
export async function createGenerationTask(input: {
  description: string;
  type: "web" | "api" | "mobile" | "desktop" | "cli";
  tech_stack?: string[];
}) {
  // validate -> create request -> execute orchestrator -> return result
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --dir apps/opengen-console test -- codegen-service.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: add next api codegen service adapter" \
  apps/opengen-console/lib/codegen-service.ts \
  apps/opengen-console/lib/codegen-service.test.ts
```

### Task 3: Implement Next Route Handlers for Health and Generate

**Files:**

- Create: `apps/opengen-console/app/api/health/route.ts`
- Create: `apps/opengen-console/app/api/generate/route.ts`
- Create: `apps/opengen-console/app/api/generate/route.test.ts`
- Create: `apps/opengen-console/app/api/health/route.test.ts`

**Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("health route", () => {
  it("returns ok", async () => {
    const res = await GET();
    const json = await res.json();
    expect(json.status).toBe("ok");
  });
});
```

```ts
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("generate route", () => {
  it("returns 400 for invalid payload", async () => {
    const req = new Request("http://localhost/api/generate", {
      method: "POST",
      body: JSON.stringify({ description: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

- `pnpm --dir apps/opengen-console test -- app/api/health/route.test.ts`
- `pnpm --dir apps/opengen-console test -- app/api/generate/route.test.ts`

Expected: FAIL.

**Step 3: Write minimal implementation**

- `GET /api/health`: return `{ status: "ok", timestamp }`.
- `POST /api/generate`:
  - parse JSON body
  - validate `description` and `type`
  - call `createGenerationTask`
  - return `200` with result or `500` with error payload

**Step 4: Run tests to verify they pass**

Run:

- `pnpm --dir apps/opengen-console test -- app/api/health/route.test.ts`
- `pnpm --dir apps/opengen-console test -- app/api/generate/route.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: add next health and generate routes" \
  apps/opengen-console/app/api/health/route.ts \
  apps/opengen-console/app/api/generate/route.ts \
  apps/opengen-console/app/api/health/route.test.ts \
  apps/opengen-console/app/api/generate/route.test.ts
```

### Task 4: Build Enterprise Console Shell and Route Pages

**Files:**

- Create: `apps/opengen-console/components/console-shell.tsx`
- Create: `apps/opengen-console/components/console-shell.test.tsx`
- Modify: `apps/opengen-console/app/layout.tsx`
- Modify: `apps/opengen-console/app/page.tsx`
- Create: `apps/opengen-console/app/generate/page.tsx`
- Create: `apps/opengen-console/app/tasks/page.tsx`
- Create: `apps/opengen-console/app/settings/page.tsx`
- Modify: `apps/opengen-console/app/globals.css`

**Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsoleShell } from "./console-shell";

describe("console shell", () => {
  it("renders primary navigation", () => {
    render(<ConsoleShell title="Overview">x</ConsoleShell>);
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Generate" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/opengen-console test -- components/console-shell.test.tsx`
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add reusable shell with enterprise-style top bar and left nav.
- Wire pages:
  - `/` -> Overview
  - `/generate`
  - `/tasks`
  - `/settings`

**Step 4: Run test to verify it passes**

Run: `pnpm --dir apps/opengen-console test -- components/console-shell.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: add opengen console shell and route pages" \
  apps/opengen-console/components/console-shell.tsx \
  apps/opengen-console/components/console-shell.test.tsx \
  apps/opengen-console/app/layout.tsx \
  apps/opengen-console/app/page.tsx \
  apps/opengen-console/app/generate/page.tsx \
  apps/opengen-console/app/tasks/page.tsx \
  apps/opengen-console/app/settings/page.tsx \
  apps/opengen-console/app/globals.css
```

### Task 5: Implement Generate Workspace with Structured Result Rendering

**Files:**

- Create: `apps/opengen-console/components/generate-workspace.tsx`
- Create: `apps/opengen-console/components/generate-workspace.test.tsx`
- Modify: `apps/opengen-console/app/generate/page.tsx`

**Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GenerateWorkspace } from "./generate-workspace";

describe("generate workspace", () => {
  it("shows loading and then renders result sections", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        outputs: {
          product_spec: { user_stories: [], features: [], non_functional_requirements: {} },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<GenerateWorkspace />);
    fireEvent.change(screen.getByLabelText("需求描述"), { target: { value: "todo app" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByText("用户故事")).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/opengen-console test -- components/generate-workspace.test.tsx`
Expected: FAIL.

**Step 3: Write minimal implementation**

- Build generate form fields: description/type/tech stack.
- Add state machine: `idle/submitting/success/error`.
- Render output in sections:
  - summary stats
  - user stories
  - features with priority tags
  - non-functional requirements

**Step 4: Run test to verify it passes**

Run: `pnpm --dir apps/opengen-console test -- components/generate-workspace.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: add generate workspace with structured outputs" \
  apps/opengen-console/components/generate-workspace.tsx \
  apps/opengen-console/components/generate-workspace.test.tsx \
  apps/opengen-console/app/generate/page.tsx
```

### Task 6: Add Task History API and Tasks Pages

**Files:**

- Create: `apps/opengen-console/lib/task-store.ts`
- Create: `apps/opengen-console/lib/task-store.test.ts`
- Create: `apps/opengen-console/app/api/tasks/route.ts`
- Create: `apps/opengen-console/app/api/tasks/[taskId]/route.ts`
- Modify: `apps/opengen-console/app/api/generate/route.ts`
- Modify: `apps/opengen-console/app/tasks/page.tsx`
- Create: `apps/opengen-console/app/tasks/[taskId]/page.tsx`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createTaskStore } from "./task-store";

describe("task store", () => {
  it("persists and retrieves tasks by id", async () => {
    const store = createTaskStore("/tmp/opengen-task-store.test.json");
    await store.save({ task_id: "t1", status: "completed" } as any);
    const found = await store.getById("t1");
    expect(found?.task_id).toBe("t1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/opengen-console test -- lib/task-store.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

- Implement filesystem-backed minimal task store.
- On successful `/api/generate`, append/save task summary.
- Add:
  - `GET /api/tasks` (list)
  - `GET /api/tasks/:taskId` (detail)
- Build tasks list and detail pages to consume these APIs.

**Step 4: Run test to verify it passes**

Run:

- `pnpm --dir apps/opengen-console test -- lib/task-store.test.ts`
- `pnpm --dir apps/opengen-console test -- app/api/tasks`

Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: add task history api and tasks views" \
  apps/opengen-console/lib/task-store.ts \
  apps/opengen-console/lib/task-store.test.ts \
  apps/opengen-console/app/api/tasks/route.ts \
  apps/opengen-console/app/api/tasks/[taskId]/route.ts \
  apps/opengen-console/app/api/generate/route.ts \
  apps/opengen-console/app/tasks/page.tsx \
  apps/opengen-console/app/tasks/[taskId]/page.tsx
```

### Task 7: Add Settings Diagnostics Page

**Files:**

- Create: `apps/opengen-console/app/api/settings/route.ts`
- Create: `apps/opengen-console/app/api/settings/route.test.ts`
- Modify: `apps/opengen-console/app/settings/page.tsx`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("settings route", () => {
  it("returns model diagnostics without exposing secrets", async () => {
    const res = await GET();
    const json = await res.json();
    expect(json).toHaveProperty("provider");
    expect(json).not.toHaveProperty("api_key");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/opengen-console test -- app/api/settings/route.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add `GET /api/settings` returning:
  - provider type
  - model name
  - endpoint host (masked)
  - health status from lightweight probe
- Render diagnostics cards on `/settings` page.

**Step 4: Run test to verify it passes**

Run: `pnpm --dir apps/opengen-console test -- app/api/settings/route.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "feat: add settings diagnostics route and page" \
  apps/opengen-console/app/api/settings/route.ts \
  apps/opengen-console/app/api/settings/route.test.ts \
  apps/opengen-console/app/settings/page.tsx
```

### Task 8: Cut Over Entrypoints from Legacy Static UI to Next Console

**Files:**

- Modify: `scripts/start-web.sh`
- Modify: `src/codegen/server.ts`
- Modify: `src/codegen/README.md`
- Modify: `HOW-TO-USE.md`
- Create: `test/scripts/opengen-entrypoint-cutover.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("opengen entrypoint cutover", () => {
  it("uses next console as default web start path", () => {
    const script = fs.readFileSync("scripts/start-web.sh", "utf8");
    expect(script).toContain("pnpm opengen:dev");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scripts/opengen-entrypoint-cutover.test.ts`
Expected: FAIL because script still runs `src/codegen/server.ts`.

**Step 3: Write minimal implementation**

- Update `scripts/start-web.sh` to call Next console dev entry.
- Mark `src/codegen/server.ts` as legacy/deprecated entry (not default runtime path).
- Update docs usage commands to Next console entry commands.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/scripts/opengen-entrypoint-cutover.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
./scripts/committer "chore: switch opengen web entry to next console" \
  scripts/start-web.sh \
  src/codegen/server.ts \
  src/codegen/README.md \
  HOW-TO-USE.md \
  test/scripts/opengen-entrypoint-cutover.test.ts
```

### Task 9: End-to-End Verification and Handoff

**Files:**

- Modify: `docs/plans/2026-03-05-opengen-nextjs-console-design.md` (only if architectural assumptions changed)

**Step 1: Run full verification suite**

Run:

- `pnpm vitest run test/scripts/opengen-nextjs-setup.test.ts`
- `pnpm --dir apps/opengen-console test`
- `pnpm vitest run test/scripts/opengen-entrypoint-cutover.test.ts`
- `pnpm opengen:build`

Expected: all PASS.

**Step 2: Run runtime smoke checks**

Run:

- `PORT=3301 pnpm opengen:dev`
- `curl -sS http://127.0.0.1:3301/api/health`
- `curl -sS -X POST http://127.0.0.1:3301/api/generate -H 'Content-Type: application/json' --data '{"description":"todo app","type":"web"}'`

Expected:

- health returns `{ "status": "ok" }`
- generate returns `status=completed` and `outputs.product_spec`

**Step 3: Commit any final doc alignment (if changed)**

```bash
./scripts/committer "docs: align opengen design after nextjs cutover" \
  docs/plans/2026-03-05-opengen-nextjs-console-design.md
```

(If no diff, skip commit.)

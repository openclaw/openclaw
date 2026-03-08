# Pact Consumer CDC — Framework Setup

## Principle

When scaffolding a Pact.js consumer contract testing framework, align every artifact — directory layout, vitest config, package.json scripts, shell scripts, CI workflow, and test files — with the canonical `@seontechnologies/pactjs-utils` conventions. Consistency across repositories eliminates onboarding friction and ensures CI pipelines are copy-paste portable.

## Rationale

The TEA framework workflow generates scaffolding for consumer-driven contract (CDC) testing. Without opinionated, battle-tested conventions, each project invents its own structure — different script names, different env var patterns, different CI step ordering — making cross-repo maintenance expensive. This fragment codifies the production-proven patterns from the pactjs-utils reference implementation so that every new project starts correctly.

## Pattern Examples

### Example 1: Directory Structure & File Naming

**Context**: Consumer contract test project layout using pactjs-utils conventions.

**Implementation**:

```
tests/contract/
├── consumer/
│   ├── get-filter-fields.pacttest.ts    # Consumer test (one per endpoint group)
│   ├── filter-transactions.pacttest.ts
│   └── get-transaction-stats.pacttest.ts
└── support/
    ├── pact-config.ts                   # PactV4 factory (consumer/provider names, output dir)
    ├── provider-states.ts               # Provider state factory functions
    └── consumer-helpers.ts              # Local shim (until pactjs-utils is published)

scripts/
├── env-setup.sh                         # Shared env loader (sourced by all broker scripts)
├── publish-pact.sh                      # Publish pact files to broker
├── can-i-deploy.sh                      # Deployment safety check
└── record-deployment.sh                 # Record deployment after merge

.github/
├── actions/
│   └── detect-breaking-change/
│       └── action.yml                   # PR checkbox-driven breaking change detection
└── workflows/
    └── contract-test-consumer.yml       # Consumer CDC CI workflow
```

**Key Points**:

- Consumer tests use `.pacttest.ts` extension (not `.pact.spec.ts` or `.contract.ts`)
- Support files live in `tests/contract/support/`, not mixed with consumer tests
- Shell scripts live in `scripts/` at project root, not nested inside test directories
- CI workflow named `contract-test-consumer.yml` (not `pact-consumer.yml` or other variants)

---

### Example 2: Vitest Configuration for Pact

**Context**: Minimal vitest config dedicated to contract tests — do NOT copy settings from the project's main `vitest.config.ts`.

**Implementation**:

```typescript
// vitest.config.pact.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/contract/**/*.pacttest.ts"],
    testTimeout: 30000,
  },
});
```

**Key Points**:

- Do NOT add `pool`, `poolOptions`, `setupFiles`, `coverage`, or other settings from the unit test config
- Keep it minimal — Pact tests run in Node environment with extended timeout
- 30 second timeout accommodates Pact mock server startup and interaction verification
- Use a dedicated config file (`vitest.config.pact.ts`), not the main vitest config

---

### Example 3: Package.json Script Naming

**Context**: Colon-separated naming matching pactjs-utils exactly. Scripts source `env-setup.sh` inline.

**Implementation**:

```json
{
  "scripts": {
    "test:pact:consumer": "vitest run --config vitest.config.pact.ts",
    "publish:pact": ". ./scripts/env-setup.sh && ./scripts/publish-pact.sh",
    "can:i:deploy:consumer": ". ./scripts/env-setup.sh && PACTICIPANT=<service-name> ./scripts/can-i-deploy.sh",
    "record:consumer:deployment": ". ./scripts/env-setup.sh && PACTICIPANT=<service-name> ./scripts/record-deployment.sh"
  }
}
```

Replace `<service-name>` with the consumer's pacticipant name (e.g., `my-frontend-app`).

**Key Points**:

- Use colon-separated naming: `test:pact:consumer`, NOT `test:contract` or `test:contract:consumer`
- Broker scripts source `env-setup.sh` inline in package.json (`. ./scripts/env-setup.sh && ...`)
- `PACTICIPANT` is set per-script invocation, not globally
- Do NOT use `npx pact-broker` — use `pact-broker` directly (installed as a dependency)

---

### Example 4: Shell Scripts

**Context**: Reusable bash scripts aligned with pactjs-utils conventions.

#### `scripts/env-setup.sh` — Shared Environment Loader

```bash
#!/bin/bash
# -e: exit on error  -u: error on undefined vars (catches typos/missing env vars in CI)
set -eu

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export GITHUB_SHA="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
export GITHUB_BRANCH="${GITHUB_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
```

#### `scripts/publish-pact.sh` — Publish Pacts to Broker

```bash
#!/bin/bash
# Publish generated pact files to PactFlow/Pact Broker
#
# Requires: PACT_BROKER_BASE_URL, PACT_BROKER_TOKEN, GITHUB_SHA, GITHUB_BRANCH
# -e: exit on error  -u: error on undefined vars  -o pipefail: fail if any pipe segment fails
set -euo pipefail

. ./scripts/env-setup.sh

PACT_DIR="./pacts"

pact-broker publish "$PACT_DIR" \
    --consumer-app-version="$GITHUB_SHA" \
    --branch="$GITHUB_BRANCH" \
    --broker-base-url="$PACT_BROKER_BASE_URL" \
    --broker-token="$PACT_BROKER_TOKEN"
```

#### `scripts/can-i-deploy.sh` — Deployment Safety Check

```bash
#!/bin/bash
# Check if a pacticipant version can be safely deployed
#
# Requires: PACTICIPANT (set by caller), PACT_BROKER_BASE_URL, PACT_BROKER_TOKEN, GITHUB_SHA
# -e: exit on error  -u: error on undefined vars  -o pipefail: fail if any pipe segment fails
set -euo pipefail

. ./scripts/env-setup.sh

PACTICIPANT="${PACTICIPANT:?PACTICIPANT env var is required}"
ENVIRONMENT="${ENVIRONMENT:-dev}"

pact-broker can-i-deploy \
    --pacticipant "$PACTICIPANT" \
    --version="$GITHUB_SHA" \
    --to-environment "$ENVIRONMENT" \
    --retry-while-unknown=10 \
    --retry-interval=30
```

#### `scripts/record-deployment.sh` — Record Deployment

```bash
#!/bin/bash
# Record a deployment to an environment in Pact Broker
# Only records on main/master branch (skips feature branches)
#
# Requires: PACTICIPANT, PACT_BROKER_BASE_URL, PACT_BROKER_TOKEN, GITHUB_SHA, GITHUB_BRANCH
# -e: exit on error  -u: error on undefined vars  -o pipefail: fail if any pipe segment fails
set -euo pipefail

. ./scripts/env-setup.sh

PACTICIPANT="${PACTICIPANT:?PACTICIPANT env var is required}"

if [ "$GITHUB_BRANCH" = "main" ] || [ "$GITHUB_BRANCH" = "master" ]; then
  pact-broker record-deployment \
      --pacticipant "$PACTICIPANT" \
      --version "$GITHUB_SHA" \
      --environment "${npm_config_env:-dev}"
else
  echo "Skipping record-deployment: not on main branch (current: $GITHUB_BRANCH)"
fi
```

**Key Points**:

- `env-setup.sh` uses `set -eu` (no pipefail — it only sources `.env`, no pipes); broker scripts use `set -euo pipefail`
- Use `pact-broker` directly, NOT `npx pact-broker`
- Use `PACTICIPANT` env var (required via `${PACTICIPANT:?...}`), not hardcoded service names
- `can-i-deploy` includes `--retry-while-unknown=10 --retry-interval=30` (waits for provider verification)
- `record-deployment` has branch guard (only records on main/master)
- Do NOT invent custom env vars like `PACT_CONSUMER_VERSION` or `PACT_BREAKING_CHANGE` in scripts — those are handled by `env-setup.sh` and the CI detect-breaking-change action respectively

---

### Example 5: CI Workflow (`contract-test-consumer.yml`)

**Context**: GitHub Actions workflow for consumer CDC, matching pactjs-utils structure exactly.

**Implementation**:

```yaml
name: Contract Test - Consumer
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  push:
    branches: [main]

env:
  PACT_BROKER_BASE_URL: ${{ secrets.PACT_BROKER_BASE_URL }}
  PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
  GITHUB_SHA: ${{ github.sha }}
  GITHUB_BRANCH: ${{ github.head_ref || github.ref_name }}

concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

jobs:
  consumer-contract-test:
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version-file: ".nvmrc"
          cache: "npm"

      - name: Detect Pact breaking change
        uses: ./.github/actions/detect-breaking-change

      - name: Install dependencies
        run: npm ci

      # (1) Generate pact files
      - name: Run consumer contract tests
        run: npm run test:pact:consumer

      # (2) Publish pacts to broker
      - name: Publish pacts to PactFlow
        run: npm run publish:pact

      # After publish, PactFlow fires a webhook that triggers
      # the provider's contract-test-provider.yml workflow.
      # can-i-deploy retries while waiting for provider verification.

      # (4) Check deployment safety (main only — on PRs, local verification is the gate)
      - name: Can I deploy consumer? (main only)
        if: github.ref == 'refs/heads/main' && env.PACT_BREAKING_CHANGE != 'true'
        run: npm run can:i:deploy:consumer

      # (5) Record deployment (main only)
      - name: Record consumer deployment (main only)
        if: github.ref == 'refs/heads/main'
        run: npm run record:consumer:deployment --env=dev
```

**Key Points**:

- **Workflow-level `env` block** for broker secrets and git vars — not per-step
- **`detect-breaking-change` step** runs before install to set `PACT_BREAKING_CHANGE` env var
- **Step numbering skips (3)** — step 3 is the webhook-triggered provider verification (happens externally)
- **can-i-deploy condition**: `github.ref == 'refs/heads/main' && env.PACT_BREAKING_CHANGE != 'true'`
- **Comment on (4)**: "on PRs, local verification is the gate"
- **No upload-artifact step** — the broker is the source of truth for pact files
- **`dependabot[bot]` skip** on the job (contract tests don't run for dependency updates)
- **PR types include `edited`** — needed for breaking change checkbox detection in PR body
- **`GITHUB_BRANCH`** uses `${{ github.head_ref || github.ref_name }}` — `head_ref` for PRs, `ref_name` for pushes

---

### Example 6: Detect Breaking Change Composite Action

**Context**: GitHub composite action that reads a `[x] Pact breaking change` checkbox from the PR body.

**Implementation**:

Create `.github/actions/detect-breaking-change/action.yml`:

```yaml
name: "Detect Pact Breaking Change"
description: "Reads the PR template checkbox to determine if this change is a Pact breaking change. Sets PACT_BREAKING_CHANGE env var."

outputs:
  is_breaking_change:
    description: "Whether the change is a breaking change (true/false)"
    value: ${{ steps.result.outputs.is_breaking_change }}

runs:
  using: "composite"
  steps:
    # PR event path: read checkbox directly from current PR body.
    - name: Set PACT_BREAKING_CHANGE from PR description (PR only)
      if: github.event_name == 'pull_request'
      uses: actions/github-script@v7
      with:
        script: |
          const prBody = context.payload.pull_request.body || '';
          const breakingChangePattern = /\[\s*[xX]\s*\]\s*Pact breaking change/i;
          const isBreakingChange = breakingChangePattern.test(prBody);
          core.exportVariable('PACT_BREAKING_CHANGE', isBreakingChange ? 'true' : 'false');
          console.log(`PACT_BREAKING_CHANGE=${isBreakingChange ? 'true' : 'false'} (from PR description checkbox).`);

    # Push-to-main path: resolve the merged PR and read the same checkbox.
    - name: Set PACT_BREAKING_CHANGE from merged PR (push to main)
      if: github.event_name == 'push' && github.ref == 'refs/heads/main'
      uses: actions/github-script@v7
      with:
        script: |
          const { data: prs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
            owner: context.repo.owner,
            repo: context.repo.repo,
            commit_sha: context.sha,
          });
          const merged = prs.find(pr => pr.merged_at);
          const mergedBody = merged?.body || '';
          const breakingChangePattern = /\[\s*[xX]\s*\]\s*Pact breaking change/i;
          const isBreakingChange = breakingChangePattern.test(mergedBody);
          core.exportVariable('PACT_BREAKING_CHANGE', isBreakingChange ? 'true' : 'false');
          console.log(`PACT_BREAKING_CHANGE=${isBreakingChange ? 'true' : 'false'} (from merged PR lookup).`);

    - name: Export result
      id: result
      shell: bash
      run: echo "is_breaking_change=${PACT_BREAKING_CHANGE:-false}" >> "$GITHUB_OUTPUT"
```

**Key Points**:

- Two separate conditional steps (better CI log readability than single if/else)
- PR path: reads checkbox directly from PR body
- Push-to-main path: resolves merged PR via GitHub API, reads same checkbox
- Exports `PACT_BREAKING_CHANGE` env var for downstream steps
- `outputs.is_breaking_change` available for consuming workflows
- Uses a case-insensitive checkbox regex (`/\[\s*[xX]\s*\]\s*Pact breaking change/i`) to detect checked states robustly

---

### Example 7: Consumer Test Using PactV4 Builder

**Context**: Consumer pact test using PactV4 `addInteraction()` builder pattern. The test MUST call **real consumer code** (your actual API client/service functions) against the mock server — not raw `fetch()`. Using `fetch()` directly defeats the purpose of CDC testing because it doesn't verify your actual consumer code works with the contract.

**Implementation**:

The consumer code must expose a way to inject the base URL (e.g., `setApiUrl()`, constructor parameter, or environment variable). This is a prerequisite for contract testing.

```typescript
// src/api/movie-client.ts — The REAL consumer code (already exists in your project)
import axios from "axios";

const axiosInstance = axios.create({
  baseURL: process.env.API_URL || "http://localhost:3001",
});

// Expose a way to override the base URL for Pact testing
export const setApiUrl = (url: string) => {
  axiosInstance.defaults.baseURL = url;
};

export const getMovies = async () => {
  const res = await axiosInstance.get("/movies");
  return res.data;
};

export const getMovieById = async (id: number) => {
  const res = await axiosInstance.get(`/movies/${id}`);
  return res.data;
};
```

```typescript
// tests/contract/consumer/get-movies.pacttest.ts
import { MatchersV3 } from "@pact-foundation/pact";
import type { V3MockServer } from "@pact-foundation/pact";
import { createProviderState, setJsonBody, setJsonContent } from "../support/consumer-helpers";
import { movieExists } from "../support/provider-states";
import { createPact } from "../support/pact-config";
// Import REAL consumer code — this is what we're actually testing
import { getMovies, getMovieById, setApiUrl } from "../../../src/api/movie-client";

const { like, integer, string } = MatchersV3;

const pact = createPact();

describe("Movies API Consumer Contract", () => {
  const movieWithId = {
    id: 1,
    name: "The Matrix",
    year: 1999,
    rating: 8.7,
    director: "Wachowskis",
  };

  it("should get a movie by ID", async () => {
    const [stateName, stateParams] = createProviderState(movieExists(movieWithId));

    await pact
      .addInteraction()
      .given(stateName, stateParams)
      .uponReceiving("a request to get movie by ID")
      .withRequest(
        "GET",
        "/movies/1",
        setJsonContent({
          headers: { Accept: "application/json" },
        }),
      )
      .willRespondWith(
        200,
        setJsonContent({
          body: like({
            id: integer(1),
            name: string("The Matrix"),
            year: integer(1999),
            rating: like(8.7),
            director: string("Wachowskis"),
          }),
        }),
      )
      .executeTest(async (mockServer: V3MockServer) => {
        // Inject mock server URL into the REAL consumer code
        setApiUrl(mockServer.url);

        // Call the REAL consumer function — this is what CDC testing validates
        const movie = await getMovieById(1);

        expect(movie.id).toBe(1);
        expect(movie.name).toBe("The Matrix");
      });
  });

  it("should handle movie not found", async () => {
    await pact
      .addInteraction()
      .given("No movies exist")
      .uponReceiving("a request for a non-existent movie")
      .withRequest("GET", "/movies/999")
      .willRespondWith(404, setJsonBody({ error: "Movie not found" }))
      .executeTest(async (mockServer: V3MockServer) => {
        setApiUrl(mockServer.url);

        await expect(getMovieById(999)).rejects.toThrow();
      });
  });
});
```

**Key Points**:

- **CRITICAL**: Always test your REAL consumer code — import and call actual API client functions, never raw `fetch()`
- Using `fetch()` directly only tests that Pact's mock server works, which is meaningless
- Consumer code MUST expose a URL injection mechanism: `setApiUrl()`, env var override, or constructor parameter
- If the consumer code doesn't support URL injection, add it — this is a design prerequisite for CDC testing
- Use PactV4 `addInteraction()` builder (not PactV3 fluent API with `withRequest({...})` object)
- Use `setJsonContent` for request/response builder callbacks with query/header/body concerns; use `setJsonBody` for body-only response callbacks
- Provider state factory functions (`movieExists`) return `ProviderStateInput` objects
- `createProviderState` converts to `[stateName, stateParams]` tuple for `.given()`

**Common URL injection patterns** (pick whichever fits your consumer architecture):

| Pattern              | Example                                      | Best For              |
| -------------------- | -------------------------------------------- | --------------------- |
| `setApiUrl(url)`     | Mutates axios instance `baseURL`             | Singleton HTTP client |
| Constructor param    | `new ApiClient({ baseUrl: mockServer.url })` | Class-based clients   |
| Environment variable | `process.env.API_URL = mockServer.url`       | Config-driven apps    |
| Factory function     | `createApi({ baseUrl: mockServer.url })`     | Functional patterns   |

---

### Example 8: Support Files

#### Pact Config Factory

```typescript
// tests/contract/support/pact-config.ts
import path from "node:path";
import { PactV4 } from "@pact-foundation/pact";

export const createPact = (overrides?: { consumer?: string; provider?: string }) =>
  new PactV4({
    dir: path.resolve(process.cwd(), "pacts"),
    consumer: overrides?.consumer ?? "MyConsumerApp",
    provider: overrides?.provider ?? "MyProviderAPI",
    logLevel: "warn",
  });
```

#### Provider State Factories

```typescript
// tests/contract/support/provider-states.ts
import type { ProviderStateInput } from "./consumer-helpers";

export const movieExists = (movie: {
  id: number;
  name: string;
  year: number;
  rating: number;
  director: string;
}): ProviderStateInput => ({
  name: "An existing movie exists",
  params: movie,
});

export const hasMovieWithId = (id: number): ProviderStateInput => ({
  name: "Has a movie with a specific ID",
  params: { id },
});
```

#### Local Consumer Helpers Shim

```typescript
// tests/contract/support/consumer-helpers.ts
// TODO(temporary scaffolding): Replace local TemplateHeaders/TemplateQuery types
// with '@seontechnologies/pactjs-utils' exports when available.

type TemplateHeaders = Record<string, string | number | boolean>;
type TemplateQueryValue = string | number | boolean | Array<string | number | boolean>;
type TemplateQuery = Record<string, TemplateQueryValue>;

export type ProviderStateInput = {
  name: string;
  params: Record<string, unknown>;
};

type JsonMap = { [key: string]: boolean | number | string | null | JsonMap | Array<unknown> };
type JsonContentBuilder = {
  headers: (headers: TemplateHeaders) => unknown;
  jsonBody: (body: unknown) => unknown;
  query?: (query: TemplateQuery) => unknown;
};

export type JsonContentInput = {
  body?: unknown;
  headers?: TemplateHeaders;
  query?: TemplateQuery;
};

export const toJsonMap = (obj: Record<string, unknown>): JsonMap =>
  Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      if (value === null || value === undefined) return [key, "null"];
      if (typeof value === "object" && !(value instanceof Date) && !Array.isArray(value))
        return [key, JSON.stringify(value)];
      if (typeof value === "number" || typeof value === "boolean") return [key, value];
      if (value instanceof Date) return [key, value.toISOString()];
      return [key, String(value)];
    }),
  );

export const createProviderState = ({ name, params }: ProviderStateInput): [string, JsonMap] => [
  name,
  toJsonMap(params),
];

export const setJsonContent =
  ({ body, headers, query }: JsonContentInput) =>
  (builder: JsonContentBuilder): void => {
    if (query && builder.query) {
      builder.query(query);
    }

    if (headers) {
      builder.headers(headers);
    }

    if (body !== undefined) {
      builder.jsonBody(body);
    }
  };

export const setJsonBody = (body: unknown) => setJsonContent({ body });
```

**Key Points**:

- If `@seontechnologies/pactjs-utils` is not yet installed, create a local shim that mirrors the API
- Add a TODO comment noting to swap for the published package when available
- The shim exports `createProviderState`, `toJsonMap`, `setJsonContent`, `setJsonBody`, and helper input types
- Keep shim types local (or sourced from public exports only); do not import from internal Pact paths like `@pact-foundation/pact/src/*`

---

### Example 9: .gitignore Entries

**Context**: Pact-specific entries to add to `.gitignore`.

```
# Pact contract testing artifacts
/pacts/
pact-logs/
```

---

## Validation Checklist

Before presenting the consumer CDC framework to the user, verify:

- [ ] `vitest.config.pact.ts` is minimal (no pool/coverage/setup copied from unit config)
- [ ] Script names match pactjs-utils (`test:pact:consumer`, `publish:pact`, `can:i:deploy:consumer`, `record:consumer:deployment`)
- [ ] Scripts source `env-setup.sh` inline in package.json
- [ ] Shell scripts use `pact-broker` not `npx pact-broker`
- [ ] Shell scripts use `PACTICIPANT` env var pattern
- [ ] `can-i-deploy.sh` has `--retry-while-unknown=10 --retry-interval=30`
- [ ] `record-deployment.sh` has branch guard
- [ ] `env-setup.sh` uses `set -eu`; broker scripts use `set -euo pipefail` — each with explanatory comment
- [ ] CI workflow named `contract-test-consumer.yml`
- [ ] CI has workflow-level env block (not per-step)
- [ ] CI has `detect-breaking-change` step before install
- [ ] CI step numbering skips (3) — webhook-triggered provider verification
- [ ] CI can-i-deploy has `PACT_BREAKING_CHANGE != 'true'` condition
- [ ] CI has NO upload-artifact step
- [ ] `.github/actions/detect-breaking-change/action.yml` exists
- [ ] Consumer tests use `.pacttest.ts` extension
- [ ] Consumer tests use PactV4 `addInteraction()` builder
- [ ] Interaction callbacks use `setJsonContent` for query/header/body and `setJsonBody` for body-only responses
- [ ] Consumer tests call REAL consumer code (actual API client functions), NOT raw `fetch()`
- [ ] Consumer code exposes URL injection mechanism (`setApiUrl()`, env var, or constructor param)
- [ ] Local consumer-helpers shim present if pactjs-utils not installed
- [ ] `.gitignore` includes `/pacts/` and `pact-logs/`

## Related Fragments

- `pactjs-utils-overview.md` — Library decision tree and installation
- `pactjs-utils-consumer-helpers.md` — `createProviderState`, `toJsonMap`, `setJsonContent`, and `setJsonBody` API details
- `pactjs-utils-provider-verifier.md` — Provider-side verification patterns
- `pactjs-utils-request-filter.md` — Auth injection for provider verification
- `contract-testing.md` — Foundational CDC patterns and resilience coverage

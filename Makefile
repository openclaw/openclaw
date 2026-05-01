.PHONY: help clean clean-dist build rebuild deps test test-fast test-coverage \
       lint check format format-fix typecheck ui dev version \
       test-contracts test-extensions test-channels landing-gate

# Default target
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Dependencies ──────────────────────────────────────────

deps: node_modules ## Install dependencies

node_modules: pnpm-lock.yaml
	pnpm install
	@touch node_modules

# ── Build ─────────────────────────────────────────────────

build: deps ## Build everything (main + UI)
	pnpm build
	pnpm ui:build

ui: deps ## Build the Control UI only
	pnpm ui:build

# ── Clean ─────────────────────────────────────────────────

clean: ## Remove dist, dist-runtime, and node_modules
	rm -rf dist dist-runtime node_modules

clean-dist: ## Remove build output only (keep node_modules)
	rm -rf dist dist-runtime

rebuild: clean-dist build ## Clean build output then rebuild everything

# ── Quality gates ─────────────────────────────────────────
# See AGENTS.md "Build, Test, and Development Commands" for
# the full gate definitions (local dev gate, landing gate, CI gate).

check: deps ## Local dev gate: lint + format + type-check
	pnpm check

typecheck: deps ## TypeScript type-check only
	pnpm tsgo

lint: deps ## Lint only (oxlint)
	pnpm lint

format: deps ## Check formatting (oxfmt --check)
	pnpm format:check

format-fix: deps ## Fix formatting (oxfmt --write)
	pnpm format:fix

# ── Tests ─────────────────────────────────────────────────

test: deps ## Run full test suite (vitest)
	pnpm test

test-fast: deps ## Run fast test subset
	pnpm test:fast

test-coverage: deps ## Run tests with coverage
	pnpm test:coverage

test-contracts: deps ## Run contract tests (plugins + channels)
	pnpm test:contracts

test-extensions: deps ## Run extension test suite
	pnpm test:extensions

test-channels: deps ## Run channel tests
	pnpm test:channels

# ── Development ───────────────────────────────────────────

dev: deps ## Run gateway in foreground (dev mode)
	pnpm dev

version: ## Print current version
	@node -e "console.log(require('./package.json').version)" 2>/dev/null || \
		git describe --tags HEAD 2>/dev/null || echo "unknown"

# ── Compound targets ──────────────────────────────────────

landing-gate: check test build ## Full landing gate (check + test + build)

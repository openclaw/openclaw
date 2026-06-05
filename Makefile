.PHONY: help build build-docker dev test test-fast test-e2e test-channels test-extensions check lint lint-fix format clean install update

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build the project (production)
	pnpm build

build-docker: ## Build Docker image
	docker build .

dev: ## Start development gateway with watch mode
	pnpm gateway:watch

test: ## Run all tests
	pnpm test

test-fast: ## Run fast unit tests only
	pnpm test:fast

test-e2e: ## Run end-to-end tests
	pnpm test:e2e

test-channels: ## Run channel-specific tests
	pnpm test:channels

test-extensions: ## Run extension tests
	pnpm test:extensions

check: ## Run all checks (types, lint, format)
	pnpm check

lint: ## Run linter
	pnpm lint

lint-fix: ## Run linter with auto-fix
	pnpm lint:fix

format: ## Format code
	pnpm format

clean: ## Clean build artifacts
	rm -rf dist/

install: ## Install dependencies
	pnpm install

update: ## Update dependencies
	pnpm update

.PHONY: install build global-install dev clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm install)
	pnpm install

build: ## Build the project (pnpm build)
	NODE_OPTIONS="--max-old-space-size=2048" pnpm build

global-install: build ## Build and install openclaw globally (copy, not symlink)
	npm pack --ignore-scripts --pack-destination /tmp
	sudo npm i -g --ignore-scripts --prefer-offline /tmp/openclaw-$$(node -p "require('./package.json').version").tgz

dev: ## Run in dev mode
	pnpm dev

clean: ## Remove build artifacts
	rm -rf dist

all: global-install ## Full pipeline: install deps, build, and install globally

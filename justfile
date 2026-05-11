# OpenClaw Developer Tasks
# Usage: just <task>
# See all tasks: just --list

# ── Core ──────────────────────────────────────────────

default:
    just --list

# Install dependencies
install:
    pnpm install

# Build production bundle
build:
    pnpm build

# Build strict smoke (includes plugin assets + import checks)
build:strict:
    pnpm build:strict-smoke

# Build Docker image
build:docker:
    pnpm build:docker

# ── Check / Lint / Format ────────────────────────────

# Run all checks (types + lint + format + more)
check:
    pnpm check

# Run type checker
types:
    pnpm tsgo

# Run ESLint
lint:
    pnpm lint

# Run ESLint with auto-fix
lint:fix:
    pnpm lint:fix

# Format code with Prettier
format:
    pnpm format

# Check formatting (CI mode)
format:check:
    pnpm format:check

# ── Test ──────────────────────────────────────────────

# Run all tests
test:
    pnpm test

# Run fast unit tests only
test:fast:
    pnpm test:fast

# Run E2E tests
test:e2e:
    pnpm test:e2e

# Run channel-specific tests
test:channels:
    pnpm test:channels

# Run extension tests
test:extensions:
    pnpm test:extensions

# Run tests for changed files only
test:changed:
    pnpm test:changed

# ── Development ───────────────────────────────────────

# Start gateway in watch mode
dev:
    pnpm gateway:watch

# Start gateway with debug logging
dev:debug:
    DEBUG=openclaw:* pnpm gateway:watch

# Generate base config schema
config:gen:
    pnpm config:docs:gen

# Bundle canvas A2UI assets
canvas:a2ui:
    pnpm canvas:a2ui:bundle

# ── Maintenance ───────────────────────────────────────

# Clean build artifacts
clean:
    rm -rf dist/

# Update dependencies
update:
    pnpm update

# Audit seams (code quality)
audit:
    pnpm audit:seams

# Check for conflict markers
check:markers:
    pnpm check:no-conflict-markers

# Check import cycles
check:cycles:
    pnpm check:import-cycles

# Check architecture smells
check:smells:
    pnpm check:architecture

# ── Plugin SDK ────────────────────────────────────────

# Build plugin SDK type declarations
plugin:sdk:dts:
    pnpm build:plugin-sdk:dts

# Build plugin SDK assets
plugin:assets:
    pnpm plugins:assets:build

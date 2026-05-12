# Justfile — Developer shortcuts for OpenClaw
# Recipe names use hyphens (not colons) because `just` parses `:` as a dependency separator.

# ===== Build =====

build:
  pnpm build

build-strict:
  pnpm build:strict-smoke

build-ci-artifacts:
  pnpm build:ci-artifacts

build-docker:
  pnpm build:docker

build-plugin-sdk-dts:
  pnpm build:plugin-sdk:dts

build-plugin-sdk-strict:
  pnpm build:plugin-sdk:strict-smoke

# ===== Test =====

test:
  pnpm test

test-changed:
  pnpm test:changed

test-strict:
  pnpm test:strict

test-coverage:
  pnpm test:coverage

# ===== Check =====

check:
  pnpm check

check-lint:
  pnpm check:lint

check-lint-fix:
  pnpm check:lint:fix

check-format:
  pnpm check:format

check-format-fix:
  pnpm check:format:fix

check-docs:
  pnpm check:docs

check-test-types:
  pnpm check:test-types

check-strict-smoke:
  pnpm check:strict-smoke

check-architecture:
  pnpm check:architecture

# ===== Dev =====

dev:
  pnpm dev

dev-gateway:
  pnpm dev:gateway

dev-ui:
  pnpm dev:ui

# ===== Maintenance =====

cleanup:
  pnpm cleanup

cleanup:deep
  pnpm cleanup:deep

audit:
  pnpm audit

audit-fix:
  pnpm audit:fix

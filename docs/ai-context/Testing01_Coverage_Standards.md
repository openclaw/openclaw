# Testing Coverage Standards

## Coverage Thresholds

MAIBOT enforces **70% minimum coverage** across:
- Lines
- Branches
- Functions
- Statements

Configuration: `vitest.config.js`

```javascript
coverage: {
  provider: 'v8',
  thresholds: {
    lines: 70,
    branches: 70,
    functions: 70,
    statements: 70
  }
}
```

## Test Commands

- **Quick test**: `pnpm test`
- **Coverage**: `pnpm test:coverage`
- **Live tests**: `CLAWDBOT_LIVE_TEST=1 pnpm test:live`
- **Docker E2E**: `pnpm test:docker:all`

## Testing Patterns

### Unit Tests
Test individual modules in isolation (src/**/*.test.ts)

### Integration Tests
Test multi-component interactions (src/gateway/*.test.ts)

### Live Tests
Test real channel interactions (require CLAWDBOT_LIVE_TEST=1)

### E2E Tests
Full system tests via Docker (test containers, real channels)

## Coverage Improvement Strategy

1. Run `pnpm test:coverage` to identify files below threshold
2. Add unit tests for uncovered branches
3. Use live tests for complex integration scenarios
4. Document intentional coverage exclusions

---

**References**:
- Vitest Config: vitest.config.js
- Test Files: src/**/*.test.ts
- E2E Setup: docker-compose.test.yml

*Last updated: 2026-01-30*


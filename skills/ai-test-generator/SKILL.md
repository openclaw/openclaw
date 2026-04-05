# AI Test Generator

Intelligent test generation for comprehensive code coverage with unit, integration, and E2E tests.

## Description

Use when: user asks to generate tests, improve test coverage, create unit tests, write integration tests, or automate testing.

NOT for: running tests, debugging test failures, or test infrastructure setup.

## Core Capabilities

### 1. Unit Test Generation
- Function-level testing with edge cases
- Class method testing with mocking
- Boundary value analysis
- Error handling verification
- Property-based test suggestions

### 2. Integration Test Generation
- API endpoint testing (REST/GraphQL)
- Database integration with fixtures
- Service integration patterns
- Event-driven architecture tests

### 3. Test Coverage Analysis
- Coverage gap detection
- Complexity-based prioritization
- Risk-based testing suggestions
- Mutation testing recommendations

## Supported Frameworks

| Language | Frameworks |
|----------|-----------|
| TypeScript/JavaScript | Jest, Vitest, Mocha, Playwright, Cypress |
| Python | pytest, unittest, hypothesis |
| Java | JUnit 5, TestNG, Mockito |
| Go | testing, testify, gomock |
| Rust | cargo test, proptest |

## Usage

```
Generate unit tests for calculateDiscount function
Create integration tests for /api/users endpoint
Analyze test coverage for src/services/
```

## Configuration

```yaml
skills:
  ai-test-generator:
    framework: vitest
    style: describe-it
    coverage:
      statements: 80
      branches: 75
```

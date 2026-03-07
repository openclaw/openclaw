---
name: "step-03b-subagent-backend"
description: "Subagent: Generate backend tests only (unit, integration, contract)"
subagent: true
outputFile: "/tmp/tea-automate-backend-tests-{{timestamp}}.json"
---

# Subagent 3B-backend: Generate Backend Tests

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with API test generation (and optionally E2E test generation for fullstack projects).

**What you have from parent workflow:**

- Target features/services identified in Step 2
- Knowledge fragments loaded: test-levels-framework, test-priorities-matrix, data-factories
- Config: test framework, detected stack type
- Coverage plan: which services/modules need backend testing

**Your task:** Generate backend tests ONLY (unit, integration, contract - not API endpoint tests, not E2E).

---

## MANDATORY EXECUTION RULES

- Read this entire subagent file before acting
- Generate backend tests ONLY (unit, integration, contract)
- Output structured JSON to temp file using the subagent output schema contract
- Follow knowledge fragment patterns
- Do NOT generate API endpoint tests (that's subagent 3A)
- Do NOT generate E2E tests (that's subagent 3B-E2E)
- Do NOT run tests (that's step 4)
- Do NOT generate fixtures yet (that's step 3C aggregation)

---

## SUBAGENT TASK

### 1. Identify Test Targets

From the coverage plan (Step 2 output), identify:

- Which services/modules need unit test coverage
- Which integrations need integration test coverage (database, message queues, external services)
- Which service contracts need contract test coverage (Pact, schema validation)
- Business logic functions requiring edge case coverage

### 2. Detect Framework & Language

From `config.test_framework` and project manifests, determine:

- **Python (pytest)**: Use `pytest` conventions, `conftest.py` fixtures, `@pytest.mark` decorators
- **Java/Kotlin (JUnit)**: Use JUnit 5 annotations (`@Test`, `@BeforeEach`, `@Nested`), Mockito for mocking
- **Go (go test)**: Use `*_test.go` files, `testing.T`, table-driven tests, `testify` assertions
- **C#/.NET (xUnit)**: Use `[Fact]`, `[Theory]`, `[InlineData]`, `Moq` for mocking
- **Ruby (RSpec)**: Use `describe`/`context`/`it` blocks, `let`/`before` helpers, `FactoryBot`

### 3. Generate Unit Tests

For each module/service, create test files following language-idiomatic patterns:

**Python (pytest) example:**

```python
import pytest
from unittest.mock import MagicMock, patch
from myapp.services.user_service import UserService

class TestUserService:
    """[P0] Unit tests for UserService"""

    def test_create_user_with_valid_data(self, user_factory):
        """Should create user when data is valid"""
        user_data = user_factory.build()
        result = UserService.create(user_data)
        assert result.email == user_data["email"]

    def test_create_user_rejects_duplicate_email(self, user_factory):
        """[P1] Should reject duplicate email"""
        user_data = user_factory.build(email="existing@test.com")
        with pytest.raises(DuplicateEmailError):
            UserService.create(user_data)
```

**Go (go test) example:**

```go
func TestUserService_Create(t *testing.T) {
    tests := []struct {
        name    string
        input   CreateUserInput
        wantErr bool
    }{
        {"valid user", validInput(), false},
        {"duplicate email", duplicateInput(), true},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            svc := NewUserService(mockRepo)
            _, err := svc.Create(tt.input)
            if (err != nil) != tt.wantErr {
                t.Errorf("Create() error = %v, wantErr %v", err, tt.wantErr)
            }
        })
    }
}
```

**Requirements:**

- Follow the detected framework's idiomatic test patterns
- Include priority tags [P0], [P1], [P2], [P3] in test descriptions
- Use proper mocking for external dependencies (database, APIs, message queues)
- Test both happy path and error cases
- Use proper typing/type hints where applicable
- No hard-coded test data; use factories or builders

### 4. Generate Integration Tests

For service integrations, create integration test files:

- Database integration tests (with test database or in-memory alternatives)
- Message queue consumer/producer tests
- Cache integration tests
- External service integration tests (with mocked HTTP clients)

### 5. Generate Contract Tests (if applicable)

If the project uses microservices or has defined API contracts:

- Pact consumer/provider tests
- Schema validation tests (JSON Schema, Protobuf)
- OpenAPI spec compliance tests

### 6. Track Fixture Needs

Identify fixtures/helpers needed for backend tests:

- Database fixtures (seed data, cleanup)
- Factory functions (test data builders)
- Mock services (HTTP mocks, message queue mocks)
- Configuration fixtures (test environment config)

**Do NOT create fixtures yet** - just track what's needed for aggregation step.

---

## OUTPUT FORMAT

Write JSON to temp file: `/tmp/tea-automate-backend-tests-{{timestamp}}.json`

```json
{
  "subagentType": "backend",
  "testsGenerated": [
    {
      "file": "tests/unit/test_user_service.py",
      "content": "[full test file content]",
      "description": "Unit tests for UserService",
      "priority_coverage": {
        "P0": 3,
        "P1": 2,
        "P2": 1,
        "P3": 0
      }
    },
    {
      "file": "tests/integration/test_user_repository.py",
      "content": "[full test file content]",
      "description": "Integration tests for user database operations",
      "priority_coverage": {
        "P0": 1,
        "P1": 2,
        "P2": 1,
        "P3": 0
      }
    }
  ],
  "coverageSummary": {
    "totalTests": 15,
    "testLevels": ["unit", "integration", "contract"],
    "fixtureNeeds": ["databaseFixture", "userFactory", "mockHttpClient"]
  },
  "status": "complete",
  "success": true,
  "subagent": "backend-tests",
  "knowledge_fragments_used": ["test-levels-framework", "test-priorities-matrix", "data-factories"],
  "summary": "Generated 15 backend test cases (10 unit, 4 integration, 1 contract)"
}
```

**On Error:**

```json
{
  "subagentType": "backend",
  "testsGenerated": [],
  "coverageSummary": {
    "totalTests": 0,
    "testLevels": [],
    "fixtureNeeds": []
  },
  "status": "partial",
  "success": false,
  "subagent": "backend-tests",
  "error": "Error message describing what went wrong",
  "partial_output": {
    /* any tests generated before error */
  }
}
```

---

## EXIT CONDITION

Subagent completes when:

- All identified modules have backend test files generated
- All tests follow language-idiomatic patterns
- JSON output written to temp file using the subagent output schema contract
- Fixture needs tracked

**Subagent terminates here.** Parent workflow will read output and proceed to aggregation.

---

## SUBAGENT SUCCESS METRICS

### SUCCESS:

- All backend tests generated following idiomatic patterns
- JSON output valid and complete, matches subagent output schema contract
- No E2E or browser tests included (out of scope)
- Proper mocking used for external dependencies
- Priority tags assigned to all test cases

### FAILURE:

- Generated tests other than backend tests (unit/integration/contract)
- Did not follow language-idiomatic patterns
- Invalid or missing JSON output
- Output schema does not match the contract
- Ran tests (not subagent responsibility)
- Used real external services instead of mocks

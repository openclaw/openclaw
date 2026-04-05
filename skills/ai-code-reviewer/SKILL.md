# AI Code Reviewer

An intelligent, AI-powered code review assistant that analyzes code quality, identifies bugs, suggests improvements, and enforces best practices across multiple programming languages.

## Description

Use when: user asks to review code, analyze code quality, find bugs, suggest improvements, check for security vulnerabilities, or enforce coding standards.

NOT for: generating new code from scratch (use coding-agent), deploying code, or running tests.

## Capabilities

### 1. Code Quality Analysis
- Detect code smells and anti-patterns
- Identify complexity issues (cyclomatic complexity, cognitive complexity)
- Find duplicate code blocks
- Analyze code maintainability

### 2. Bug Detection
- Null pointer / undefined reference checks
- Type mismatches and casting issues
- Resource leaks (memory, file handles, connections)
- Race conditions and concurrency issues
- Off-by-one errors and boundary conditions

### 3. Security Analysis
- SQL injection vulnerabilities
- XSS (Cross-Site Scripting) risks
- CSRF vulnerabilities
- Hardcoded credentials detection
- Insecure cryptographic practices
- Input validation gaps

### 4. Performance Analysis
- N+1 query detection
- Unnecessary re-renders (React/Vue)
- Memory leak patterns
- Inefficient algorithms
- Blocking operations in async contexts

### 5. Best Practices Enforcement
- Language-specific conventions (PEP8, ESLint rules, etc.)
- Documentation coverage
- Test coverage suggestions
- Error handling patterns
- Logging best practices

## Supported Languages

| Language | Support Level | Special Features |
|----------|--------------|------------------|
| TypeScript/JavaScript | ⭐⭐⭐ Full | React, Node.js, Vue patterns |
| Python | ⭐⭐⭐ Full | Django, FastAPI, async patterns |
| Java | ⭐⭐⭐ Full | Spring Boot, concurrency |
| Go | ⭐⭐ High | Goroutines, channels |
| Rust | ⭐⭐ High | Ownership, lifetimes |
| C/C++ | ⭐⭐ High | Memory safety |
| Ruby | ⭐⭐ High | Rails patterns |
| PHP | ⭐⭐ High | Laravel, security |
| Swift | ⭐⭐ High | iOS patterns |
| Kotlin | ⭐⭐ High | Android, coroutines |

## Usage Examples

### Basic Code Review
```
Review this code for bugs and improvements:

function fetchUser(id) {
  return fetch('/api/users/' + id)
    .then(r => r.json())
}
```

### Security-Focused Review
```
Check this authentication code for security issues:

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.query(`SELECT * FROM users WHERE username='${username}'`);
  // ...
});
```

### Performance Review
```
Analyze this React component for performance issues:

function UserList({ users }) {
  const [filtered, setFiltered] = useState([]);
  
  useEffect(() => {
    setFiltered(users.filter(u => u.active));
  }, [users]);
  
  return filtered.map(u => <UserCard key={u.id} user={u} />);
}
```

## Output Format

The skill provides structured feedback in the following format:

```markdown
## Code Review Summary

**Overall Score:** 7.5/10
**Risk Level:** Medium

### 🔴 Critical Issues (Must Fix)
1. [SECURITY] SQL Injection vulnerability at line 15
   - Current: `db.query(\`SELECT * FROM users WHERE id=${id}\`)`
   - Fix: Use parameterized queries
   - Impact: Data breach risk

### 🟡 Warnings (Should Fix)
1. [PERFORMANCE] N+1 query detected in loop at line 42
   - Consider batch fetching

### 🟢 Suggestions (Nice to Have)
1. [STYLE] Consider extracting magic number to constant
2. [DOCS] Add JSDoc for public function

### ✅ Positive Observations
- Good error handling in async functions
- Consistent naming conventions
- Well-structured module organization
```

## Configuration

Add to your `openclaw.yaml`:

```yaml
skills:
  ai-code-reviewer:
    severity_threshold: warning  # critical, warning, suggestion
    languages:
      - typescript
      - python
      - java
    custom_rules:
      - no-console-log
      - require-error-handling
    ignore_patterns:
      - "**/*.test.ts"
      - "**/generated/**"
```

## Integration with Git

The skill can automatically review:
- Staged changes before commit
- Pull request diffs
- Specific commits

```
Review my staged changes
Review PR #123
Review the last 3 commits
```

## API Reference

### `reviewCode(code: string, options?: ReviewOptions): Promise<ReviewResult>`

```typescript
interface ReviewOptions {
  language?: string;           // Auto-detected if not specified
  severity?: 'critical' | 'warning' | 'suggestion';
  focus?: ('security' | 'performance' | 'quality' | 'style')[];
  context?: string;            // Additional context about the code
  maxIssues?: number;          // Limit number of reported issues
}

interface ReviewResult {
  score: number;               // 0-10
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  issues: Issue[];
  positives: string[];
  summary: string;
  suggestions: Suggestion[];
}

interface Issue {
  id: string;
  severity: 'critical' | 'warning' | 'suggestion';
  category: string;
  message: string;
  line?: number;
  column?: number;
  fix?: string;
  impact?: string;
}
```

## Best Practices for Using This Skill

1. **Provide context**: Tell the skill what the code is supposed to do
2. **Specify focus areas**: If you're only concerned about security, say so
3. **Include dependencies**: Mention frameworks/libraries being used
4. **Iterative review**: Fix critical issues first, then re-review

## Limitations

- Cannot execute code (static analysis only)
- May miss runtime-specific issues
- Custom framework patterns may need explicit context
- Large files (>1000 lines) are analyzed in chunks

## Related Skills

- `coding-agent`: For writing new code
- `github`: For PR integration
- `security`: For deeper security audits

# OpenCode Workflow Examples

## Example 1: Complete Todo App Development

### Step 1: Project Discussion

**User Requirements:**

- React Todo app with TypeScript
- Local storage persistence
- Dark/light theme toggle
- Unit tests with Jest
- Responsive design
- Drag-and-drop reordering

### Step 2: Plan Mode (First Pass)

**Prompt to OpenCode:**

```
Create a comprehensive plan for a React Todo app with TypeScript that includes:
1. Project structure and file organization
2. Component architecture (smart vs dumb components)
3. State management approach (Context API vs Redux)
4. Local storage implementation strategy
5. Theme system architecture
6. Testing strategy (unit, integration, E2E)
7. Responsive design approach
8. Drag-and-drop implementation plan
```

**Expected Plan Output:**

- Detailed file structure
- Component hierarchy
- State management design
- API design (if applicable)
- Testing architecture
- Build/deployment strategy

### Step 3: Plan Verification

**Checklist:**

- [ ] All user requirements addressed
- [ ] Architecture aligns with React best practices
- [ ] Testing strategy covers all components
- [ ] Local storage implementation is robust
- [ ] Theme system is extensible
- [ ] Drag-and-drop solution is appropriate

### Step 4: Testing Planning

**Prompt to OpenCode:**

```
Create a rigorous testing strategy for the Todo app that includes:
1. Unit tests for each component (coverage > 90%)
2. Integration tests for user flows
3. Edge cases (empty state, maximum todos, special characters)
4. Performance testing strategy
5. Accessibility testing (WCAG compliance)
6. Cross-browser testing approach
```

### Step 5: Build Mode Implementation

**Prompt to OpenCode:**

```
Implement the Todo app according to the approved plan. Start with:
1. Project setup (package.json, tsconfig, etc.)
2. Core component structure
3. State management implementation
4. Local storage integration
5. Basic styling and layout
```

### Step 6: GitHub Workflow

```bash
# Initialize git
./scripts/github_workflow.sh init "Initial commit: React Todo App"

# Create GitHub repository
./scripts/github_workflow.sh create-repo

# After feature implementation
./scripts/github_workflow.sh commit "feat: add drag-and-drop functionality"
./scripts/github_workflow.sh push
```

## Example 2: API Integration Project

### Step 1: Project Discussion

**User Requirements:**

- Weather dashboard app
- Integration with OpenWeatherMap API
- City search with autocomplete
- 5-day forecast display
- Historical data visualization
- Caching strategy for API calls

### Step 2: Plan Mode

**Prompt to OpenCode:**

```
Create a detailed plan for a weather dashboard app that:
1. Integrates with OpenWeatherMap API
2. Implements city search with debounced autocomplete
3. Displays current weather and 5-day forecast
4. Shows historical data trends
5. Implements efficient API caching
6. Includes error handling for API failures
7. Has responsive visualization components
```

### Step 3: Testing Planning

**Prompt to OpenCode:**

```
Design comprehensive tests for the weather app including:
1. Mock API responses for testing
2. Unit tests for data transformation functions
3. Integration tests for API calls
4. Error handling tests
5. Performance tests for caching
6. Visual regression tests for components
```

## Example 3: E-commerce Platform Feature

### Step 1: Project Discussion

**User Requirements:**

- Shopping cart functionality
- Product filtering and sorting
- User authentication
- Payment integration (Stripe)
- Order management system
- Admin dashboard

### Step 2: Plan Mode (Iterative)

**First Iteration - Cart System:**

```
Plan the shopping cart system with:
1. Cart state management
2. Persistent cart storage
3. Cart operations (add, remove, update quantity)
4. Cart summary calculations
5. Cart validation rules
```

**Second Iteration - Product Filtering:**

```
Plan the product filtering system with:
1. Filter state management
2. Dynamic filter generation
3. URL-based filter persistence
4. Performance optimization for large catalogs
```

## Example 4: Bug Fix Workflow

### Step 1: Issue Analysis

**User Report:**
"App crashes when adding special characters to todo items"

### Step 2: Plan Mode (Debugging)

**Prompt to OpenCode:**

```
Analyze the todo app codebase and:
1. Identify potential causes for the crash with special characters
2. Create a debugging plan to reproduce and fix the issue
3. Plan regression tests to prevent future similar issues
```

### Step 3: Testing Planning

**Prompt to OpenCode:**

```
Create specific tests for the special characters bug:
1. Test cases for various special characters
2. Edge cases (emoji, unicode, HTML entities)
3. Input sanitization strategy
4. Error boundary implementation
```

### Step 4: Build Mode (Fix)

**Prompt to OpenCode:**

```
Implement the fix for the special characters bug based on the analysis:
1. Apply input sanitization
2. Add error boundaries
3. Update validation logic
4. Add comprehensive tests
```

### Step 5: GitHub Workflow

```bash
./scripts/github_workflow.sh commit "fix: handle special characters in todo items"
./scripts/github_workflow.sh push
```

## Example 5: Performance Optimization

### Step 1: Performance Analysis

**User Requirement:**
"App feels slow when displaying 1000+ todo items"

### Step 2: Plan Mode (Optimization)

**Prompt to OpenCode:**

```
Analyze the todo app performance and:
1. Identify performance bottlenecks
2. Plan optimization strategies (virtualization, memoization, etc.)
3. Design performance monitoring
4. Create A/B testing plan for optimizations
```

### Step 3: Testing Planning

**Prompt to OpenCode:**

```
Create performance testing strategy:
1. Load testing with large datasets
2. Memory usage profiling
3. Render performance measurements
4. Comparative benchmarks
```

## Best Practices for Each Step

### Step 1 (Discussion) Best Practices:

- Be specific about requirements
- Define success criteria
- Consider edge cases upfront
- Discuss scalability requirements
- Agree on technology constraints

### Step 2 (Plan Mode) Best Practices:

- Break large projects into phases
- Request architecture diagrams
- Ask for alternative approaches
- Validate technical feasibility
- Consider maintenance costs

### Step 3 (Verification) Best Practices:

- Compare against original requirements
- Check for technical debt
- Validate testing coverage
- Review security implications
- Assess performance impact

### Step 4 (Testing) Best Practices:

- Test edge cases aggressively
- Include performance testing
- Plan for regression testing
- Consider user acceptance testing
- Include monitoring strategy

### Step 5 (Build) Best Practices:

- Implement in small increments
- Test each increment
- Maintain code quality standards
- Document as you go
- Review before moving forward

### Step 6 (GitHub) Best Practices:

- Use descriptive commit messages
- Follow conventional commits
- Keep commits focused
- Push regularly
- Use pull requests for review

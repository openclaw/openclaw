# Codebase Analysis for Feature Planning

**Feature:** $ARGUMENTS

## Mission

Perform comprehensive codebase analysis to support PRP creation. This analysis provides the foundation for creating high-quality PRPs by understanding existing patterns, architecture, and potential gotchas.

## Analysis Process

### Phase 1: Structure Discovery

**Objective:** Map the project layout and understand the overall architecture.

1. **Project Layout Analysis**
   - Run `tree -L 3 -I 'node_modules|.git|dist|build|__pycache__|.next'` if available, otherwise use `ls -la` or equivalent directory listing
   - Identify entry points (main files, index files, app entry points)
   - Locate configuration files (package.json, pyproject.toml, tsconfig.json, foundry.toml, etc.)
   - Map the directory organization pattern (feature-based, layer-based, etc.)

2. **Configuration Review**
   - Read CLAUDE.md if it exists for project context
   - Review README.md for project documentation
   - Check environment configuration patterns (.env.example, config files)

3. **Dependency Analysis**
   - Identify key dependencies and their versions
   - Note any version constraints or compatibility requirements
   - Document external service integrations

### Phase 2: Feature-Specific Research

**Objective:** Find existing patterns and implementations relevant to the requested feature.

1. **Pattern Search**
   - Search for similar features or patterns by searching the codebase
   - Identify 2-3 reference implementations to follow
   - Note naming conventions used throughout the project

2. **Code Pattern Documentation**
   ```yaml
   patterns_found:
     - pattern_name: [name]
       location: [file:line]
       description: [how it works]
       relevance: [why it matters for this feature]
   ```

3. **Existing Conventions**
   - File naming conventions
   - Function/method naming patterns
   - Import/export patterns
   - Error handling approaches
   - Testing patterns

### Phase 3: Architecture Analysis

**Objective:** Understand how components interact and where new code should fit.

1. **Component Structure**
   - Map component/module relationships
   - Identify shared utilities and where they live
   - Document the data flow patterns

2. **API/Interface Patterns**
   - Internal API conventions
   - External API integrations
   - Data validation approaches

3. **State Management**
   - How state is managed (context, stores, hooks, etc.)
   - Data persistence patterns
   - Caching strategies

### Phase 4: Gotchas & Recommendations

**Objective:** Identify potential pitfalls and provide actionable guidance.

1. **Known Pitfalls**
   - Areas of technical debt
   - Non-obvious configurations
   - Environment-specific behaviors
   - Performance bottlenecks

2. **Best Practices to Follow**
   - Project-specific coding standards
   - Required testing approaches
   - Documentation requirements

3. **Implementation Recommendations**
   ```yaml
   recommendations:
     must_follow:
       - [critical patterns/conventions]
     should_follow:
       - [recommended approaches]
     avoid:
       - [anti-patterns in this codebase]
   ```

## Output

Create the analysis file at: `PRPs/planning/{feature-name}-analysis.md`

### Output Structure

```markdown
# Codebase Analysis: {Feature Name}

## Executive Summary
[2-3 sentences summarizing key findings for PRP creation]

## Project Structure
[Directory tree and key file locations]

## Relevant Patterns Found
[Existing implementations to reference]

## Architecture Insights
[Component relationships and data flow]

## Implementation Guidance
### Must Follow
- [Critical requirements]

### Recommended Approach
- [Suggested patterns]

### Avoid
- [Anti-patterns and pitfalls]

## Files to Reference
[Specific files the PRP should reference with line numbers]

## Validation Commands
[Project-specific commands for testing]
```

## Quality Gates

Before completing, verify:
- [ ] Project structure is fully mapped
- [ ] At least 2 reference implementations identified
- [ ] Naming conventions documented
- [ ] Error handling patterns noted
- [ ] Testing patterns identified
- [ ] Validation commands are project-specific and verified working
- [ ] Output saved to PRPs/planning/{feature-name}-analysis.md

## Usage

This process can be invoked:
1. **Directly**: As a standalone codebase analysis task
2. **Via generate-prp**: Referenced during PRP generation
3. **As a sub-agent**: Spawned for parallel research by the orchestrator

The analysis output feeds directly into PRP creation, providing the context needed for one-pass implementation success.

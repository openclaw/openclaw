# Workflow: Create Exhaustive Domain Expertise Skill

<objective>
Build a comprehensive execution skill that does real work in a specific domain. Domain expertise skills are full-featured build skills with exhaustive domain knowledge in references, complete workflows for the full lifecycle (build → debug → optimize → ship), and can be both invoked directly by users AND loaded by other skills (like create-plans) for domain knowledge.
</objective>

<critical_distinction>
**Regular skill:** "Do one specific task"
**Domain expertise skill:** "Do EVERYTHING in this domain, with complete practitioner knowledge"

Examples:
- `expertise/macos-apps` - Build macOS apps from scratch through shipping
- `expertise/python-games` - Build complete Python games with full game dev lifecycle
- `expertise/rust-systems` - Build Rust systems programs with exhaustive systems knowledge
- `expertise/web-scraping` - Build scrapers, handle all edge cases, deploy at scale

Domain expertise skills:
- ✅ Execute tasks (build, debug, optimize, ship)
- ✅ Have comprehensive domain knowledge in references
- ✅ Are invoked directly by users ("build a macOS app")
- ✅ Can be loaded by other skills (create-plans reads references for planning)
- ✅ Cover the FULL lifecycle, not just getting started
</critical_distinction>

<required_reading>
**Read these reference files NOW:**
1. references/recommended-structure.md
2. references/core-principles.md
3. references/use-xml-tags.md
</required_reading>

<process>
## Step 1: Identify Domain

Ask user what domain expertise to build:

**Example domains:**
- macOS/iOS app development
- Python game development
- Rust systems programming
- Machine learning / AI
- Web scraping and automation
- Data engineering pipelines
- Audio processing / DSP
- 3D graphics / shaders
- Unity/Unreal game development
- Embedded systems

Get specific: "Python games" or "Python games with Pygame specifically"?

## Step 2: Confirm Target Location

Explain:
```
Domain expertise skills go in: ~/.openclaw/skills/expertise/{domain-name}/

These are comprehensive BUILD skills that:
- Execute tasks (build, debug, optimize, ship)
- Contain exhaustive domain knowledge
- Can be invoked directly by users
- Can be loaded by other skills for domain knowledge

Name suggestion: {suggested-name}
Location: ~/.openclaw/skills/expertise/{suggested-name}/
```

Confirm or adjust name.

## Step 3: Identify Workflows

Domain expertise skills cover the FULL lifecycle. Identify what workflows are needed.

**Common workflows for most domains:**
1. **build-new-{thing}.md** - Create from scratch
2. **add-feature.md** - Extend existing {thing}
3. **debug-{thing}.md** - Find and fix bugs
4. **write-tests.md** - Test for correctness
5. **optimize-performance.md** - Profile and speed up
6. **ship-{thing}.md** - Deploy/distribute

**Domain-specific workflows:**
- Games: `implement-game-mechanic.md`, `add-audio.md`, `polish-ui.md`
- Web apps: `setup-auth.md`, `add-api-endpoint.md`, `setup-database.md`
- Systems: `optimize-memory.md`, `profile-cpu.md`, `cross-compile.md`

Each workflow = one complete task type that users actually do.

## Step 4: Exhaustive Research Phase

**CRITICAL:** This research must be comprehensive, not superficial.

### Research Strategy

Run multiple web searches to ensure coverage:

**Search 1: Current ecosystem**
- "best {domain} libraries 2024 2025 2026"
- "popular {domain} frameworks comparison"
- "{domain} tech stack recommendations"

**Search 2: Architecture patterns**
- "{domain} architecture patterns"
- "{domain} best practices design patterns"
- "how to structure {domain} projects"

**Search 3: Lifecycle and tooling**
- "{domain} development workflow"
- "{domain} testing debugging best practices"
- "{domain} deployment distribution"

**Search 4: Common pitfalls**
- "{domain} common mistakes avoid"
- "{domain} anti-patterns"
- "what not to do {domain}"

**Search 5: Real-world usage**
- "{domain} production examples GitHub"
- "{domain} case studies"
- "successful {domain} projects"

### Verification Requirements

For EACH major library/tool/pattern found:
- **Check recency:** When was it last updated?
- **Check adoption:** Is it actively maintained? Community size?
- **Check alternatives:** What else exists? When to use each?
- **Check deprecation:** Is anything being replaced?

**Red flags for outdated content:**
- Articles from before 2023 (unless fundamental concepts)
- Abandoned libraries (no commits in 12+ months)
- Deprecated APIs or patterns
- "This used to be popular but..."

### Documentation Sources

Use Context7 MCP when available:
```
mcp__context7__resolve-library-id: {library-name}
mcp__context7__get-library-docs: {library-id}
```

Focus on official docs, not tutorials.

## Step 5: Organize Knowledge Into Domain Areas

Structure references by domain concerns, NOT by arbitrary categories.

**For game development example:**
```
references/
├── architecture.md         # ECS, component-based, state machines
├── libraries.md           # Pygame, Arcade, Panda3D (when to use each)
├── graphics-rendering.md  # 2D/3D rendering, sprites, shaders
├── physics.md             # Collision, physics engines
├── audio.md               # Sound effects, music, spatial audio
├── input.md               # Keyboard, mouse, gamepad, touch
├── ui-menus.md            # HUD, menus, dialogs
├── game-loop.md           # Update/render loop, fixed timestep
├── state-management.md    # Game states, scene management
├── networking.md          # Multiplayer, client-server, P2P
├── asset-pipeline.md      # Loading, caching, optimization
├── testing-debugging.md   # Unit tests, profiling, debugging tools
├── performance.md         # Optimization, profiling, benchmarking
├── packaging.md           # Building executables, installers
├── distribution.md        # Steam, itch.io, app stores
└── anti-patterns.md       # Common mistakes, what NOT to do
```

**For macOS app development example:**
```
references/
├── app-architecture.md     # State management, dependency injection
├── swiftui-patterns.md     # Declarative UI patterns
├── appkit-integration.md   # Using AppKit with SwiftUI
├── concurrency-patterns.md # Async/await, actors, structured concurrency
├── data-persistence.md     # Storage strategies
├── networking.md           # URLSession, async networking
├── system-apis.md          # macOS-specific frameworks
├── testing-tdd.md          # Testing patterns
├── testing-debugging.md    # Debugging tools and techniques
├── performance.md          # Profiling, optimization
├── design-system.md        # Platform conventions
├── macos-polish.md         # Native feel, accessibility
├── security-code-signing.md # Signing, notarization
└── project-scaffolding.md  # CLI-based setup
```

**For each reference file:**
- Pure XML structure
- Decision trees: "If X, use Y. If Z, use A instead."
- Comparison tables: Library vs Library (speed, features, learning curve)
- Code examples showing patterns
- "When to use" guidance
- Platform-specific considerations
- Current versions and compatibility

## Step 6: Create SKILL.md

Domain expertise skills use router pattern with essential principles:

```yaml
---
name: build-{domain-name}
description: Build {domain things} from scratch through shipping. Full lifecycle - build, debug, test, optimize, ship. {Any specific constraints like "CLI-only, no IDE"}.
---

<essential_principles>
## How {This Domain} Works

{Domain-specific principles that ALWAYS apply}

### 1. {First Principle}
{Critical practice that can't be skipped}

### 2. {Second Principle}
{Another fundamental practice}

### 3. {Third Principle}
{Core workflow pattern}
</essential_principles>

<intake>
**Ask the user:**

What would you like to do?
1. Build a new {thing}
2. Debug an existing {thing}
3. Add a feature
4. Write/run tests
5. Optimize performance
6. Ship/release
7. Something else

**Then read the matching workflow from `workflows/` and follow it.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "new", "create", "build", "start" | `workflows/build-new-{thing}.md` |
| 2, "broken", "fix", "debug", "crash", "bug" | `workflows/debug-{thing}.md` |
| 3, "add", "feature", "implement", "change" | `workflows/add-feature.md` |
| 4, "test", "tests", "TDD", "coverage" | `workflows/write-tests.md` |
| 5, "slow", "optimize", "performance", "fast" | `workflows/optimize-performance.md` |
| 6, "ship", "release", "deploy", "publish" | `workflows/ship-{thing}.md` |
| 7, other | Clarify, then select workflow or references |
</routing>

<verification_loop>
## After Every Change

{Domain-specific verification steps}

Example for compiled languages:
```bash
# 1. Does it build?
{build command}

# 2. Do tests pass?
{test command}

# 3. Does it run?
{run command}
```

Report to the user:
- "Build: ✓"
- "Tests: X pass, Y fail"
- "Ready for you to check [specific thing]"
</verification_loop>

<reference_index>
## Domain Knowledge

All in `references/`:

**Architecture:** {list files}
**{Domain Area}:** {list files}
**{Domain Area}:** {list files}
**Development:** {list files}
**Shipping:** {list files}
</reference_index>

<workflows_index>
## Workflows

All in `workflows/`:

| File | Purpose |
|------|---------|
| build-new-{thing}.md | Create new {thing} from scratch |
| debug-{thing}.md | Find and fix bugs |
| add-feature.md | Add to existing {thing} |
| write-tests.md | Write and run tests |
| optimize-performance.md | Profile and speed up |
| ship-{thing}.md | Deploy/distribute |
</workflows_index>
```

## Step 7: Write Workflows

For EACH workflow identified in Step 3:

### Workflow Template

```markdown
# Workflow: {Workflow Name}

<required_reading>
**Read these reference files NOW before {doing the task}:**
1. references/{relevant-file}.md
2. references/{another-relevant-file}.md
3. references/{third-relevant-file}.md
</required_reading>

<process>
## Step 1: {First Action}

{What to do}

## Step 2: {Second Action}

{What to do - actual implementation steps}

## Step 3: {Third Action}

{What to do}

## Step 4: Verify

{How to prove it works}

```bash
{verification commands}
```
</process>

<anti_patterns>
Avoid:
- {Common mistake 1}
- {Common mistake 2}
- {Common mistake 3}
</anti_patterns>

<success_criteria>
A well-{completed task}:
- {Criterion 1}
- {Criterion 2}
- {Criterion 3}
- Builds/runs without errors
- Tests pass
- Feels {native/professional/correct}
</success_criteria>
```

**Key workflow characteristics:**
- Starts with required_reading (which references to load)
- Contains actual implementation steps (not just "read references")
- Includes verification steps
- Has success criteria
- Documents anti-patterns

## Step 8: Write Comprehensive References

For EACH reference file identified in Step 5:

### Structure Template

```xml
<overview>
Brief introduction to this domain area
</overview>

<options>
## Available Approaches/Libraries

<option name="Library A">
**When to use:** [specific scenarios]
**Strengths:** [what it's best at]
**Weaknesses:** [what it's not good for]
**Current status:** v{version}, actively maintained
**Learning curve:** [easy/medium/hard]

```code
# Example usage
```
</option>

<option name="Library B">
[Same structure]
</option>
</options>

<decision_tree>
## Choosing the Right Approach

**If you need [X]:** Use [Library A]
**If you need [Y]:** Use [Library B]
**If you have [constraint Z]:** Use [Library C]

**Avoid [Library D] if:** [specific scenarios]
</decision_tree>

<patterns>
## Common Patterns

<pattern name="Pattern Name">
**Use when:** [scenario]
**Implementation:** [code example]
**Considerations:** [trade-offs]
</pattern>
</patterns>

<anti_patterns>
## What NOT to Do

<anti_pattern name="Common Mistake">
**Problem:** [what people do wrong]
**Why it's bad:** [consequences]
**Instead:** [correct approach]
</anti_pattern>
</anti_patterns>

<platform_considerations>
## Platform-Specific Notes

**Windows:** [considerations]
**macOS:** [considerations]
**Linux:** [considerations]
**Mobile:** [if applicable]
</platform_considerations>
```

### Quality Standards

Each reference must include:
- **Current information** (verify dates)
- **Multiple options** (not just one library)
- **Decision guidance** (when to use each)
- **Real examples** (working code, not pseudocode)
- **Trade-offs** (no silver bullets)
- **Anti-patterns** (what NOT to do)

### Common Reference Files

Most domains need:
- **architecture.md** - How to structure projects
- **libraries.md** - Ecosystem overview with comparisons
- **patterns.md** - Design patterns specific to domain
- **testing-debugging.md** - How to verify correctness
- **performance.md** - Optimization strategies
- **deployment.md** - How to ship/distribute
- **anti-patterns.md** - Common mistakes consolidated

## Step 9: Validate Completeness

### Completeness Checklist

Ask: "Could a user build a professional {domain thing} from scratch through shipping using just this skill?"

**Must answer YES to:**
- [ ] All major libraries/frameworks covered?
- [ ] All architectural approaches documented?
- [ ] Complete lifecycle addressed (build → debug → test → optimize → ship)?
- [ ] Platform-specific considerations included?
- [ ] "When to use X vs Y" guidance provided?
- [ ] Common pitfalls documented?
- [ ] Current as of 2024-2026?
- [ ] Workflows actually execute tasks (not just reference knowledge)?
- [ ] Each workflow specifies which references to read?

**Specific gaps to check:**
- [ ] Testing strategy covered?
- [ ] Debugging/profiling tools listed?
- [ ] Deployment/distribution methods documented?
- [ ] Performance optimization addressed?
- [ ] Security considerations (if applicable)?
- [ ] Asset/resource management (if applicable)?
- [ ] Networking (if applicable)?

### Dual-Purpose Test

Test both use cases:

**Direct invocation:** "Can a user invoke this skill and build something?"
- Intake routes to appropriate workflow
- Workflow loads relevant references
- Workflow provides implementation steps
- Success criteria are clear

**Knowledge reference:** "Can create-plans load references to plan a project?"
- References contain decision guidance
- All options compared
- Complete lifecycle covered
- Architecture patterns documented

## Step 10: Create Directory and Files

```bash
# Create structure
mkdir -p ~/.openclaw/skills/expertise/{domain-name}
mkdir -p ~/.openclaw/skills/expertise/{domain-name}/workflows
mkdir -p ~/.openclaw/skills/expertise/{domain-name}/references

# Write SKILL.md
# Write all workflow files
# Write all reference files

# Verify structure
ls -R ~/.openclaw/skills/expertise/{domain-name}
```

## Step 11: Document in create-plans

Update `~/.openclaw/skills/create-plans/SKILL.md` to reference this new domain:

Add to the domain inference table:
```markdown
| "{keyword}", "{domain term}" | expertise/{domain-name} |
```

So create-plans can auto-detect and offer to load it.

## Step 12: Final Quality Check

Review entire skill:

**SKILL.md:**
- [ ] Name matches directory (build-{domain-name})
- [ ] Description explains it builds things from scratch through shipping
- [ ] Essential principles inline (always loaded)
- [ ] Intake asks what user wants to do
- [ ] Routing maps to workflows
- [ ] Reference index complete and organized
- [ ] Workflows index complete

**Workflows:**
- [ ] Each workflow starts with required_reading
- [ ] Each workflow has actual implementation steps
- [ ] Each workflow has verification steps
- [ ] Each workflow has success criteria
- [ ] Workflows cover full lifecycle (build, debug, test, optimize, ship)

**References:**
- [ ] Pure XML structure (no markdown headings)
- [ ] Decision guidance in every file
- [ ] Current versions verified
- [ ] Code examples work
- [ ] Anti-patterns documented
- [ ] Platform considerations included

**Completeness:**
- [ ] A professional practitioner would find this comprehensive
- [ ] No major libraries/patterns missing
- [ ] Full lifecycle covered
- [ ] Passes the "build from scratch through shipping" test
- [ ] Can be invoked directly by users
- [ ] Can be loaded by create-plans for knowledge

</process>

<success_criteria>
Domain expertise skill is complete when:

- [ ] Comprehensive research completed (5+ web searches)
- [ ] All sources verified for recency (2024-2026)
- [ ] Knowledge organized by domain areas (not arbitrary)
- [ ] Essential principles in SKILL.md (always loaded)
- [ ] Intake routes to appropriate workflows
- [ ] Each workflow has required_reading + implementation steps + verification
- [ ] Each reference has decision trees and comparisons
- [ ] Anti-patterns documented throughout
- [ ] Full lifecycle covered (build → debug → test → optimize → ship)
- [ ] Platform-specific considerations included
- [ ] Located in ~/.openclaw/skills/expertise/{domain-name}/
- [ ] Referenced in create-plans domain inference table
- [ ] Passes dual-purpose test: Can be invoked directly AND loaded for knowledge
- [ ] User can build something professional from scratch through shipping
</success_criteria>

<anti_patterns>
**DON'T:**
- Copy tutorial content without verification
- Include only "getting started" material
- Skip the "when NOT to use" guidance
- Forget to check if libraries are still maintained
- Organize by document type instead of domain concerns
- Make it knowledge-only with no execution workflows
- Skip verification steps in workflows
- Include outdated content from old blog posts
- Skip decision trees and comparisons
- Create workflows that just say "read the references"

**DO:**
- Verify everything is current
- Include complete lifecycle (build → ship)
- Provide decision guidance
- Document anti-patterns
- Make workflows execute real tasks
- Start workflows with required_reading
- Include verification in every workflow
- Make it exhaustive, not minimal
- Test both direct invocation and knowledge reference use cases
</anti_patterns>

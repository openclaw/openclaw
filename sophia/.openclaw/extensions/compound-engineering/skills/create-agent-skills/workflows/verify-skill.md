# Workflow: Verify Skill Content Accuracy

<required_reading>
**Read these reference files NOW:**
1. references/skill-structure.md
</required_reading>

<purpose>
Audit checks structure. **Verify checks truth.**

Skills contain claims about external things: APIs, CLI tools, frameworks, services. These change over time. This workflow checks if a skill's content is still accurate.
</purpose>

<process>
## Step 1: Select the Skill

```bash
ls ~/.openclaw/skills/
```

Present numbered list, ask: "Which skill should I verify for accuracy?"

## Step 2: Read and Categorize

Read the entire skill (SKILL.md + workflows/ + references/):
```bash
cat ~/.openclaw/skills/{skill-name}/SKILL.md
cat ~/.openclaw/skills/{skill-name}/workflows/*.md 2>/dev/null
cat ~/.openclaw/skills/{skill-name}/references/*.md 2>/dev/null
```

Categorize by primary dependency type:

| Type | Examples | Verification Method |
|------|----------|---------------------|
| **API/Service** | manage-stripe, manage-gohighlevel | Context7 + WebSearch |
| **CLI Tools** | build-macos-apps (xcodebuild, swift) | Run commands |
| **Framework** | build-iphone-apps (SwiftUI, UIKit) | Context7 for docs |
| **Integration** | setup-stripe-payments | WebFetch + Context7 |
| **Pure Process** | create-agent-skills | No external deps |

Report: "This skill is primarily [type]-based. I'll verify using [method]."

## Step 3: Extract Verifiable Claims

Scan skill content and extract:

**CLI Tools mentioned:**
- Tool names (xcodebuild, swift, npm, etc.)
- Specific flags/options documented
- Expected output patterns

**API Endpoints:**
- Service names (Stripe, Meta, etc.)
- Specific endpoints documented
- Authentication methods
- SDK versions

**Framework Patterns:**
- Framework names (SwiftUI, React, etc.)
- Specific APIs/patterns documented
- Version-specific features

**File Paths/Structures:**
- Expected project structures
- Config file locations

Present: "Found X verifiable claims to check."

## Step 4: Verify by Type

### For CLI Tools
```bash
# Check tool exists
which {tool-name}

# Check version
{tool-name} --version

# Verify documented flags work
{tool-name} --help | grep "{documented-flag}"
```

### For API/Service Skills
Use Context7 to fetch current documentation:
```
mcp__context7__resolve-library-id: {service-name}
mcp__context7__get-library-docs: {library-id}, topic: {relevant-topic}
```

Compare skill's documented patterns against current docs:
- Are endpoints still valid?
- Has authentication changed?
- Are there deprecated methods being used?

### For Framework Skills
Use Context7:
```
mcp__context7__resolve-library-id: {framework-name}
mcp__context7__get-library-docs: {library-id}, topic: {specific-api}
```

Check:
- Are documented APIs still current?
- Have patterns changed?
- Are there newer recommended approaches?

### For Integration Skills
WebSearch for recent changes:
```
"[service name] API changes 2026"
"[service name] breaking changes"
"[service name] deprecated endpoints"
```

Then Context7 for current SDK patterns.

### For Services with Status Pages
WebFetch official docs/changelog if available.

## Step 5: Generate Freshness Report

Present findings:

```
## Verification Report: {skill-name}

### ✅ Verified Current
- [Claim]: [Evidence it's still accurate]

### ⚠️ May Be Outdated
- [Claim]: [What changed / newer info found]
  → Current: [what docs now say]

### ❌ Broken / Invalid
- [Claim]: [Why it's wrong]
  → Fix: [What it should be]

### ℹ️ Could Not Verify
- [Claim]: [Why verification wasn't possible]

---
**Overall Status:** [Fresh / Needs Updates / Significantly Stale]
**Last Verified:** [Today's date]
```

## Step 6: Offer Updates

If issues found:

"Found [N] items that need updating. Would you like me to:"

1. **Update all** - Apply all corrections
2. **Review each** - Show each change before applying
3. **Just the report** - No changes

If updating:
- Make changes based on verified current information
- Add verification date comment if appropriate
- Report what was updated

## Step 7: Suggest Verification Schedule

Based on skill type, recommend:

| Skill Type | Recommended Frequency |
|------------|----------------------|
| API/Service | Every 1-2 months |
| Framework | Every 3-6 months |
| CLI Tools | Every 6 months |
| Pure Process | Annually |

"This skill should be re-verified in approximately [timeframe]."
</process>

<verification_shortcuts>
## Quick Verification Commands

**Check if CLI tool exists and get version:**
```bash
which {tool} && {tool} --version
```

**Context7 pattern for any library:**
```
1. resolve-library-id: "{library-name}"
2. get-library-docs: "{id}", topic: "{specific-feature}"
```

**WebSearch patterns:**
- Breaking changes: "{service} breaking changes 2026"
- Deprecations: "{service} deprecated API"
- Current best practices: "{framework} best practices 2026"
</verification_shortcuts>

<success_criteria>
Verification is complete when:
- [ ] Skill categorized by dependency type
- [ ] Verifiable claims extracted
- [ ] Each claim checked with appropriate method
- [ ] Freshness report generated
- [ ] Updates applied (if requested)
- [ ] User knows when to re-verify
</success_criteria>

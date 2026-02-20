---
name: visual-verify
description: Autonomous closed-loop visual verification of websites. Captures screenshots, analyzes layout/CSS/responsiveness, identifies issues, and can auto-fix. No human in loop.
---

# Visual Verification Skill

Autonomous AI-driven visual testing for websites and cloud applications.

## Capabilities

1. **Capture** - Screenshots at multiple viewports (mobile/tablet/desktop)
2. **Analyze** - Vision AI assessment of layout, alignment, CSS, responsiveness
3. **Compare** - Cross-page element consistency (positions, sizes, centering)
4. **Report** - Structured findings with severity levels
5. **Fix** - Auto-correct CSS/layout issues when possible

## Tools Required

| Tool             | Purpose             | Check                      |
| ---------------- | ------------------- | -------------------------- |
| `npx playwright` | Screenshot capture  | `npx playwright --version` |
| `lynx`           | Text structure dump | `which lynx`               |
| `image` tool     | Vision analysis     | Built-in                   |
| `exec`           | Command execution   | Built-in                   |

## Procedure

### 1. Capture Phase

```bash
# Desktop (1280x800)
npx playwright screenshot "$URL" /tmp/site-desktop.png --viewport-size=1280,800

# Tablet (768x1024)
npx playwright screenshot "$URL" /tmp/site-tablet.png --viewport-size=768,1024

# Mobile (375x812)
npx playwright screenshot "$URL" /tmp/site-mobile.png --viewport-size=375,812

# Text structure
lynx -dump -width=80 "$URL" > /tmp/site-text.txt
```

### 2. DOM Position Capture (for cross-page comparison)

```javascript
// Run with: npx playwright evaluate "$URL" "script"
const elements = document.querySelectorAll('.btn, button, [role="button"]');
const positions = Array.from(elements).map((el) => {
  const rect = el.getBoundingClientRect();
  return {
    text: el.textContent.trim(),
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    centered: Math.abs(window.innerWidth / 2 - (rect.x + rect.width / 2)) < 10,
  };
});
JSON.stringify(positions, null, 2);
```

### 3. Analysis Phase

Use `image` tool with prompt:

```
Analyze this website screenshot for:
1. Layout issues (overflow, overlap, misalignment)
2. Element centering and alignment
3. Visual hierarchy
4. CSS/flexbox problems
5. Responsive design quality
6. Missing or broken elements

Report findings with severity: CRITICAL / WARNING / INFO
```

### 4. Cross-Page Consistency Check

For pages that should match (e.g., button positions):

1. Capture both pages
2. Extract element bounding boxes
3. Compare positions (tolerance: 5px)
4. Flag mismatches

### 5. Report Format

```markdown
## Visual Verification Report

**URL:** [url]
**Date:** [timestamp]
**Viewports:** Desktop, Tablet, Mobile

### Findings

| Severity | Issue   | Location  | Recommendation |
| -------- | ------- | --------- | -------------- |
| CRITICAL | [issue] | [element] | [fix]          |
| WARNING  | [issue] | [element] | [fix]          |

### Responsive Check

- [ ] Mobile layout correct
- [ ] Tablet breakpoint works
- [ ] Desktop layout correct
- [ ] Flexbox stacking works

### Cross-Page Consistency

- [ ] Buttons aligned across pages
- [ ] Headers consistent
- [ ] Footer positioning matches
```

### 6. Auto-Fix (when enabled)

If issues found and auto-fix enabled:

1. Identify CSS file containing issue
2. Generate fix
3. Apply edit
4. Commit with message: `fix(css): [issue description]`
5. Push and re-verify

## Usage Examples

### Full Site Verification

```
Verify https://example.com - check all viewports, report issues
```

### Cross-Page Button Check

```
Compare button positions on /page-1 vs /page-2 for https://example.com
```

### Closed Loop Deploy-Verify

```
After deploy, verify https://example.com and fix any CSS issues found
```

## Integration

### With CI/CD

Trigger verification after successful deployment via cron or webhook.

### With Git

Auto-commit fixes with conventional commit format.

## Limitations

- Cannot verify JavaScript interactions (use E2E tests)
- Cannot verify animations (static screenshots only)
- Color accuracy depends on screenshot quality

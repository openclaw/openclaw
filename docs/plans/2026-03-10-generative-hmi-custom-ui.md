# Generative HMI Custom UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create an OpenClaw skill that generates customizable in-vehicle HMI UIs as interactive HTML pages, with chatbot DIY entry, design scheme upload, and 10-dimension bounded personalization.

**Architecture:** Skill-driven HTML generation. The skill provides generation prompts + reference files that guide the LLM to produce complete HTML pages. HTML pages embed a chatbot (via Gateway WebSocket), a design scheme upload UI, and a rule engine driven by the active design scheme. Output delivered via Canvas projection or standalone browser.

**Tech Stack:** OpenClaw Skill framework (SKILL.md + references + assets), HTML/CSS/JS, CSS Grid, CSS Custom Properties, WebSocket (Gateway), Canvas host server.

---

### Task 1: Initialize skill directory and SKILL.md frontmatter

**Files:**
- Create: `skills/generative-hmi-custom-ui/SKILL.md`

**Step 1: Create skill directory**

```bash
mkdir -p skills/generative-hmi-custom-ui/{references,assets}
```

**Step 2: Write SKILL.md with frontmatter and placeholder body**

Create `skills/generative-hmi-custom-ui/SKILL.md`:

```yaml
---
name: generative-hmi-custom-ui
description: >
  Generate customizable in-vehicle HMI UI as interactive HTML pages.
  Use when the user wants to: generate a personalized HMI UI, customize
  UI style, create negative-one-screen widgets, generate HMI HTML UI
  layouts, enable chatbot-driven UI customization, update UI behavior
  based on a new design scheme, or produce HTML+CSS UI components for
  automotive HMI. Outputs interactive HTML with chatbot DIY entry,
  design scheme upload, and bounded personalization within 10 dimensions.
  Do NOT use for unrestricted visual design, arbitrary colors outside
  design tokens, or non-automotive mobile/web UI.
metadata:
  { "openclaw": { "emoji": "🚗" } }
---
```

Body will be written in Task 8 after all references are ready.

**Step 3: Verify skill discovery**

```bash
ls skills/generative-hmi-custom-ui/SKILL.md
```

Expected: file exists

**Step 4: Commit**

```bash
git add skills/generative-hmi-custom-ui/SKILL.md
git commit -m "feat: initialize generative-hmi-custom-ui skill with frontmatter"
```

---

### Task 2: Create design scheme JSON Schema

**Files:**
- Create: `skills/generative-hmi-custom-ui/references/design-scheme-schema.json`

**Step 1: Write the JSON Schema**

Create `skills/generative-hmi-custom-ui/references/design-scheme-schema.json` with the complete schema defining the unified design scheme format. This schema validates:

- `schemeVersion` (string, required)
- `meta` object: name, author, uploadedAt, sourceFormat
- `tokens` object: colors (primary/secondary/surface/surfaceDark/accent/text/status), typography (fontFamily/scale/weight), spacing (xs-xl), radius (sm-pill), elevation (card/modal)
- `themes` object: light and dark theme overrides
- `components` object: card constraints (minWidth/maxWidth/padding/borderRadius/aspectRatios), widget grid (columns/gap/maxRows/sizes)
- `constraints` object: maxWidgets, editMode (scaleFactor/showGrid/snapToGrid), animation (maxDuration/easing), accessibility (minContrastRatio/minTouchTarget)
- `personalization` object: allowedCustomizations array, locked array

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "HMI Design Scheme",
  "description": "Unified design scheme for Generative HMI Custom UI",
  "type": "object",
  "required": ["schemeVersion", "meta", "tokens", "themes", "components", "constraints", "personalization"],
  "properties": {
    "schemeVersion": { "type": "string", "pattern": "^\\d+\\.\\d+$" },
    "meta": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string" },
        "author": { "type": "string" },
        "uploadedAt": { "type": "string", "format": "date-time" },
        "sourceFormat": { "type": "string", "enum": ["json", "figma", "pdf", "docx", "xlsx"] }
      }
    },
    "tokens": {
      "type": "object",
      "required": ["colors", "typography", "spacing", "radius", "elevation"],
      "properties": {
        "colors": {
          "type": "object",
          "required": ["primary", "secondary", "surface", "surfaceDark", "accent", "text", "status"],
          "properties": {
            "primary": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "secondary": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "surface": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "surfaceDark": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "accent": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
            "text": {
              "type": "object",
              "required": ["primary", "secondary", "disabled"],
              "properties": {
                "primary": { "type": "string" },
                "secondary": { "type": "string" },
                "disabled": { "type": "string" }
              }
            },
            "status": {
              "type": "object",
              "required": ["success", "warning", "error"],
              "properties": {
                "success": { "type": "string" },
                "warning": { "type": "string" },
                "error": { "type": "string" }
              }
            }
          }
        },
        "typography": {
          "type": "object",
          "required": ["fontFamily", "scale", "weight"],
          "properties": {
            "fontFamily": { "type": "string" },
            "scale": {
              "type": "object",
              "properties": {
                "h1": { "type": "string" },
                "h2": { "type": "string" },
                "h3": { "type": "string" },
                "body": { "type": "string" },
                "caption": { "type": "string" }
              }
            },
            "weight": {
              "type": "object",
              "properties": {
                "regular": { "type": "number" },
                "medium": { "type": "number" },
                "bold": { "type": "number" }
              }
            }
          }
        },
        "spacing": {
          "type": "object",
          "required": ["xs", "sm", "md", "lg", "xl"],
          "properties": {
            "xs": { "type": "string" },
            "sm": { "type": "string" },
            "md": { "type": "string" },
            "lg": { "type": "string" },
            "xl": { "type": "string" }
          }
        },
        "radius": {
          "type": "object",
          "required": ["sm", "md", "lg", "pill"],
          "properties": {
            "sm": { "type": "string" },
            "md": { "type": "string" },
            "lg": { "type": "string" },
            "pill": { "type": "string" }
          }
        },
        "elevation": {
          "type": "object",
          "properties": {
            "card": { "type": "string" },
            "modal": { "type": "string" }
          }
        }
      }
    },
    "themes": {
      "type": "object",
      "required": ["light", "dark"],
      "properties": {
        "light": {
          "type": "object",
          "properties": {
            "background": { "type": "string" },
            "text": { "type": "string" }
          }
        },
        "dark": {
          "type": "object",
          "properties": {
            "background": { "type": "string" },
            "text": { "type": "string" }
          }
        }
      }
    },
    "components": {
      "type": "object",
      "required": ["card", "widget"],
      "properties": {
        "card": {
          "type": "object",
          "properties": {
            "minWidth": { "type": "string" },
            "maxWidth": { "type": "string" },
            "padding": { "type": "string" },
            "borderRadius": { "type": "string" },
            "aspectRatios": { "type": "array", "items": { "type": "string" } }
          }
        },
        "widget": {
          "type": "object",
          "properties": {
            "grid": {
              "type": "object",
              "properties": {
                "columns": { "type": "integer", "minimum": 1, "maximum": 6 },
                "gap": { "type": "string" },
                "maxRows": { "type": "integer", "minimum": 1 }
              }
            },
            "sizes": {
              "type": "object",
              "properties": {
                "small": { "type": "string" },
                "medium": { "type": "string" },
                "large": { "type": "string" },
                "wide": { "type": "string" }
              }
            }
          }
        }
      }
    },
    "constraints": {
      "type": "object",
      "properties": {
        "maxWidgets": { "type": "integer", "minimum": 1 },
        "editMode": {
          "type": "object",
          "properties": {
            "scaleFactor": { "type": "number", "minimum": 0.5, "maximum": 1.0 },
            "showGrid": { "type": "boolean" },
            "snapToGrid": { "type": "boolean" }
          }
        },
        "animation": {
          "type": "object",
          "properties": {
            "maxDuration": { "type": "string" },
            "easing": { "type": "string" }
          }
        },
        "accessibility": {
          "type": "object",
          "properties": {
            "minContrastRatio": { "type": "number" },
            "minTouchTarget": { "type": "string" }
          }
        }
      }
    },
    "personalization": {
      "type": "object",
      "required": ["allowedCustomizations", "locked"],
      "properties": {
        "allowedCustomizations": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "styleDirection", "layoutDensity", "informationEmphasis",
              "componentArrangement", "themeMode", "motionIntensity",
              "widgetComposition", "sceneMode", "screenMode", "preferenceMemory"
            ]
          }
        },
        "locked": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    }
  }
}
```

**Step 2: Validate JSON is well-formed**

```bash
cat skills/generative-hmi-custom-ui/references/design-scheme-schema.json | python3 -m json.tool > /dev/null && echo "Valid JSON"
```

Expected: `Valid JSON`

**Step 3: Commit**

```bash
git add skills/generative-hmi-custom-ui/references/design-scheme-schema.json
git commit -m "feat: add design scheme JSON Schema for HMI skill"
```

---

### Task 3: Create default design scheme

**Files:**
- Create: `skills/generative-hmi-custom-ui/references/default-design-scheme.json`

**Step 1: Write the default design scheme**

Create a complete default design scheme JSON that follows the schema from Task 2. Use a modern automotive-inspired design with:

- Dark blue primary (#1A73E8), warm accent (#FF6D00)
- HarmonyOS Sans font family
- Standard spacing scale (4/8/16/24/32px)
- 4-column grid, max 3 rows, 12 max widgets
- Edit mode at 85% scale
- All 10 customization dimensions enabled
- Status colors and accessibility constraints locked

```json
{
  "schemeVersion": "1.0",
  "meta": {
    "name": "Default Automotive Theme",
    "author": "OpenClaw",
    "sourceFormat": "json"
  },
  "tokens": {
    "colors": {
      "primary": "#1A73E8",
      "secondary": "#5F6368",
      "surface": "#FFFFFF",
      "surfaceDark": "#1E1E1E",
      "accent": "#FF6D00",
      "text": { "primary": "#202124", "secondary": "#5F6368", "disabled": "#9AA0A6" },
      "status": { "success": "#34A853", "warning": "#FBBC04", "error": "#EA4335" }
    },
    "typography": {
      "fontFamily": "\"HarmonyOS Sans\", system-ui, sans-serif",
      "scale": { "h1": "28px", "h2": "22px", "h3": "18px", "body": "14px", "caption": "12px" },
      "weight": { "regular": 400, "medium": 500, "bold": 700 }
    },
    "spacing": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px" },
    "radius": { "sm": "8px", "md": "12px", "lg": "16px", "pill": "999px" },
    "elevation": {
      "card": "0 2px 8px rgba(0,0,0,0.1)",
      "modal": "0 8px 32px rgba(0,0,0,0.2)"
    }
  },
  "themes": {
    "light": { "background": "#FFFFFF", "text": "#202124" },
    "dark": { "background": "#1E1E1E", "text": "#E8EAED" }
  },
  "components": {
    "card": {
      "minWidth": "140px",
      "maxWidth": "400px",
      "padding": "16px",
      "borderRadius": "12px",
      "aspectRatios": ["1:1", "2:1", "3:2"]
    },
    "widget": {
      "grid": { "columns": 4, "gap": "16px", "maxRows": 3 },
      "sizes": { "small": "1x1", "medium": "2x1", "large": "2x2", "wide": "4x1" }
    }
  },
  "constraints": {
    "maxWidgets": 12,
    "editMode": { "scaleFactor": 0.85, "showGrid": true, "snapToGrid": true },
    "animation": { "maxDuration": "300ms", "easing": "cubic-bezier(0.4, 0, 0.2, 1)" },
    "accessibility": { "minContrastRatio": 4.5, "minTouchTarget": "44px" }
  },
  "personalization": {
    "allowedCustomizations": [
      "styleDirection", "layoutDensity", "informationEmphasis",
      "componentArrangement", "themeMode", "motionIntensity",
      "widgetComposition", "sceneMode", "screenMode", "preferenceMemory"
    ],
    "locked": [
      "tokens.colors.status",
      "constraints.accessibility",
      "components.widget.grid.columns"
    ]
  }
}
```

**Step 2: Validate against schema**

```bash
python3 -c "
import json
with open('skills/generative-hmi-custom-ui/references/design-scheme-schema.json') as f:
    schema = json.load(f)
with open('skills/generative-hmi-custom-ui/references/default-design-scheme.json') as f:
    data = json.load(f)
print('Both files are valid JSON')
print('Required keys present:', all(k in data for k in schema['required']))
"
```

Expected: Both valid, all required keys present

**Step 3: Commit**

```bash
git add skills/generative-hmi-custom-ui/references/default-design-scheme.json
git commit -m "feat: add default automotive design scheme for HMI skill"
```

---

### Task 4: Create component catalog reference

**Files:**
- Create: `skills/generative-hmi-custom-ui/references/component-catalog.md`

**Step 1: Write the component catalog**

This document defines every supported widget type with its:
- Grid size options
- Required HTML structure
- CSS class conventions
- Data attributes
- State handling (normal/hover/active/disabled)
- Theme adaptation rules
- Example markup

Cover all 12 widget types:
1. Navigation Card (2x1, 2x2)
2. Weather Card (1x1, 2x1)
3. Music Control (2x1, 4x1)
4. Quick Toggles (1x1)
5. Clock Display (1x1, 2x1)
6. Notification Card (2x1)
7. Vehicle Status (2x2)
8. Energy Stats (2x1, 2x2)
9. Calendar Card (2x1)
10. Quick Dial (2x1, 4x1)
11. Smart Suggestions (2x1, 4x1)
12. Trip Record (2x1)

Each widget entry should include:
- Widget name and description
- Supported sizes
- Required data-* attributes: `data-widget-type`, `data-widget-size`
- CSS class: `.hmi-widget.hmi-widget--{type}.hmi-widget--{size}`
- HTML structure template
- States: normal, hover, active, disabled
- Theme tokens used

**Step 2: Commit**

```bash
git add skills/generative-hmi-custom-ui/references/component-catalog.md
git commit -m "feat: add component catalog reference for HMI widgets"
```

---

### Task 5: Create customization dimensions reference

**Files:**
- Create: `skills/generative-hmi-custom-ui/references/customization-dimensions.md`

**Step 1: Write the customization dimensions document**

Transcribe the user-provided 10-dimension specification verbatim (from the design approval), structured as a reference document with:

1. Visual Style Direction (minimal/premium/sporty/tech/calm/elegant)
2. Layout Density (compact/balanced/spacious)
3. Information Emphasis (icon-first/label-first/control-first/status-first)
4. Component Arrangement (reorder/add/remove/replace)
5. Theme Mode (day/night/auto)
6. Motion Intensity (low/medium)
7. Widget Composition (supported widget types list)
8. Scene Mode Selection (commute/relax/sport/rest/workout/night driving)
9. Screen Mode (normal/edit/preview both)
10. Personal Preference Memory

Plus DIY Guardrails section.

Include for each dimension:
- Options
- What it affects
- What it must NOT affect
- Example chatbot requests that map to this dimension

**Step 2: Commit**

```bash
git add skills/generative-hmi-custom-ui/references/customization-dimensions.md
git commit -m "feat: add 10-dimension customization spec for HMI skill"
```

---

### Task 6: Create HTML template reference

**Files:**
- Create: `skills/generative-hmi-custom-ui/references/html-template.md`

**Step 1: Write the HTML template reference**

This document provides the exact HTML skeleton that LLM must follow when generating the HMI page. Include:

1. **DOCTYPE and head**: meta viewport for automotive displays, CSS custom property declarations from design tokens, base styles
2. **Header**: time/date display, status indicators, Design Scheme upload icon button
3. **UI Render Area**: CSS Grid container with `grid-template-columns: repeat(4, 1fr)`, widget slots
4. **Scene Mode Bar**: horizontal pill buttons for scene modes
5. **Chatbot Entry**: floating/collapsible chat panel with message history, input field, send button
6. **Design Scheme Upload Modal**: drag-drop file upload area, format acceptance, preview/confirm flow
7. **Edit Mode Overlay**: grid guidelines, scale transform, drag handles
8. **Script section**: WebSocket connection to Gateway, chatbot message handling, design scheme upload handler, theme switching, preference storage

The template should use CSS custom properties (`var(--color-primary)`, etc.) so they can be dynamically set from the active design scheme.

Include the exact HTML structure with clear `<!-- GENERATE: widget content here -->` markers showing where LLM fills in generated content.

**Step 2: Commit**

```bash
git add skills/generative-hmi-custom-ui/references/html-template.md
git commit -m "feat: add HTML template reference for HMI page generation"
```

---

### Task 7: Create chatbot widget asset

**Files:**
- Create: `skills/generative-hmi-custom-ui/assets/chatbot-widget.js`

**Step 1: Write the chatbot widget JavaScript**

This is a self-contained JS module that provides the chatbot functionality embedded in the generated HTML. It should:

1. **WebSocket connection**: Connect to OpenClaw Gateway at configurable URL
2. **Message handling**: Send user messages, receive LLM responses
3. **UI rendering**: Floating chat bubble, expandable chat panel, message history
4. **Customization request parsing**: When LLM returns a customization response, extract structured parameters and emit a `hmi-customization` CustomEvent
5. **Design scheme upload**: Handle file drag-drop, send file content to Gateway for LLM parsing, emit `hmi-scheme-update` CustomEvent with parsed JSON
6. **Preference storage**: Read/write to localStorage or Gateway persistence
7. **Theme awareness**: Respect current theme for chatbot UI styling

Key functions:
- `initChatbot(config)` — initialize with Gateway URL, session info
- `sendMessage(text)` — send user message to Gateway
- `onCustomization(callback)` — register handler for customization events
- `onSchemeUpdate(callback)` — register handler for design scheme updates
- `loadPreferences()` / `savePreferences(prefs)` — persistence

The chatbot should use the same CSS custom properties as the main UI so it adapts to theme changes.

**Step 2: Verify JavaScript syntax**

```bash
node -c skills/generative-hmi-custom-ui/assets/chatbot-widget.js && echo "Syntax OK"
```

Expected: `Syntax OK`

**Step 3: Commit**

```bash
git add skills/generative-hmi-custom-ui/assets/chatbot-widget.js
git commit -m "feat: add chatbot widget JS for HMI interactive UI"
```

---

### Task 8: Write the full SKILL.md body

**Files:**
- Modify: `skills/generative-hmi-custom-ui/SKILL.md`

**Step 1: Write the SKILL.md body**

Append the full skill body after the frontmatter. The body is the prompt that guides the LLM to generate the HMI UI. Structure:

**Section 1: Overview**
- What this skill does
- What it produces (interactive HTML page)
- Three zones: UI Render Area, Chatbot Entry, Design Scheme Icon

**Section 2: Generation Workflow**
- Step-by-step instructions for the LLM:
  1. Load active design scheme (from `~/.openclaw/hmi-schemes/active.json` or default)
  2. Load user preferences (if available)
  3. Read the HTML template from `references/html-template.md`
  4. Generate widget HTML for each widget in composition, following `references/component-catalog.md`
  5. Apply customization dimensions per `references/customization-dimensions.md`
  6. Map all design tokens to CSS custom properties
  7. Embed chatbot widget from `assets/chatbot-widget.js`
  8. Output complete HTML file
  9. Present via Canvas (`canvas action:present`) or write to Gateway-served directory

**Section 3: Design Scheme Upload Handling**
- When user or PM uploads a design document:
  1. Accept file (Figma export / PDF / Word / Excel / JSON)
  2. Read file content
  3. Parse and extract design tokens, component rules, theme definitions, constraints
  4. Map to the unified schema defined in `references/design-scheme-schema.json`
  5. Validate the output
  6. Save to `~/.openclaw/hmi-schemes/`
  7. If set as active, trigger UI regeneration

**Section 4: Chatbot DIY Handling**
- When user sends a customization request through chatbot:
  1. Parse natural language to identify which of the 10 dimensions is being modified
  2. Validate request against DIY guardrails
  3. If valid: update structured parameters, regenerate affected UI
  4. If invalid: explain limitation, suggest alternative, regenerate within bounds

**Section 5: Canvas vs Browser Delivery**
- Canvas mode instructions
- Browser mode instructions
- How to detect which mode

**Section 6: References**
- Point to each reference file with brief description of when to consult it

**Step 2: Verify SKILL.md is well-formed**

```bash
head -5 skills/generative-hmi-custom-ui/SKILL.md
```

Expected: YAML frontmatter delimiter `---`

**Step 3: Commit**

```bash
git add skills/generative-hmi-custom-ui/SKILL.md
git commit -m "feat: write full SKILL.md generation prompt for HMI custom UI"
```

---

### Task 9: Verify skill discovery

**Step 1: Check skill directory structure is complete**

```bash
find skills/generative-hmi-custom-ui/ -type f | sort
```

Expected output:
```
skills/generative-hmi-custom-ui/SKILL.md
skills/generative-hmi-custom-ui/assets/chatbot-widget.js
skills/generative-hmi-custom-ui/references/component-catalog.md
skills/generative-hmi-custom-ui/references/customization-dimensions.md
skills/generative-hmi-custom-ui/references/default-design-scheme.json
skills/generative-hmi-custom-ui/references/design-scheme-schema.json
skills/generative-hmi-custom-ui/references/html-template.md
```

**Step 2: Verify SKILL.md frontmatter parses correctly**

```bash
head -20 skills/generative-hmi-custom-ui/SKILL.md
```

Expected: Valid YAML frontmatter with `name: generative-hmi-custom-ui` and `description`

**Step 3: Run existing skill tests to ensure nothing is broken**

```bash
cd /Users/claire/code/openclaw && pnpm vitest run src/agents/skills.test.ts
```

Expected: All existing tests pass

**Step 4: Commit (if any fixes needed)**

Only commit if adjustments were made.

---

### Task 10: End-to-end smoke test

**Step 1: Create default scheme storage directory**

```bash
mkdir -p ~/.openclaw/hmi-schemes
cp skills/generative-hmi-custom-ui/references/default-design-scheme.json ~/.openclaw/hmi-schemes/active.json
```

**Step 2: Verify HTML template generation prompt is self-contained**

Read through the SKILL.md and verify that:
- All referenced files exist
- All design tokens in default scheme are used in the HTML template
- The chatbot-widget.js file handles WebSocket connection
- Canvas and browser delivery paths are documented

**Step 3: Final commit with any fixes**

```bash
git add -A skills/generative-hmi-custom-ui/
git commit -m "feat: complete generative-hmi-custom-ui skill with all references and assets"
```

---

## File Summary

| File | Purpose |
|------|---------|
| `skills/generative-hmi-custom-ui/SKILL.md` | Main skill definition + LLM generation prompt |
| `skills/generative-hmi-custom-ui/references/design-scheme-schema.json` | JSON Schema for validating design schemes |
| `skills/generative-hmi-custom-ui/references/default-design-scheme.json` | Default out-of-box design scheme |
| `skills/generative-hmi-custom-ui/references/component-catalog.md` | Widget type specs + generation rules |
| `skills/generative-hmi-custom-ui/references/customization-dimensions.md` | 10-dimension DIY personalization spec |
| `skills/generative-hmi-custom-ui/references/html-template.md` | HTML page skeleton template |
| `skills/generative-hmi-custom-ui/assets/chatbot-widget.js` | Embedded chatbot + scheme upload JS |

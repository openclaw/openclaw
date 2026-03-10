# Generative HMI Custom UI — Design Document

**Date:** 2026-03-10
**Status:** Approved
**Approach:** Skill-Driven HTML Generation (方案A)

---

## 1. Overview

Create a `generative-hmi-custom-ui` skill for OpenClaw that allows users to generate customizable in-vehicle HMI UIs. The UI is model-generated but constrained by an official design specification that product managers can upload. Users can personalize the UI through a chatbot interface within predefined dimensions.

### Deliverables

- An OpenClaw Skill (`skills/generative-hmi-custom-ui/`)
- Generated interactive HTML pages with UI render area, chatbot entry, and design scheme upload
- Support for both Canvas node projection and standalone browser rendering
- 10-dimension bounded personalization system
- Multi-format design scheme upload and LLM-powered parsing

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Generated HTML Page                     │
│                                                          │
│  ┌─────────────────────────────────────────────┐         │
│  │          1. UI Render Area (CSS Grid)        │         │
│  │   Widgets: Nav, Weather, Music, Vehicle...  │         │
│  └─────────────────────────────────────────────┘         │
│                                                          │
│  ┌──────┐  ┌───────────────────────────┐                 │
│  │Design│  │ Chatbot (DIY Entry)        │                 │
│  │Scheme│  │ via Gateway WebSocket      │                 │
│  │Upload│  └───────────────────────────┘                 │
│  └──────┘                                                │
│                                                          │
│  ┌──────────────────────────────────────────────┐        │
│  │  Active Rule Engine (internal, invisible)     │        │
│  │  Tokens | Theme Rules | Layout | States       │        │
│  └──────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
   Canvas Projection          Standalone Browser
   (macOS/iOS/Android)        (Preview/Demo)
```

### Data Flows

1. **Initial generation**: User triggers Skill → LLM reads design scheme + preferences → generates HTML → Canvas projection / browser render
2. **Chatbot DIY**: User natural language → Gateway → LLM maps to structured params → regenerate affected widgets → hot update
3. **Design scheme upload**: PM uploads doc → LLM parses to unified JSON rules → store in rule registry → trigger full UI regeneration
4. **Theme/mode switch**: User switches day/night/edit mode → rule engine switches token set → regenerate affected areas

---

## 3. Design Scheme System

### Unified Rule Format

All uploaded design specs (Figma/PDF/Word/Excel/JSON) are parsed by LLM into this unified JSON format:

```json
{
  "schemeVersion": "1.0",
  "meta": {
    "name": "OEM Premium Theme",
    "author": "Product Team",
    "uploadedAt": "2026-03-10T10:00:00Z",
    "sourceFormat": "figma"
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
    "light": { "background": "{colors.surface}", "text": "{colors.text.primary}" },
    "dark": { "background": "{colors.surfaceDark}", "text": "#E8EAED" }
  },
  "components": {
    "card": {
      "minWidth": "140px",
      "maxWidth": "400px",
      "padding": "{spacing.md}",
      "borderRadius": "{radius.md}",
      "aspectRatios": ["1:1", "2:1", "3:2"]
    },
    "widget": {
      "grid": { "columns": 4, "gap": "{spacing.md}", "maxRows": 3 },
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
    "locked": ["tokens.colors.status", "constraints.accessibility", "components.widget.grid.columns"]
  }
}
```

### Upload Flow

1. PM clicks Design Scheme icon → upload dialog (drag-drop/click)
2. Accepts: `.json`, `.pdf`, `.docx`, `.xlsx`, `.fig` (Figma export)
3. File sent via Gateway to OpenClaw → Skill sends content + parsing prompt to LLM
4. LLM returns unified JSON → validate against schema → store in `~/.openclaw/hmi-schemes/`
5. PM previews parsed result, edits corrections, confirms activation
6. Activation triggers full UI regeneration

---

## 4. 10-Dimension DIY Customization System

### Dimension 1: Visual Style Direction

Options: minimal / premium / sporty / tech / calm / elegant

**Affects:** spacing rhythm, typography emphasis, card visual weight, icon prominence, visual hierarchy
**Must NOT affect:** component size rules, token definitions, radius rules

### Dimension 2: Layout Density

Options: compact / balanced / spacious

**Affects:** card spacing, internal padding, grid density
**Must NOT affect:** widget dimensions, component boundaries

### Dimension 3: Information Emphasis

Options: icon-first / label-first / control-first / status-first

**Affects:** hierarchy, layout grouping, visual weight

### Dimension 4: Component Arrangement

Actions: reorder widgets / add widget / remove widget / replace widget type

**Restrictions:** widgets must be from supported component library, widget size cannot change

### Dimension 5: Theme Mode

Options: day / night / auto

Auto theme may switch based on: time, vehicle state, ambient light
Theme switching must preserve: UI state, component structure

### Dimension 6: Motion Intensity

Options: low / medium

**Affects:** transition speed, micro interaction feedback, loading animation style
Must not remove required animations.

### Dimension 7: Widget Composition

Available widgets: navigation, media, phone, climate control, drive mode, seat adjustment, ambient light, vehicle status, trip information

**Restrictions:** only supported widget types, must follow component specs

### Dimension 8: Scene Mode Selection

Options: commute / relax / sport / rest / workout / night driving

**Affects:** widget priority, theme preference, layout grouping

### Dimension 9: Screen Mode

Options: normal mode / edit mode / preview both

Edit mode: layout arrangement only, functional interaction disabled

### Dimension 10: Personal Preference Memory

Stores: preferred style, preferred theme, preferred widget layout, preferred density
Chatbot may recall these preferences for future sessions.

### DIY Guardrails

Users may NOT modify: design tokens, radius values, component sizes, required states, theme token definitions, system safety rules.

If a user attempts to modify these, the chatbot must:
1. Explain the limitation
2. Suggest a valid alternative
3. Regenerate UI within allowed dimensions

---

## 5. Component Catalog (Extended Set)

| Category | Widget | Grid Sizes | Data Source |
|----------|--------|------------|-------------|
| **Core** | Navigation Card | 2x1, 2x2 | Frequent destinations + live traffic |
| | Weather Card | 1x1, 2x1 | Location + weather API |
| | Music Control | 2x1, 4x1 | Now playing + playlist |
| | Quick Toggles | 1x1 | Windows/AC/seat heating etc. |
| | Clock Display | 1x1, 2x1 | System time |
| | Notification Card | 2x1 | Messages/reminders/calendar |
| **Extended** | Vehicle Status | 2x2 | Tire pressure/fuel/battery/mileage |
| | Energy Stats | 2x1, 2x2 | Trip energy/average consumption |
| | Calendar Card | 2x1 | Today's schedule/next meeting |
| | Quick Dial | 2x1, 4x1 | Frequent contacts |
| | Smart Suggestions | 2x1, 4x1 | Time/habit/location based recommendations |
| | Trip Record | 2x1 | Recent trip summary |

### Component Generation Constraints

1. **Size**: Strict grid sizes from design scheme (1x1 ~ 4x1)
2. **Colors**: Only design tokens, no hardcoded values
3. **Spacing**: Only spacing tokens
4. **Radius**: Only radius tokens
5. **Typography**: Only scale presets
6. **States**: Must handle normal / hover / active / disabled
7. **Themes**: Must support both day and night

---

## 6. HTML Page Structure

### Layout

```
┌──────────────────────────────────────────────────┐
│ Header: Time | Date | Status | [Design Scheme]   │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           UI Render Area (CSS Grid)         │  │
│  │  Widgets arranged per grid config           │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Scene Mode Bar                           │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
├──────────────────────────────────────────────────┤
│ Chatbot Entry (floating / collapsible)           │
│ ┌──────────────────────────────────────────────┐ │
│ │ Chat history + input                         │ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### Technical Implementation

- **CSS Grid** for widget layout
- **CSS Custom Properties** mapping design tokens (`--color-primary`, `--spacing-md`, etc.)
- **Chatbot WebSocket** to OpenClaw Gateway (`ws://<gateway>:18789/ws`)
- **Design Scheme upload** via Gateway file upload API
- **Preference storage**: `localStorage` (browser) / Gateway persistence (Canvas mode)
- **Theme switching**: `<html data-theme="day|night">` attribute toggle
- **Edit mode**: scale factor 0.85, grid overlay, drag-drop, interaction disabled

---

## 7. Skill File Structure

```
skills/generative-hmi-custom-ui/
├── SKILL.md                              # Main skill definition + generation prompt
├── references/
│   ├── design-scheme-schema.json         # Unified design scheme JSON Schema
│   ├── default-design-scheme.json        # Default out-of-box design scheme
│   ├── component-catalog.md              # Widget specs and generation rules
│   ├── customization-dimensions.md       # 10-dimension DIY specification
│   └── html-template.md                  # HTML page skeleton structure
└── assets/
    └── chatbot-widget.js                 # Chatbot component base code
```

---

## 8. Canvas Integration

```
User triggers Skill
    │
    ├──→ Canvas mode:
    │    canvas action:present node:<id> target:<html-file>
    │    HTML written to ~/Library/Application Support/OpenClaw/canvas/<session>/
    │    WKWebView/WebView renders
    │    WebSocket connects Gateway for chatbot interaction
    │
    └──→ Browser mode:
         Gateway serves HTML at http://<host>:18793/hmi/
         Direct browser access
         Same WebSocket connection to Gateway
```

---

## 9. Regeneration Triggers

| Trigger Event | Regeneration Scope |
|---------------|-------------------|
| Chatbot customization request | Affected widgets or global style |
| Design scheme upload | Full regeneration |
| Theme switch (day/night/auto) | Full token switch + re-render |
| Screen mode switch | Layout mode switch (normal/edit) |
| Scene mode switch | Widget priority reorder + style tweak |
| Widget add/remove | Affected area re-layout |

---

## 10. Preference Persistence

```
Canvas mode:
  ~/.openclaw/hmi-preferences/<user-id>.json

Browser mode:
  localStorage: openclaw-hmi-preferences

Design Scheme storage:
  ~/.openclaw/hmi-schemes/<scheme-name>.json
```

---

## 11. Chatbot Request Mapping

User natural language → LLM maps to structured parameters:

```json
{
  "customization": {
    "styleDirection": "sporty",
    "layoutDensity": "compact",
    "infoEmphasis": "icon-first",
    "arrangement": { "action": "reorder", "widget": "music", "position": "top" },
    "themeMode": "night",
    "motionIntensity": "medium",
    "widgetComposition": ["navigation", "media", "climate", "vehicle-status", "drive-mode"],
    "sceneMode": "commute",
    "screenMode": "normal"
  }
}
```

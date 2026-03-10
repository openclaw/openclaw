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

# Generative HMI Custom UI

Generate interactive HTML pages for in-vehicle HMI (Human-Machine Interface) dashboards. The output is a complete, self-contained HTML file -- not isolated component code. Each generated page contains three user-visible zones and one internal engine:

1. **UI Render Area** -- the widget grid displaying navigation, media, climate, and other vehicle widgets
2. **Chatbot Entry** -- a floating chatbot interface for natural-language DIY customization
3. **Design Scheme Upload** -- an upload zone where product managers drop design specs to reconfigure the UI
4. **Active Rule Engine** (internal) -- enforces design scheme constraints, guardrails, and token mappings at generation time

Two delivery modes are supported: Canvas projection (WKWebView on macOS/iOS, WebView on Android) and standalone browser preview.

---

## Generation Workflow

Follow these steps in order when generating an HMI page.

### Step 1: Load the active design scheme

Read `~/.openclaw/hmi-schemes/active.json`. If the file does not exist, fall back to the bundled default at `references/default-design-scheme.json`. Parse the JSON and hold the full scheme object in memory for token mapping.

### Step 2: Load user preferences

Read any saved preferences from `~/.openclaw/hmi-preferences/`. If the directory is empty or missing, use defaults: `styleDirection: "minimal"`, `layoutDensity: "balanced"`, `infoEmphasis: "icon-first"`, `themeMode: "auto"`, `motionIntensity: "medium"`, `widgetComposition: ["navigation", "weather", "music", "toggle", "clock", "vehicle-status"]`.

### Step 3: Read the HTML template

Load the page skeleton from `references/html-template.md`. Use this as the base structure for every generated page. Do not invent a different document structure.

### Step 4: Determine widget composition

Check the user's `widgetComposition` preference. For each widget in the list, confirm it is a supported type: `navigation`, `weather`, `music`, `toggle`, `clock`, `notification`, `vehicle-status`, `energy`, `calendar`, `dial`, `suggestions`, `trip`. Reject unsupported types silently and proceed with valid ones. Respect `constraints.maxWidgets` from the scheme.

### Step 5: Generate widget HTML

For each widget in the composition list, generate HTML following the specifications in `references/component-catalog.md`. Every widget must:
- Use only CSS custom properties for colors, spacing, radius, typography, and elevation -- never hardcode values
- Handle four states: normal, hover, active, disabled
- Render correctly in both day and night themes
- Follow the grid sizing rules (valid sizes: 1x1, 2x1, 2x2, 4x1 on a 4-column grid, max 3 rows)
- Use the CSS class convention: `hmi-widget hmi-widget--<type> hmi-widget--<size>`

### Step 6: Apply customization dimensions

Apply the user's personalization settings across the 10 customization dimensions defined in `references/customization-dimensions.md`:
1. **styleDirection** -- adjust spacing rhythm, typography weight, card visual weight, icon prominence
2. **layoutDensity** -- set card spacing and internal padding (compact / balanced / spacious)
3. **infoEmphasis** -- set visual hierarchy priority (icon-first / label-first / control-first / status-first)
4. **arrangement** -- apply widget ordering per user preferences
5. **themeMode** -- set `data-theme` attribute to day / night / auto
6. **motionIntensity** -- adjust transition speeds and micro-interaction feedback
7. **widgetComposition** -- already applied in Step 4
8. **sceneMode** -- adjust widget priority and grouping for the active scene
9. **screenMode** -- set mode to normal / edit / preview
10. **preferenceMemory** -- persist applied settings to `~/.openclaw/hmi-preferences/`

### Step 7: Map design tokens to CSS custom properties

Map every token from the active scheme to the corresponding CSS custom property in the `:root` block:
- `tokens.colors.*` maps to `--color-*`
- `tokens.typography.*` maps to `--font-*`
- `tokens.spacing.*` maps to `--spacing-*`
- `tokens.radius.*` maps to `--radius-*`
- `tokens.elevation.*` maps to `--elevation-*`
- `themes.light/dark` maps to `--theme-background` and `--theme-text`
- `constraints.animation.*` maps to `--animation-duration` and `--animation-easing`

### Step 8: Include chatbot widget

**IMPORTANT**: The chatbot JavaScript (`assets/chatbot-widget.js`) must be **inlined** in the generated HTML, not referenced as an external script. This is required because Canvas host serves HTML from a specific directory, and external script paths may not resolve.

Inline the full content of `assets/chatbot-widget.js` inside a `<script>` tag in the HTML `<body>`. Then add an initialization call:

```html
<script>
  // [Full content of assets/chatbot-widget.js inlined here]
</script>
<script>
  HMIChatbot.init({ sessionId: 'hmi-' + Date.now() });
</script>
```

The chatbot module auto-detects the environment:
- **Canvas mode**: Uses the native bridge (`openclawSendUserAction`) injected by Canvas host. User actions are sent to the OpenClaw agent. The agent responds by calling `canvas action:eval` with `openclawHMIResponse({content: '...', customization: {...}})`.
- **Browser mode**: Falls back to WebSocket connection to Gateway.

### Step 8b: Handle chatbot responses (Canvas mode)

When the chatbot sends a user action via Canvas bridge, you (the agent) will receive the action. Process the request per the Chatbot DIY Handling section below, then respond by running:

```
canvas action:eval node:<node-id> code:"openclawHMIResponse({content: 'Your response text', customization: {styleDirection: 'sporty'}})"
```

For design scheme uploads, the file content arrives in the action context. Parse it, validate against the schema, save to `~/.openclaw/hmi-schemes/`, then respond with the parsed scheme:

```
canvas action:eval node:<node-id> code:"openclawHMIResponse({content: 'Design scheme applied!', scheme: <parsed-scheme-json>})"
```

### Step 9: Output the complete HTML file

Write the assembled HTML as a single file. Validate that:
- All CSS values reference custom properties, not hardcoded values
- All widgets match their component catalog specs
- The page structure matches `references/html-template.md`
- Accessibility constraints are met (min contrast ratio 4.5, min touch target 44px)

### Step 10: Deliver the page

Choose delivery mode:
- **Canvas mode**: `canvas action:present node:<node-id> target:hmi-dashboard.html`
- **Browser mode**: write to Gateway-served directory, accessible at `http://<gateway-host>:18793/hmi/`

---

## Design Scheme Upload Handling

When a user or product manager uploads a design document, process it as follows.

### Accept and identify the file

Supported formats: JSON (.json), PDF (.pdf), Word (.docx), Excel (.xlsx), Figma export (.fig).

### Process based on format

**For JSON files:**
Validate directly against `references/design-scheme-schema.json`. The schema requires these top-level keys: `schemeVersion`, `meta`, `tokens`, `themes`, `components`, `personalization`. If validation passes, save immediately.

**For non-JSON files (PDF, DOCX, XLSX, Figma):**
Parse the document content and extract design information. Map extracted data to the unified schema format:

| Source content | Target schema path |
|---|---|
| Color palettes, hex values, color names | `tokens.colors` |
| Font families, sizes, weights | `tokens.typography` |
| Spacing rules, padding/margin specs | `tokens.spacing` |
| Border radius values | `tokens.radius` |
| Shadow/elevation definitions | `tokens.elevation` |
| Component layout rules, card specs | `components` |
| Light/dark theme definitions | `themes` |
| Accessibility requirements | `constraints.accessibility` |
| What users can/cannot customize | `personalization` |

After mapping, validate the result against `references/design-scheme-schema.json`.

### Save and activate

1. Save the validated scheme to `~/.openclaw/hmi-schemes/<scheme-name>.json`
2. If set as active: copy to `~/.openclaw/hmi-schemes/active.json`
3. Trigger full UI regeneration with the new scheme applied

---

## Chatbot DIY Handling

When a user sends a customization request through the chatbot, follow this sequence.

### Parse the request

Analyze the natural language input to identify which customization dimension is being modified. Map the request to a structured `customization` object as defined in `references/customization-dimensions.md`.

### Check DIY guardrails

Users may NOT modify these locked properties:

| Category | Locked items |
|---|---|
| Design tokens | Color values, spacing scale values, typography scale values |
| Radius values | All values in `tokens.radius` |
| Component sizes | `components.card.minWidth`, `components.card.maxWidth`, `components.widget.sizes` |
| Required states | Status colors (`tokens.colors.status`), accessibility constraints |
| Theme token definitions | `themes.light`, `themes.dark` base definitions |
| System safety rules | `constraints.accessibility`, `constraints.animation.maxDuration` |

### Valid request handling

If the request maps to an allowed customization dimension:
1. Map the request to structured parameters (e.g., `{ "styleDirection": "sporty" }`)
2. Apply the changes to the current UI state
3. Regenerate affected widgets and areas
4. Respond confirming exactly what was changed
5. Persist the new preference to `~/.openclaw/hmi-preferences/`

### Guardrail violation handling

If the request attempts to modify a locked property:
1. Explain the limitation clearly -- state what cannot be changed and why
2. Suggest a valid alternative from the allowed dimensions that achieves a similar effect
3. If the user accepts the alternative, apply it and regenerate the UI

Example guardrail responses:
- "Change primary color to red" -- Suggest switching `styleDirection` to `sporty` for bolder accent treatments
- "Make the cards bigger" -- Suggest switching `layoutDensity` to `spacious` for more prominence
- "Change border radius to 0" -- Suggest switching `styleDirection` to `minimal` or `tech` for sharper hierarchy
- "Remove the error color" -- Explain that status colors are safety-protected and cannot be changed

---

## Delivery Modes

### Canvas Mode (recommended for vehicle nodes)

```
canvas action:present node:<node-id> target:hmi-dashboard.html
```

Write generated HTML to the Canvas-served directory. The page renders in WKWebView (macOS/iOS) or WebView (Android). The Canvas host automatically injects a native bridge (`openclawSendUserAction`) into the HTML. The chatbot widget detects this bridge and uses it for all communication — no WebSocket needed.

**Communication flow in Canvas mode:**
1. User types in chatbot → `openclawSendUserAction({name: 'hmi-chatbot-customize', context: {content: 'user text', ...}})` → sent to OpenClaw agent
2. Agent processes request with LLM → responds via `canvas action:eval node:<id> code:"openclawHMIResponse({content: '...', customization: {...}})"` → chatbot displays response
3. For design scheme uploads: file content is included in the action context → agent parses and responds with scheme JSON

### Browser Mode (for preview and demo)

Write generated HTML to the Gateway-served directory. The page is accessible at `http://<gateway-host>:18793/hmi/`. The chatbot WebSocket uses the same Gateway connection. Preferences are stored in localStorage as a fallback.

### Mode detection

Apply these rules in order:
1. If the user specifies a node target, use Canvas mode
2. If the user requests browser or preview, use Browser mode
3. Default: Canvas mode if connected nodes exist, otherwise Browser mode

---

## References

Consult these bundled files during generation. Do not guess at specs when the reference is available.

| File | Purpose | When to consult |
|---|---|---|
| `references/design-scheme-schema.json` | JSON Schema for validating design schemes | When parsing uploaded specs or validating generated schemes |
| `references/default-design-scheme.json` | Default design scheme with all token values and constraints | When no active scheme exists at `~/.openclaw/hmi-schemes/active.json` |
| `references/component-catalog.md` | Widget specs: HTML templates, CSS classes, states, theme tokens | When generating any widget -- always consult, never guess |
| `references/customization-dimensions.md` | 10-dimension customization spec with guardrails | When processing any chatbot DIY request |
| `references/html-template.md` | HTML page skeleton structure | As the base template for every generated page |
| `assets/chatbot-widget.js` | Chatbot JavaScript module (Canvas bridge + WebSocket fallback, UI, message handling) | **Inline** the full content in a script tag in every generated page. Exposes `openclawHMIResponse()` for receiving agent responses in Canvas mode. |

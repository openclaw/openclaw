# Customization Dimensions Reference

This document defines the 10 dimensions of DIY personalization available to end-users through the chatbot interface. Each dimension specifies what can be changed, what must remain untouched, and how natural language requests map to structured parameters.

The LLM must parse user requests against these dimensions and produce a structured `customization` object. Any request that falls outside these dimensions must be rejected with a guardrail response (see [DIY Guardrails](#diy-guardrails)).

---

## Structured Parameter Format

Every chatbot customization request resolves to a JSON object with this shape:

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

Only include the fields that the user's request explicitly changes. Omitted fields retain their current values.

---

## Dimension 1: Visual Style Direction

**Parameter key:** `styleDirection`

**Options:** `minimal` | `premium` | `sporty` | `tech` | `calm` | `elegant`

**Affects:**
- Spacing rhythm (tighter for sporty/tech, looser for calm/elegant)
- Typography emphasis (bolder weights for sporty/premium, lighter for minimal/calm)
- Card visual weight (heavier shadows and borders for premium, flat for minimal)
- Icon prominence (larger/bolder for sporty/tech, subtler for calm/elegant)
- Visual hierarchy (high contrast for sporty, muted for calm)

**Must NOT affect:**
- Component size rules (defined in design scheme `components`)
- Token definitions (colors, spacing scale values in `tokens`)
- Radius rules (defined in `tokens.radius`)

**Example chatbot requests:**
- "让UI更运动感" (make it sportier)
- "make it look premium"
- "switch to a calmer style"
- "I want a clean, minimal look"
- "go for a more techy vibe"

**Parameter mapping:**
```json
{ "styleDirection": "sporty" }
```

---

## Dimension 2: Layout Density

**Parameter key:** `layoutDensity`

**Options:** `compact` | `balanced` | `spacious`

**Affects:**
- Card spacing (gap between cards and widgets)
- Internal padding (padding within cards and containers)
- Grid density (how tightly widgets pack into the grid)

**Must NOT affect:**
- Widget dimensions (sizes defined in `components.widget.sizes`)
- Component boundaries (min/max width, aspect ratios in `components.card`)

**Example chatbot requests:**
- "reduce spacing"
- "make the layout more compact"
- "give more breathing room"
- "too crowded, space it out"
- "让布局更紧凑" (make the layout more compact)

**Parameter mapping:**
```json
{ "layoutDensity": "compact" }
```

---

## Dimension 3: Information Emphasis

**Parameter key:** `infoEmphasis`

**Options:** `icon-first` | `label-first` | `control-first` | `status-first`

**Affects:**
- Hierarchy (which element gets visual priority within each widget)
- Layout grouping (how content is arranged inside cards)
- Visual weight (size and prominence of the emphasized element type)

**Example chatbot requests:**
- "show me icons bigger, less text"
- "I want to see the status at a glance"
- "prioritize the controls"
- "make labels more prominent"
- "图标优先显示" (show icons first)

**Parameter mapping:**
```json
{ "infoEmphasis": "icon-first" }
```

---

## Dimension 4: Component Arrangement

**Parameter key:** `arrangement`

**Actions:** `reorder` | `add` | `remove` | `replace`

**Action parameters:**
- `reorder`: `{ "action": "reorder", "widget": "<name>", "position": "<top|bottom|N>" }`
- `add`: `{ "action": "add", "widget": "<name>", "position": "<top|bottom|N>" }`
- `remove`: `{ "action": "remove", "widget": "<name>" }`
- `replace`: `{ "action": "replace", "widget": "<current>", "replacement": "<new>" }`

**Restrictions:**
- Widgets must be from the supported component library (see [Dimension 7](#dimension-7-widget-composition))
- Widget size cannot change through arrangement actions
- Total widget count must respect `constraints.maxWidgets`

**Example chatbot requests:**
- "move music widget to top"
- "replace AC with temperature control"
- "add driving mode card"
- "remove the trip info widget"
- "把导航放到第一个位置" (put navigation in the first position)

**Parameter mapping:**
```json
{ "arrangement": { "action": "reorder", "widget": "music", "position": "top" } }
```

---

## Dimension 5: Theme Mode

**Parameter key:** `themeMode`

**Options:** `day` | `night` | `auto`

**Auto mode triggers:**
- Time of day (switch at sunrise/sunset)
- Vehicle state (engine on/off, headlights)
- Ambient light sensor data

**Theme switching must preserve:**
- UI state (scroll position, expanded/collapsed panels, active selections)
- Component structure (layout, widget order, widget composition)

**Example chatbot requests:**
- "switch to dark mode"
- "turn on night theme"
- "use auto theme switching"
- "切换到白天模式" (switch to day mode)
- "let the car decide the theme"

**Parameter mapping:**
```json
{ "themeMode": "night" }
```

---

## Dimension 6: Motion Intensity

**Parameter key:** `motionIntensity`

**Options:** `low` | `medium`

**Affects:**
- Transition speed (faster/snappier for low, standard for medium)
- Micro interaction feedback (reduced for low, full for medium)
- Loading animation style (simplified for low, standard for medium)

**Restrictions:**
- Must not remove required animations (safety-critical feedback, state transitions that communicate system status)
- Animation duration must stay within `constraints.animation.maxDuration`

**Example chatbot requests:**
- "reduce animations"
- "make transitions faster"
- "I want smoother animations"
- "减少动画效果" (reduce animation effects)
- "keep animations but make them quick"

**Parameter mapping:**
```json
{ "motionIntensity": "low" }
```

---

## Dimension 7: Widget Composition

**Parameter key:** `widgetComposition`

**Supported widget types:**
- `navigation`
- `media`
- `phone`
- `climate`
- `drive-mode`
- `seat-adjustment`
- `ambient-light`
- `vehicle-status`
- `trip-information`

**Restrictions:**
- Only supported widget types listed above may be used
- Widgets must follow component specs defined in the design scheme (`components.widget`)
- Total count must not exceed `constraints.maxWidgets`

**Example chatbot requests:**
- "show me navigation, music, and climate only"
- "add vehicle status to my dashboard"
- "I don't need the phone widget"
- "只显示导航和音乐" (show only navigation and music)
- "give me the full set of driving widgets"

**Parameter mapping:**
```json
{ "widgetComposition": ["navigation", "media", "climate", "vehicle-status", "drive-mode"] }
```

---

## Dimension 8: Scene Mode Selection

**Parameter key:** `sceneMode`

**Options:** `commute` | `relax` | `sport` | `rest` | `workout` | `night-driving`

**Affects:**
- Widget priority (which widgets are promoted or demoted based on scene context)
- Theme preference (scene may suggest a theme, e.g., night-driving prefers night theme)
- Layout grouping (widgets are grouped by relevance to the active scene)

**Example chatbot requests:**
- "I'm commuting to work"
- "switch to sport mode"
- "set up a relaxing drive"
- "切换到夜间驾驶模式" (switch to night driving mode)
- "I'm heading to the gym"

**Parameter mapping:**
```json
{ "sceneMode": "commute" }
```

---

## Dimension 9: Screen Mode

**Parameter key:** `screenMode`

**Options:** `normal` | `edit` | `preview`

**Mode behaviors:**
- **Normal mode**: Full functional interaction. Widgets respond to taps, gestures, and data updates.
- **Edit mode**: Layout arrangement only. Users can drag, reorder, add, and remove widgets. Functional interaction is disabled (no taps trigger widget actions).
- **Preview mode**: Displays both the current layout and proposed changes side by side. No functional interaction.

**Example chatbot requests:**
- "let me rearrange my widgets"
- "enter edit mode"
- "preview my changes"
- "go back to normal"
- "进入编辑模式" (enter edit mode)

**Parameter mapping:**
```json
{ "screenMode": "edit" }
```

---

## Dimension 10: Personal Preference Memory

**Parameter key:** `preferenceMemory` (read-only; managed by the system)

**Stores:**
- Preferred style direction
- Preferred theme mode
- Preferred widget layout (composition and arrangement)
- Preferred layout density

**Behavior:**
- The chatbot may recall stored preferences for future sessions
- When a user returns, previously saved preferences are applied as defaults
- Users can explicitly ask to reset or update stored preferences

**Example chatbot requests:**
- "remember my preferences"
- "use my saved layout"
- "reset everything to defaults"
- "记住我的设置" (remember my settings)
- "what are my saved preferences?"

**Note:** This dimension is not directly set via the `customization` object. It is managed by the system's preference persistence layer. The chatbot reads from and writes to this store based on user instructions.

---

## DIY Guardrails

### Locked properties (users may NOT modify)

| Category | Locked items |
|---|---|
| Design tokens | Color values, spacing scale values, typography scale values |
| Radius values | All values in `tokens.radius` |
| Component sizes | `components.card.minWidth`, `components.card.maxWidth`, `components.widget.sizes` |
| Required states | Status colors (`tokens.colors.status`), accessibility constraints |
| Theme token definitions | `themes.light`, `themes.dark` base definitions |
| System safety rules | `constraints.accessibility`, `constraints.animation.maxDuration` |

### Chatbot behavior when a guardrail is hit

If a user attempts to modify a locked property, the chatbot must:

1. **Explain the limitation** -- Tell the user what cannot be changed and why (safety, consistency, accessibility).
2. **Suggest a valid alternative** -- Recommend an allowed dimension that achieves a similar effect.
3. **Regenerate UI within allowed dimensions** -- Apply the closest valid customization and present the result.

### Example guardrail interactions

**User:** "Change the primary color to red"
**Chatbot:** "I can't modify the color tokens directly -- those are defined by your vehicle's design scheme. However, I can switch to a sportier visual style which uses bolder accent treatments. Would you like me to apply the sporty style direction?"

**User:** "Make the cards bigger"
**Chatbot:** "Card sizes are fixed by the component spec to ensure safe readability while driving. I can adjust layout density to spacious, which gives each card more surrounding space and makes them feel more prominent. Want me to try that?"

**User:** "Change the border radius to 0"
**Chatbot:** "Border radius values are locked to maintain the design system's visual consistency. I can switch to a minimal or tech style direction, which uses sharper visual hierarchy. Would that work for you?"

**User:** "Remove the error color"
**Chatbot:** "Status colors (success, warning, error) are system-protected for safety visibility. These cannot be removed or changed. Is there something else I can help you customize?"

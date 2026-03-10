# HMI Widget Component Catalog

> Reference for generating spec-compliant HTML widgets for the in-vehicle negative-one-screen.

---

## Generation Constraints

All generated widgets **must** follow these rules:

1. **Size** -- Use only the grid sizes listed for each widget type. Valid sizes are `1x1`, `2x1`, `2x2`, and `4x1`. The grid is 4 columns wide with a maximum of 3 rows.
2. **Colors** -- Use only design token CSS custom properties (`var(--color-*)`). Never hardcode hex, rgb, or hsl values.
3. **Spacing** -- Use only spacing tokens (`var(--spacing-xs)` through `var(--spacing-xl)`). Never use raw pixel values for padding/margin/gap.
4. **Radius** -- Use only radius tokens (`var(--radius-sm)`, `var(--radius-md)`, `var(--radius-lg)`, `var(--radius-pill)`).
5. **Typography** -- Use only type scale presets (`var(--font-h1)` through `var(--font-caption)`) and weight tokens (`var(--font-weight-regular)`, `var(--font-weight-medium)`, `var(--font-weight-bold)`). Font family is always `var(--font-family)`.
6. **States** -- Every widget must handle four states: **normal**, **hover**, **active**, **disabled**.
7. **Themes** -- Every widget must render correctly in both **day** (light) and **night** (dark) themes. Use `var(--theme-background)` and `var(--theme-text)` for theme-aware surfaces and text.

### Available Design Tokens

| Category | Token | CSS Custom Property |
|----------|-------|---------------------|
| Color | Primary | `var(--color-primary)` |
| Color | Secondary | `var(--color-secondary)` |
| Color | Surface | `var(--color-surface)` |
| Color | Surface Dark | `var(--color-surface-dark)` |
| Color | Accent | `var(--color-accent)` |
| Color | Text Primary | `var(--color-text-primary)` |
| Color | Text Secondary | `var(--color-text-secondary)` |
| Color | Text Disabled | `var(--color-text-disabled)` |
| Color | Status Success | `var(--color-status-success)` |
| Color | Status Warning | `var(--color-status-warning)` |
| Color | Status Error | `var(--color-status-error)` |
| Typography | Font Family | `var(--font-family)` |
| Typography | H1 Size | `var(--font-h1)` |
| Typography | H2 Size | `var(--font-h2)` |
| Typography | H3 Size | `var(--font-h3)` |
| Typography | Body Size | `var(--font-body)` |
| Typography | Caption Size | `var(--font-caption)` |
| Typography | Weight Regular | `var(--font-weight-regular)` |
| Typography | Weight Medium | `var(--font-weight-medium)` |
| Typography | Weight Bold | `var(--font-weight-bold)` |
| Spacing | Extra Small | `var(--spacing-xs)` |
| Spacing | Small | `var(--spacing-sm)` |
| Spacing | Medium | `var(--spacing-md)` |
| Spacing | Large | `var(--spacing-lg)` |
| Spacing | Extra Large | `var(--spacing-xl)` |
| Radius | Small | `var(--radius-sm)` |
| Radius | Medium | `var(--radius-md)` |
| Radius | Large | `var(--radius-lg)` |
| Radius | Pill | `var(--radius-pill)` |
| Elevation | Card | `var(--elevation-card)` |
| Elevation | Modal | `var(--elevation-modal)` |
| Theme | Background | `var(--theme-background)` |
| Theme | Text | `var(--theme-text)` |
| Animation | Max Duration | `var(--animation-duration)` |
| Animation | Easing | `var(--animation-easing)` |

### CSS Class Convention

Every widget uses the pattern:

```
.hmi-widget.hmi-widget--{type}.hmi-widget--{WxH}
```

### HTML Attribute Convention

Every widget root element requires:

```
data-widget-type="{type}"
data-widget-size="{WxH}"
```

### State Classes

| State | Class | Visual Change |
|-------|-------|---------------|
| Normal | _(base styles, no extra class)_ | Default appearance |
| Hover | `.hmi-widget--hover` or `:hover` | Slight elevation increase, surface brightens |
| Active | `.hmi-widget--active` or `:active` | Scale down slightly (0.97), elevation decreases |
| Disabled | `.hmi-widget--disabled` | Opacity 0.5, pointer-events none, text uses `var(--color-text-disabled)` |

### Shared Base Styles

All widgets inherit these base styles:

```css
.hmi-widget {
  font-family: var(--font-family);
  background: var(--color-surface);
  color: var(--color-text-primary);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  box-shadow: var(--elevation-card);
  transition: all var(--animation-duration) var(--animation-easing);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  box-sizing: border-box;
}

.hmi-widget:hover,
.hmi-widget.hmi-widget--hover {
  box-shadow: var(--elevation-modal);
  filter: brightness(1.05);
}

.hmi-widget:active,
.hmi-widget.hmi-widget--active {
  transform: scale(0.97);
  box-shadow: var(--elevation-card);
}

.hmi-widget.hmi-widget--disabled {
  opacity: 0.5;
  pointer-events: none;
  color: var(--color-text-disabled);
}

/* Night theme override */
[data-theme="night"] .hmi-widget {
  background: var(--color-surface-dark);
  color: var(--theme-text);
}
```

---

## Widget 1: Navigation Card

**Description:** Displays the user's frequent destinations with live traffic status and estimated arrival time. Supports one-tap navigation launch.

**Grid Sizes:** `2x1`, `2x2`

**Data Source:** Frequent destinations + live traffic data

### Required Attributes

```html
data-widget-type="navigation"
data-widget-size="2x1"   <!-- or "2x2" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--navigation.hmi-widget--2x1
.hmi-widget.hmi-widget--navigation.hmi-widget--2x2
```

### Theme Tokens Used

- `--color-primary` -- route highlight and directional icon
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- destination name
- `--color-text-secondary` -- address, distance
- `--color-status-success` -- clear traffic
- `--color-status-warning` -- moderate traffic
- `--color-status-error` -- heavy traffic
- `--color-accent` -- ETA badge
- `--font-h3` -- destination name
- `--font-body` -- address text
- `--font-caption` -- ETA, distance
- `--font-weight-medium` -- destination name weight
- `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-md` -- card corners
- `--radius-pill` -- traffic badge
- `--elevation-card` -- card shadow

### States

| State | Behavior |
|-------|----------|
| Normal | Shows destination, ETA, and traffic indicator |
| Hover | Card elevates, destination name highlights with `--color-primary` |
| Active | Card scales to 0.97, simulates tap press |
| Disabled | Greyed out, shows "Navigation unavailable" in `--color-text-disabled` |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--navigation hmi-widget--2x1"
     data-widget-type="navigation"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
    <!-- Navigation icon -->
    <div style="
      width: 40px; height: 40px;
      border-radius: var(--radius-pill);
      background: var(--color-primary);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    ">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
        <polygon points="3 11 22 2 13 21 11 13 3 11"/>
      </svg>
    </div>
    <!-- Destination info -->
    <div style="flex: 1; min-width: 0;">
      <div style="
        font-size: var(--font-h3);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      ">Office</div>
      <div style="
        font-size: var(--font-caption);
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      ">12.3 km via Highway 101</div>
    </div>
    <!-- ETA + Traffic -->
    <div style="text-align: right; flex-shrink: 0;">
      <div style="
        font-size: var(--font-body);
        font-weight: var(--font-weight-bold);
        color: var(--color-accent);
      ">18 min</div>
      <div style="
        display: inline-block;
        font-size: var(--font-caption);
        color: var(--color-surface);
        background: var(--color-status-success);
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-pill);
        margin-top: var(--spacing-xs);
      ">Clear</div>
    </div>
  </div>
</div>
```

### HTML Structure -- 2x2

```html
<div class="hmi-widget hmi-widget--navigation hmi-widget--2x2"
     data-widget-type="navigation"
     data-widget-size="2x2">
  <!-- Map preview area -->
  <div style="
    height: 50%;
    background: var(--color-secondary);
    border-radius: var(--radius-sm);
    margin-bottom: var(--spacing-sm);
    display: flex; align-items: center; justify-content: center;
    opacity: 0.3;
  ">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-primary)" stroke-width="1.5">
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
      <line x1="8" y1="2" x2="8" y2="18"/>
      <line x1="16" y1="6" x2="16" y2="22"/>
    </svg>
  </div>
  <!-- Destination list -->
  <div style="display: flex; flex-direction: column; gap: var(--spacing-sm);">
    <!-- Destination row 1 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
      <div style="
        width: 32px; height: 32px;
        border-radius: var(--radius-pill);
        background: var(--color-primary);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      ">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <polygon points="3 11 22 2 13 21 11 13 3 11"/>
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Office</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">12.3 km</div>
      </div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-accent); flex-shrink: 0;">18 min</div>
    </div>
    <!-- Destination row 2 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
      <div style="
        width: 32px; height: 32px;
        border-radius: var(--radius-pill);
        background: var(--color-secondary);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      ">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Home</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">8.7 km</div>
      </div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-accent); flex-shrink: 0;">14 min</div>
    </div>
  </div>
</div>
```

---

## Widget 2: Weather Card

**Description:** Displays current weather conditions at the vehicle's location, including temperature, condition icon, and a brief forecast summary.

**Grid Sizes:** `1x1`, `2x1`

**Data Source:** Current location + weather API

### Required Attributes

```html
data-widget-type="weather"
data-widget-size="1x1"   <!-- or "2x1" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--weather.hmi-widget--1x1
.hmi-widget.hmi-widget--weather.hmi-widget--2x1
```

### Theme Tokens Used

- `--color-primary` -- temperature value accent
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- temperature display
- `--color-text-secondary` -- condition text, location
- `--color-accent` -- high temperature
- `--font-h2` -- temperature (1x1 size)
- `--font-h1` -- temperature (2x1 size)
- `--font-body` -- condition description
- `--font-caption` -- location, high/low
- `--font-weight-bold` -- temperature weight
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-md` -- card corners

### States

| State | Behavior |
|-------|----------|
| Normal | Shows temperature, condition icon, and location |
| Hover | Card elevates, condition text reveals forecast detail |
| Active | Card scales to 0.97 |
| Disabled | Greyed out, shows last known data with "Offline" label |

### HTML Structure -- 1x1

```html
<div class="hmi-widget hmi-widget--weather hmi-widget--1x1"
     data-widget-type="weather"
     data-widget-size="1x1">
  <div style="
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100%; text-align: center;
    gap: var(--spacing-xs);
  ">
    <!-- Weather icon -->
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="2">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/>
      <line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
    <!-- Temperature -->
    <div style="
      font-size: var(--font-h2);
      font-weight: var(--font-weight-bold);
      color: var(--color-text-primary);
    ">24°</div>
    <!-- Condition -->
    <div style="
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    ">Sunny</div>
  </div>
</div>
```

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--weather hmi-widget--2x1"
     data-widget-type="weather"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Weather icon -->
    <div style="flex-shrink: 0;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="1.5">
        <circle cx="12" cy="12" r="5"/>
        <line x1="12" y1="1" x2="12" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/>
        <line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
      </svg>
    </div>
    <!-- Temperature and details -->
    <div style="flex: 1;">
      <div style="
        font-size: var(--font-h1);
        font-weight: var(--font-weight-bold);
        color: var(--color-text-primary);
        line-height: 1.1;
      ">24°C</div>
      <div style="
        font-size: var(--font-body);
        color: var(--color-text-secondary);
      ">Sunny</div>
    </div>
    <!-- High / Low -->
    <div style="text-align: right; flex-shrink: 0;">
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">
        <span style="color: var(--color-accent);">H 28°</span>
      </div>
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">
        <span>L 19°</span>
      </div>
      <div style="
        font-size: var(--font-caption);
        color: var(--color-text-secondary);
        margin-top: var(--spacing-xs);
      ">San Francisco</div>
    </div>
  </div>
</div>
```

---

## Widget 3: Music Control

**Description:** Shows the currently playing track with playback controls (play/pause, skip). Displays artist, track name, album art placeholder, and a progress indicator.

**Grid Sizes:** `2x1`, `4x1`

**Data Source:** Now playing track + playlist data

### Required Attributes

```html
data-widget-type="music"
data-widget-size="2x1"   <!-- or "4x1" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--music.hmi-widget--2x1
.hmi-widget.hmi-widget--music.hmi-widget--4x1
```

### Theme Tokens Used

- `--color-primary` -- play/pause button, progress bar fill
- `--color-secondary` -- progress bar track, skip button
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- track title
- `--color-text-secondary` -- artist name, time indicators
- `--color-accent` -- album art placeholder accent
- `--font-h3` -- track title
- `--font-body` -- artist name
- `--font-caption` -- time stamps
- `--font-weight-medium` -- track title weight
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-sm` -- album art corners
- `--radius-md` -- card corners
- `--radius-pill` -- progress bar, control buttons

### States

| State | Behavior |
|-------|----------|
| Normal | Shows track info, album art, and playback controls |
| Hover | Control buttons brighten, progress bar shows seek handle |
| Active | Pressed control button scales to 0.9 |
| Disabled | Controls greyed out, shows "No media" in `--color-text-disabled` |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--music hmi-widget--2x1"
     data-widget-type="music"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
    <!-- Album art placeholder -->
    <div style="
      width: 48px; height: 48px;
      border-radius: var(--radius-sm);
      background: var(--color-accent);
      opacity: 0.2;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    ">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="2" style="opacity: 1;">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </div>
    <!-- Track info -->
    <div style="flex: 1; min-width: 0;">
      <div style="
        font-size: var(--font-h3);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      ">Midnight Drive</div>
      <div style="
        font-size: var(--font-body);
        color: var(--color-text-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      ">Neon Waves</div>
    </div>
    <!-- Controls -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex-shrink: 0;">
      <button style="
        width: 32px; height: 32px; border: none; background: none;
        color: var(--color-secondary); cursor: pointer; padding: 0;
      ">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--color-secondary)">
          <polygon points="19 20 9 12 19 4 19 20"/>
          <line x1="5" y1="19" x2="5" y2="5" stroke="var(--color-secondary)" stroke-width="2"/>
        </svg>
      </button>
      <button style="
        width: 40px; height: 40px; border: none;
        border-radius: var(--radius-pill);
        background: var(--color-primary);
        color: var(--color-surface);
        cursor: pointer; padding: 0;
        display: flex; align-items: center; justify-content: center;
      ">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--color-surface)">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </button>
      <button style="
        width: 32px; height: 32px; border: none; background: none;
        color: var(--color-secondary); cursor: pointer; padding: 0;
      ">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--color-secondary)">
          <polygon points="5 4 15 12 5 20 5 4"/>
          <line x1="19" y1="5" x2="19" y2="19" stroke="var(--color-secondary)" stroke-width="2"/>
        </svg>
      </button>
    </div>
  </div>
</div>
```

### HTML Structure -- 4x1

```html
<div class="hmi-widget hmi-widget--music hmi-widget--4x1"
     data-widget-type="music"
     data-widget-size="4x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Album art placeholder -->
    <div style="
      width: 48px; height: 48px;
      border-radius: var(--radius-sm);
      background: var(--color-accent);
      opacity: 0.2;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    ">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="2" style="opacity: 1;">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </div>
    <!-- Track info -->
    <div style="flex: 1; min-width: 0;">
      <div style="
        font-size: var(--font-h3);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      ">Midnight Drive</div>
      <div style="
        font-size: var(--font-body);
        color: var(--color-text-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      ">Neon Waves</div>
    </div>
    <!-- Progress bar -->
    <div style="flex: 2; display: flex; align-items: center; gap: var(--spacing-sm);">
      <span style="font-size: var(--font-caption); color: var(--color-text-secondary);">1:42</span>
      <div style="flex: 1; height: 4px; background: var(--color-secondary); border-radius: var(--radius-pill); overflow: hidden;">
        <div style="width: 45%; height: 100%; background: var(--color-primary); border-radius: var(--radius-pill);"></div>
      </div>
      <span style="font-size: var(--font-caption); color: var(--color-text-secondary);">3:48</span>
    </div>
    <!-- Controls -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex-shrink: 0;">
      <button style="width: 32px; height: 32px; border: none; background: none; color: var(--color-secondary); cursor: pointer; padding: 0;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--color-secondary)">
          <polygon points="19 20 9 12 19 4 19 20"/>
          <line x1="5" y1="19" x2="5" y2="5" stroke="var(--color-secondary)" stroke-width="2"/>
        </svg>
      </button>
      <button style="
        width: 40px; height: 40px; border: none;
        border-radius: var(--radius-pill);
        background: var(--color-primary);
        color: var(--color-surface);
        cursor: pointer; padding: 0;
        display: flex; align-items: center; justify-content: center;
      ">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--color-surface)">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </button>
      <button style="width: 32px; height: 32px; border: none; background: none; color: var(--color-secondary); cursor: pointer; padding: 0;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--color-secondary)">
          <polygon points="5 4 15 12 5 20 5 4"/>
          <line x1="19" y1="5" x2="19" y2="19" stroke="var(--color-secondary)" stroke-width="2"/>
        </svg>
      </button>
    </div>
  </div>
</div>
```

---

## Widget 4: Quick Toggles

**Description:** A single toggle button for a vehicle function -- window, AC, or seat heating. Shows the current on/off state with an icon and label.

**Grid Sizes:** `1x1`

**Data Source:** Vehicle controls (windows, AC, seat heating)

### Required Attributes

```html
data-widget-type="toggle"
data-widget-size="1x1"
```

### CSS Classes

```
.hmi-widget.hmi-widget--toggle.hmi-widget--1x1
```

### Theme Tokens Used

- `--color-primary` -- active/on state background
- `--color-secondary` -- inactive/off state icon
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- label text (on state)
- `--color-text-secondary` -- label text (off state)
- `--color-accent` -- active icon highlight
- `--font-caption` -- label text
- `--font-weight-medium` -- label weight
- `--spacing-xs`, `--spacing-sm` -- internal layout
- `--radius-md` -- card corners
- `--radius-pill` -- icon container

### States

| State | Behavior |
|-------|----------|
| Normal (off) | Muted icon with `--color-secondary`, label shows feature name |
| Normal (on) | Icon uses `--color-primary` background, label shows "On" |
| Hover | Slight brightness increase on icon container |
| Active | Scale to 0.95, haptic-like press feedback |
| Disabled | Greyed out entirely, "Unavailable" caption |

### HTML Structure -- 1x1

```html
<div class="hmi-widget hmi-widget--toggle hmi-widget--1x1"
     data-widget-type="toggle"
     data-widget-size="1x1">
  <div style="
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100%; gap: var(--spacing-sm);
  ">
    <!-- Toggle icon container -->
    <div style="
      width: 48px; height: 48px;
      border-radius: var(--radius-pill);
      background: var(--color-primary);
      display: flex; align-items: center; justify-content: center;
      transition: all var(--animation-duration) var(--animation-easing);
    ">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    </div>
    <!-- Label -->
    <div style="
      font-size: var(--font-caption);
      font-weight: var(--font-weight-medium);
      color: var(--color-text-primary);
      text-align: center;
    ">AC On</div>
  </div>
</div>
```

**Off-state variant** -- replace the icon container background:

```html
<!-- Off state: swap background to transparent with border -->
<div style="
  width: 48px; height: 48px;
  border-radius: var(--radius-pill);
  background: transparent;
  border: 2px solid var(--color-secondary);
  display: flex; align-items: center; justify-content: center;
  transition: all var(--animation-duration) var(--animation-easing);
">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-secondary)" stroke-width="2">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
    <polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
</div>
<!-- Label shows "AC Off" with secondary color -->
<div style="
  font-size: var(--font-caption);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
  text-align: center;
">AC Off</div>
```

---

## Widget 5: Clock Display

**Description:** Shows the current system time in a large, readable format. The compact 1x1 shows time only; the 2x1 adds date and timezone.

**Grid Sizes:** `1x1`, `2x1`

**Data Source:** System time

### Required Attributes

```html
data-widget-type="clock"
data-widget-size="1x1"   <!-- or "2x1" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--clock.hmi-widget--1x1
.hmi-widget.hmi-widget--clock.hmi-widget--2x1
```

### Theme Tokens Used

- `--color-text-primary` -- time digits
- `--color-text-secondary` -- seconds, date, AM/PM
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-primary` -- colon separator accent
- `--font-h1` -- time display (2x1)
- `--font-h2` -- time display (1x1)
- `--font-caption` -- date, timezone
- `--font-weight-bold` -- time digits
- `--font-weight-regular` -- date text
- `--spacing-xs`, `--spacing-sm` -- internal layout
- `--radius-md` -- card corners

### States

| State | Behavior |
|-------|----------|
| Normal | Displays current time, colon may blink (animation) |
| Hover | Reveals timezone info (2x1) or date (1x1) |
| Active | No special action (informational widget) |
| Disabled | Shows "-- : --" in `--color-text-disabled` |

### HTML Structure -- 1x1

```html
<div class="hmi-widget hmi-widget--clock hmi-widget--1x1"
     data-widget-type="clock"
     data-widget-size="1x1">
  <div style="
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100%;
  ">
    <div style="
      font-size: var(--font-h2);
      font-weight: var(--font-weight-bold);
      color: var(--color-text-primary);
      letter-spacing: 2px;
    ">
      <span>10</span><span style="color: var(--color-primary);">:</span><span>30</span>
    </div>
    <div style="
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
      margin-top: var(--spacing-xs);
    ">AM</div>
  </div>
</div>
```

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--clock hmi-widget--2x1"
     data-widget-type="clock"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; justify-content: space-between;">
    <!-- Time display -->
    <div>
      <div style="
        font-size: var(--font-h1);
        font-weight: var(--font-weight-bold);
        color: var(--color-text-primary);
        letter-spacing: 2px;
        line-height: 1.1;
      ">
        <span>10</span><span style="color: var(--color-primary);">:</span><span>30</span>
        <span style="font-size: var(--font-body); font-weight: var(--font-weight-regular); color: var(--color-text-secondary); margin-left: var(--spacing-xs);">AM</span>
      </div>
    </div>
    <!-- Date and timezone -->
    <div style="text-align: right;">
      <div style="
        font-size: var(--font-body);
        color: var(--color-text-primary);
        font-weight: var(--font-weight-medium);
      ">Monday</div>
      <div style="
        font-size: var(--font-caption);
        color: var(--color-text-secondary);
      ">Mar 10, 2026</div>
      <div style="
        font-size: var(--font-caption);
        color: var(--color-text-secondary);
        margin-top: var(--spacing-xs);
      ">PST (UTC-8)</div>
    </div>
  </div>
</div>
```

---

## Widget 6: Notification Card

**Description:** Displays a recent notification -- message preview, reminder, or calendar alert -- with sender/source info and timestamp.

**Grid Sizes:** `2x1`

**Data Source:** Messages, reminders, and calendar events

### Required Attributes

```html
data-widget-type="notification"
data-widget-size="2x1"
```

### CSS Classes

```
.hmi-widget.hmi-widget--notification.hmi-widget--2x1
```

### Theme Tokens Used

- `--color-primary` -- unread indicator dot
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- sender name, notification title
- `--color-text-secondary` -- message preview, timestamp
- `--color-accent` -- notification type icon background
- `--color-status-warning` -- urgent notification highlight
- `--font-h3` -- sender name / title
- `--font-body` -- message preview
- `--font-caption` -- timestamp
- `--font-weight-medium` -- sender name
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-md` -- card corners
- `--radius-pill` -- avatar, unread dot

### States

| State | Behavior |
|-------|----------|
| Normal | Shows notification with unread indicator if new |
| Hover | Card elevates, message preview expands slightly |
| Active | Card scales to 0.97, opens notification detail |
| Disabled | Notification content hidden, shows "Notifications paused" |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--notification hmi-widget--2x1"
     data-widget-type="notification"
     data-widget-size="2x1">
  <div style="display: flex; align-items: flex-start; gap: var(--spacing-sm);">
    <!-- Avatar / Icon -->
    <div style="position: relative; flex-shrink: 0;">
      <div style="
        width: 40px; height: 40px;
        border-radius: var(--radius-pill);
        background: var(--color-accent);
        opacity: 0.15;
        display: flex; align-items: center; justify-content: center;
      ">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" stroke-width="2" style="opacity: 1;">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
      </div>
      <!-- Unread dot -->
      <div style="
        position: absolute; top: -2px; right: -2px;
        width: 10px; height: 10px;
        border-radius: var(--radius-pill);
        background: var(--color-primary);
        border: 2px solid var(--color-surface);
      "></div>
    </div>
    <!-- Content -->
    <div style="flex: 1; min-width: 0;">
      <div style="display: flex; justify-content: space-between; align-items: baseline;">
        <div style="
          font-size: var(--font-h3);
          font-weight: var(--font-weight-medium);
          color: var(--color-text-primary);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        ">Alex Chen</div>
        <div style="
          font-size: var(--font-caption);
          color: var(--color-text-secondary);
          flex-shrink: 0;
          margin-left: var(--spacing-sm);
        ">2 min ago</div>
      </div>
      <div style="
        font-size: var(--font-body);
        color: var(--color-text-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        margin-top: var(--spacing-xs);
      ">Meeting moved to 3 PM. Can you update the calendar?</div>
    </div>
  </div>
</div>
```

---

## Widget 7: Vehicle Status

**Description:** Comprehensive vehicle status dashboard showing tire pressure, fuel/battery level, mileage, and key system indicators in a grid layout.

**Grid Sizes:** `2x2`

**Data Source:** Tire pressure, fuel level, battery status, odometer / mileage

### Required Attributes

```html
data-widget-type="vehicle-status"
data-widget-size="2x2"
```

### CSS Classes

```
.hmi-widget.hmi-widget--vehicle-status.hmi-widget--2x2
```

### Theme Tokens Used

- `--color-primary` -- section headers, fuel/battery gauge fill
- `--color-secondary` -- gauge track background
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- values, labels
- `--color-text-secondary` -- unit labels
- `--color-status-success` -- normal tire pressure, good fuel
- `--color-status-warning` -- low tire pressure, low fuel
- `--color-status-error` -- critical levels
- `--font-h3` -- widget title
- `--font-body` -- metric values
- `--font-caption` -- metric labels, units
- `--font-weight-bold` -- metric values
- `--font-weight-medium` -- section titles
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-sm` -- inner card sections
- `--radius-md` -- card corners
- `--radius-pill` -- gauge bars

### States

| State | Behavior |
|-------|----------|
| Normal | Shows all vehicle metrics with color-coded status |
| Hover | Individual metric sections highlight on hover |
| Active | Tapping a metric section opens detail view |
| Disabled | All values show "--", label reads "Vehicle data unavailable" |

### HTML Structure -- 2x2

```html
<div class="hmi-widget hmi-widget--vehicle-status hmi-widget--2x2"
     data-widget-type="vehicle-status"
     data-widget-size="2x2">
  <!-- Title -->
  <div style="
    font-size: var(--font-h3);
    font-weight: var(--font-weight-medium);
    color: var(--color-text-primary);
    margin-bottom: var(--spacing-sm);
  ">Vehicle Status</div>

  <!-- Metrics grid: 2x2 inner layout -->
  <div style="
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-sm);
    flex: 1;
  ">
    <!-- Fuel / Battery -->
    <div style="
      background: var(--color-surface);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    ">
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary); margin-bottom: var(--spacing-xs);">Fuel</div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-text-primary);">72%</div>
      <div style="
        height: 4px;
        background: var(--color-secondary);
        border-radius: var(--radius-pill);
        margin-top: var(--spacing-xs);
        overflow: hidden;
      ">
        <div style="width: 72%; height: 100%; background: var(--color-status-success); border-radius: var(--radius-pill);"></div>
      </div>
    </div>

    <!-- Mileage -->
    <div style="
      background: var(--color-surface);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    ">
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary); margin-bottom: var(--spacing-xs);">Odometer</div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-text-primary);">24,850</div>
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary); margin-top: var(--spacing-xs);">km</div>
    </div>

    <!-- Tire Pressure (front) -->
    <div style="
      background: var(--color-surface);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    ">
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary); margin-bottom: var(--spacing-xs);">Tires (Front)</div>
      <div style="display: flex; justify-content: space-between;">
        <div>
          <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-status-success);">2.4</div>
          <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">FL bar</div>
        </div>
        <div>
          <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-status-success);">2.4</div>
          <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">FR bar</div>
        </div>
      </div>
    </div>

    <!-- Tire Pressure (rear) -->
    <div style="
      background: var(--color-surface);
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
    ">
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary); margin-bottom: var(--spacing-xs);">Tires (Rear)</div>
      <div style="display: flex; justify-content: space-between;">
        <div>
          <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-status-warning);">2.1</div>
          <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">RL bar</div>
        </div>
        <div>
          <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-status-success);">2.3</div>
          <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">RR bar</div>
        </div>
      </div>
    </div>
  </div>
</div>
```

---

## Widget 8: Energy Stats

**Description:** Displays trip energy usage and average consumption data with a simple bar or gauge visualization. Useful for EVs and hybrids.

**Grid Sizes:** `2x1`, `2x2`

**Data Source:** Trip energy consumption, average consumption history

### Required Attributes

```html
data-widget-type="energy"
data-widget-size="2x1"   <!-- or "2x2" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--energy.hmi-widget--2x1
.hmi-widget.hmi-widget--energy.hmi-widget--2x2
```

### Theme Tokens Used

- `--color-primary` -- energy gauge fill, primary metric
- `--color-secondary` -- gauge track
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- metric values
- `--color-text-secondary` -- labels, units
- `--color-status-success` -- efficient range
- `--color-status-warning` -- moderate consumption
- `--color-accent` -- average line indicator
- `--font-h3` -- widget title, primary metric value
- `--font-body` -- secondary metrics
- `--font-caption` -- labels, units
- `--font-weight-bold` -- metric values
- `--font-weight-medium` -- title
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-sm` -- inner sections
- `--radius-md` -- card corners
- `--radius-pill` -- bar chart segments

### States

| State | Behavior |
|-------|----------|
| Normal | Shows energy stats with consumption gauge |
| Hover | Gauge values display exact numbers with units |
| Active | Card scales to 0.97, opens energy detail |
| Disabled | Shows "--" values, "No trip data" message |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--energy hmi-widget--2x1"
     data-widget-type="energy"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Energy icon + value -->
    <div style="flex-shrink: 0; text-align: center;">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      <div style="
        font-size: var(--font-h3);
        font-weight: var(--font-weight-bold);
        color: var(--color-text-primary);
        margin-top: var(--spacing-xs);
      ">14.2</div>
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">kWh/100km</div>
    </div>
    <!-- Consumption bar -->
    <div style="flex: 1;">
      <div style="
        display: flex; justify-content: space-between;
        margin-bottom: var(--spacing-xs);
      ">
        <span style="font-size: var(--font-caption); color: var(--color-text-secondary);">Avg Consumption</span>
        <span style="font-size: var(--font-caption); color: var(--color-status-success);">Efficient</span>
      </div>
      <div style="
        height: 8px;
        background: var(--color-secondary);
        border-radius: var(--radius-pill);
        overflow: hidden;
      ">
        <div style="width: 60%; height: 100%; background: var(--color-status-success); border-radius: var(--radius-pill);"></div>
      </div>
      <div style="
        display: flex; justify-content: space-between;
        margin-top: var(--spacing-xs);
      ">
        <span style="font-size: var(--font-caption); color: var(--color-text-secondary);">Trip: 42.3 km</span>
        <span style="font-size: var(--font-caption); color: var(--color-text-secondary);">6.0 kWh used</span>
      </div>
    </div>
  </div>
</div>
```

### HTML Structure -- 2x2

```html
<div class="hmi-widget hmi-widget--energy hmi-widget--2x2"
     data-widget-type="energy"
     data-widget-size="2x2">
  <!-- Title -->
  <div style="
    font-size: var(--font-h3);
    font-weight: var(--font-weight-medium);
    color: var(--color-text-primary);
    margin-bottom: var(--spacing-sm);
  ">Energy Stats</div>

  <!-- Primary metric -->
  <div style="display: flex; align-items: baseline; gap: var(--spacing-sm); margin-bottom: var(--spacing-md);">
    <div style="
      font-size: var(--font-h1);
      font-weight: var(--font-weight-bold);
      color: var(--color-primary);
    ">14.2</div>
    <div style="font-size: var(--font-body); color: var(--color-text-secondary);">kWh/100km</div>
  </div>

  <!-- Bar chart (simplified last 5 trips) -->
  <div style="
    display: flex;
    align-items: flex-end;
    gap: var(--spacing-xs);
    height: 48px;
    margin-bottom: var(--spacing-sm);
  ">
    <div style="flex: 1; height: 60%; background: var(--color-status-success); border-radius: var(--radius-sm) var(--radius-sm) 0 0;"></div>
    <div style="flex: 1; height: 80%; background: var(--color-status-warning); border-radius: var(--radius-sm) var(--radius-sm) 0 0;"></div>
    <div style="flex: 1; height: 45%; background: var(--color-status-success); border-radius: var(--radius-sm) var(--radius-sm) 0 0;"></div>
    <div style="flex: 1; height: 70%; background: var(--color-status-success); border-radius: var(--radius-sm) var(--radius-sm) 0 0;"></div>
    <div style="flex: 1; height: 55%; background: var(--color-primary); border-radius: var(--radius-sm) var(--radius-sm) 0 0; border: 2px solid var(--color-primary);"></div>
  </div>
  <div style="display: flex; justify-content: space-between; font-size: var(--font-caption); color: var(--color-text-secondary);">
    <span>5 trips ago</span>
    <span>Current</span>
  </div>

  <!-- Summary row -->
  <div style="
    display: flex; justify-content: space-between;
    margin-top: var(--spacing-sm);
    padding-top: var(--spacing-sm);
    border-top: 1px solid var(--color-secondary);
  ">
    <div>
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Total Distance</div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-text-primary);">42.3 km</div>
    </div>
    <div>
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Energy Used</div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-text-primary);">6.0 kWh</div>
    </div>
    <div>
      <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Range Left</div>
      <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-status-success);">285 km</div>
    </div>
  </div>
</div>
```

---

## Widget 9: Calendar Card

**Description:** Shows today's schedule at a glance -- the next upcoming meeting/event with time, title, and location.

**Grid Sizes:** `2x1`

**Data Source:** Today's calendar schedule, next meeting

### Required Attributes

```html
data-widget-type="calendar"
data-widget-size="2x1"
```

### CSS Classes

```
.hmi-widget.hmi-widget--calendar.hmi-widget--2x1
```

### Theme Tokens Used

- `--color-primary` -- event time indicator, left accent bar
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- event title
- `--color-text-secondary` -- event time, location
- `--color-accent` -- "Now" or "Next" badge
- `--font-h3` -- event title
- `--font-body` -- event location
- `--font-caption` -- event time, remaining count
- `--font-weight-medium` -- event title
- `--font-weight-bold` -- time value
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-sm` -- accent bar
- `--radius-md` -- card corners
- `--radius-pill` -- "Next" badge

### States

| State | Behavior |
|-------|----------|
| Normal | Shows next event with time, title, and location |
| Hover | Card elevates, shows full-day event count |
| Active | Card scales to 0.97, opens calendar detail |
| Disabled | Shows "No calendar connected" in `--color-text-disabled` |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--calendar hmi-widget--2x1"
     data-widget-type="calendar"
     data-widget-size="2x1">
  <div style="display: flex; gap: var(--spacing-sm);">
    <!-- Left accent bar -->
    <div style="
      width: 4px;
      border-radius: var(--radius-sm);
      background: var(--color-primary);
      flex-shrink: 0;
    "></div>
    <!-- Event content -->
    <div style="flex: 1; min-width: 0;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--spacing-xs);">
        <div style="
          font-size: var(--font-caption);
          font-weight: var(--font-weight-bold);
          color: var(--color-primary);
        ">10:30 AM - 11:00 AM</div>
        <div style="
          font-size: var(--font-caption);
          color: var(--color-surface);
          background: var(--color-accent);
          padding: var(--spacing-xs) var(--spacing-sm);
          border-radius: var(--radius-pill);
        ">Next</div>
      </div>
      <div style="
        font-size: var(--font-h3);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      ">Product Design Review</div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: var(--spacing-xs);">
        <div style="
          font-size: var(--font-caption);
          color: var(--color-text-secondary);
          display: flex; align-items: center; gap: var(--spacing-xs);
        ">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" stroke-width="2">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          Conference Room B
        </div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">+3 more today</div>
      </div>
    </div>
  </div>
</div>
```

---

## Widget 10: Quick Dial

**Description:** Displays frequent contacts for one-tap calling. Shows contact avatar, name, and a call action button.

**Grid Sizes:** `2x1`, `4x1`

**Data Source:** Frequent contacts list

### Required Attributes

```html
data-widget-type="dial"
data-widget-size="2x1"   <!-- or "4x1" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--dial.hmi-widget--2x1
.hmi-widget.hmi-widget--dial.hmi-widget--4x1
```

### Theme Tokens Used

- `--color-primary` -- call button background
- `--color-secondary` -- avatar placeholder background
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- contact name
- `--color-text-secondary` -- contact role/label
- `--color-status-success` -- call button (active call state)
- `--font-body` -- contact name
- `--font-caption` -- contact label
- `--font-weight-medium` -- contact name
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-md` -- card corners
- `--radius-pill` -- avatars, call button

### States

| State | Behavior |
|-------|----------|
| Normal | Shows contact row(s) with call buttons |
| Hover | Call button brightens, contact name highlights |
| Active | Call button turns `--color-status-success`, shows "Calling..." |
| Disabled | Call buttons greyed out, "Phone unavailable" |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--dial hmi-widget--2x1"
     data-widget-type="dial"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Contact 1 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
      <div style="
        width: 40px; height: 40px;
        border-radius: var(--radius-pill);
        background: var(--color-secondary);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
        font-size: var(--font-body);
        font-weight: var(--font-weight-bold);
        color: var(--color-surface);
      ">JD</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Jane Doe</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Mobile</div>
      </div>
      <button style="
        width: 36px; height: 36px;
        border-radius: var(--radius-pill);
        border: none;
        background: var(--color-primary);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      </button>
    </div>
    <!-- Divider -->
    <div style="width: 1px; height: 32px; background: var(--color-secondary);"></div>
    <!-- Contact 2 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
      <div style="
        width: 40px; height: 40px;
        border-radius: var(--radius-pill);
        background: var(--color-accent);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
        font-size: var(--font-body);
        font-weight: var(--font-weight-bold);
        color: var(--color-surface);
      ">MS</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Mike Smith</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Work</div>
      </div>
      <button style="
        width: 36px; height: 36px;
        border-radius: var(--radius-pill);
        border: none;
        background: var(--color-primary);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      </button>
    </div>
  </div>
</div>
```

### HTML Structure -- 4x1

```html
<div class="hmi-widget hmi-widget--dial hmi-widget--4x1"
     data-widget-type="dial"
     data-widget-size="4x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Contact 1 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
      <div style="width: 40px; height: 40px; border-radius: var(--radius-pill); background: var(--color-secondary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-surface);">JD</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Jane Doe</div>
      </div>
      <button style="width: 36px; height: 36px; border-radius: var(--radius-pill); border: none; background: var(--color-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    </div>
    <div style="width: 1px; height: 32px; background: var(--color-secondary);"></div>
    <!-- Contact 2 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
      <div style="width: 40px; height: 40px; border-radius: var(--radius-pill); background: var(--color-accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-surface);">MS</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Mike Smith</div>
      </div>
      <button style="width: 36px; height: 36px; border-radius: var(--radius-pill); border: none; background: var(--color-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    </div>
    <div style="width: 1px; height: 32px; background: var(--color-secondary);"></div>
    <!-- Contact 3 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
      <div style="width: 40px; height: 40px; border-radius: var(--radius-pill); background: var(--color-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-surface);">AL</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Amy Lee</div>
      </div>
      <button style="width: 36px; height: 36px; border-radius: var(--radius-pill); border: none; background: var(--color-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    </div>
    <div style="width: 1px; height: 32px; background: var(--color-secondary);"></div>
    <!-- Contact 4 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0;">
      <div style="width: 40px; height: 40px; border-radius: var(--radius-pill); background: var(--color-status-success); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-surface);">BW</div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Bob Wu</div>
      </div>
      <button style="width: 36px; height: 36px; border-radius: var(--radius-pill); border: none; background: var(--color-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    </div>
  </div>
</div>
```

---

## Widget 11: Smart Suggestions

**Description:** AI-driven contextual suggestions based on current time, user habits, and location. Suggests actions like "Navigate to office" (morning) or "Play evening playlist" (evening).

**Grid Sizes:** `2x1`, `4x1`

**Data Source:** Time-of-day context, user habit patterns, current location

### Required Attributes

```html
data-widget-type="suggestions"
data-widget-size="2x1"   <!-- or "4x1" -->
```

### CSS Classes

```
.hmi-widget.hmi-widget--suggestions.hmi-widget--2x1
.hmi-widget.hmi-widget--suggestions.hmi-widget--4x1
```

### Theme Tokens Used

- `--color-primary` -- suggestion icon background, action text
- `--color-secondary` -- secondary suggestion icon
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- suggestion title
- `--color-text-secondary` -- suggestion reason/context
- `--color-accent` -- highlighted/top suggestion
- `--font-h3` -- widget title
- `--font-body` -- suggestion text
- `--font-caption` -- context reason
- `--font-weight-medium` -- suggestion text
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-sm` -- suggestion item background
- `--radius-md` -- card corners
- `--radius-pill` -- suggestion icon

### States

| State | Behavior |
|-------|----------|
| Normal | Shows 1-2 contextual suggestions with icons |
| Hover | Hovered suggestion highlights, shows "Tap to start" |
| Active | Suggestion scales to 0.95, triggers the action |
| Disabled | Shows "Suggestions paused" in `--color-text-disabled` |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--suggestions hmi-widget--2x1"
     data-widget-type="suggestions"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-sm);">
    <!-- Suggestion icon -->
    <div style="
      width: 40px; height: 40px;
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    ">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
        <polygon points="3 11 22 2 13 21 11 13 3 11"/>
      </svg>
    </div>
    <!-- Suggestion content -->
    <div style="flex: 1; min-width: 0;">
      <div style="
        font-size: var(--font-body);
        font-weight: var(--font-weight-medium);
        color: var(--color-text-primary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      ">Navigate to Office</div>
      <div style="
        font-size: var(--font-caption);
        color: var(--color-text-secondary);
      ">Based on your weekday routine</div>
    </div>
    <!-- Action arrow -->
    <div style="flex-shrink: 0;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  </div>
</div>
```

### HTML Structure -- 4x1

```html
<div class="hmi-widget hmi-widget--suggestions hmi-widget--4x1"
     data-widget-type="suggestions"
     data-widget-size="4x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Title -->
    <div style="
      font-size: var(--font-h3);
      font-weight: var(--font-weight-medium);
      color: var(--color-text-primary);
      flex-shrink: 0;
    ">Suggestions</div>

    <!-- Divider -->
    <div style="width: 1px; height: 32px; background: var(--color-secondary); flex-shrink: 0;"></div>

    <!-- Suggestion 1 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0; padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); background: var(--color-surface);">
      <div style="width: 32px; height: 32px; border-radius: var(--radius-pill); background: var(--color-accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <polygon points="3 11 22 2 13 21 11 13 3 11"/>
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Navigate to Office</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Weekday routine</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" style="flex-shrink: 0;">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>

    <!-- Suggestion 2 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0; padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); background: var(--color-surface);">
      <div style="width: 32px; height: 32px; border-radius: var(--radius-pill); background: var(--color-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polygon points="10 8 16 12 10 16 10 8"/>
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Morning Playlist</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Usually played at this time</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" style="flex-shrink: 0;">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>

    <!-- Suggestion 3 -->
    <div style="display: flex; align-items: center; gap: var(--spacing-sm); flex: 1; min-width: 0; padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--radius-sm); background: var(--color-surface);">
      <div style="width: 32px; height: 32px; border-radius: var(--radius-pill); background: var(--color-secondary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-surface)" stroke-width="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/>
        </svg>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-medium); color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Call Jane Doe</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">Missed call yesterday</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" style="flex-shrink: 0;">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  </div>
</div>
```

---

## Widget 12: Trip Record

**Description:** Summarizes the most recent trip -- distance, duration, average speed, and route overview in a compact format.

**Grid Sizes:** `2x1`

**Data Source:** Recent trip summary data

### Required Attributes

```html
data-widget-type="trip"
data-widget-size="2x1"
```

### CSS Classes

```
.hmi-widget.hmi-widget--trip.hmi-widget--2x1
```

### Theme Tokens Used

- `--color-primary` -- route icon, distance value
- `--color-secondary` -- divider lines
- `--color-surface` / `--color-surface-dark` -- card background
- `--color-text-primary` -- metric values
- `--color-text-secondary` -- metric labels
- `--color-accent` -- trip start/end markers
- `--font-h3` -- primary metric (distance)
- `--font-body` -- secondary metrics
- `--font-caption` -- metric labels, timestamps
- `--font-weight-bold` -- metric values
- `--font-weight-medium` -- widget title
- `--spacing-xs`, `--spacing-sm`, `--spacing-md` -- internal layout
- `--radius-md` -- card corners

### States

| State | Behavior |
|-------|----------|
| Normal | Shows trip summary with key metrics |
| Hover | Card elevates, shows "View full trip" hint |
| Active | Card scales to 0.97, opens trip detail |
| Disabled | Shows "No recent trips" in `--color-text-disabled` |

### HTML Structure -- 2x1

```html
<div class="hmi-widget hmi-widget--trip hmi-widget--2x1"
     data-widget-type="trip"
     data-widget-size="2x1">
  <div style="display: flex; align-items: center; gap: var(--spacing-md);">
    <!-- Route icon -->
    <div style="flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 2px;">
      <div style="width: 10px; height: 10px; border-radius: var(--radius-pill); background: var(--color-accent);"></div>
      <div style="width: 2px; height: 20px; background: var(--color-secondary);"></div>
      <div style="width: 10px; height: 10px; border-radius: var(--radius-pill); border: 2px solid var(--color-primary); background: transparent;"></div>
    </div>
    <!-- Trip details -->
    <div style="flex: 1; min-width: 0;">
      <div style="
        font-size: var(--font-caption);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-xs);
      ">Last Trip</div>
      <div style="display: flex; align-items: baseline; gap: var(--spacing-sm);">
        <div style="
          font-size: var(--font-h3);
          font-weight: var(--font-weight-bold);
          color: var(--color-primary);
        ">23.4 km</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">42 min</div>
      </div>
    </div>
    <!-- Trip stats -->
    <div style="
      display: flex; gap: var(--spacing-md);
      flex-shrink: 0;
    ">
      <div style="text-align: center;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-text-primary);">33</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">km/h avg</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: var(--font-body); font-weight: var(--font-weight-bold); color: var(--color-text-primary);">4.2</div>
        <div style="font-size: var(--font-caption); color: var(--color-text-secondary);">kWh</div>
      </div>
    </div>
  </div>
</div>
```

---

## Quick Reference: Widget Type Summary

| # | Widget | Type Value | Sizes | Primary Data |
|---|--------|-----------|-------|--------------|
| 1 | Navigation Card | `navigation` | 2x1, 2x2 | Destinations + traffic |
| 2 | Weather Card | `weather` | 1x1, 2x1 | Location + weather API |
| 3 | Music Control | `music` | 2x1, 4x1 | Now playing + playlist |
| 4 | Quick Toggles | `toggle` | 1x1 | Vehicle controls |
| 5 | Clock Display | `clock` | 1x1, 2x1 | System time |
| 6 | Notification Card | `notification` | 2x1 | Messages/reminders |
| 7 | Vehicle Status | `vehicle-status` | 2x2 | Vehicle sensors |
| 8 | Energy Stats | `energy` | 2x1, 2x2 | Trip energy data |
| 9 | Calendar Card | `calendar` | 2x1 | Schedule/events |
| 10 | Quick Dial | `dial` | 2x1, 4x1 | Frequent contacts |
| 11 | Smart Suggestions | `suggestions` | 2x1, 4x1 | Context engine |
| 12 | Trip Record | `trip` | 2x1 | Trip history |

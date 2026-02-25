# Design-Richtlinien für Web Dashboard

## Übersicht

Modern Tech, minimalistisch, clean Design für das Activi/Activi Web Dashboard.

## Design-Spezifikationen

| Aspekt | Vorgabe | Aktuelle Implementierung |
|--------|---------|--------------------------|
| **Stil** | Modern Tech, minimalistisch, clean | ✅ Glassmorphism-Themes (dark, light, openknot, fieldmanual, activiash) |
| **Fonts** | Monospace für Code/Daten, Sans-Serif für UI | ✅ Inter (Sans-Serif) für UI, JetBrains Mono für Code |
| **Ecken** | Leicht gerundet (4-8px) | ✅ `--radius-xs: 4px`, `--radius-sm: 8px`, `--radius-md: 12px` |
| **Schatten** | Dezent, nur für Karten/Modals | ✅ `--glass-shadow-sm/md/lg` für Karten/Modals |
| **Dichte** | Kompakt — viel Info auf wenig Platz | ✅ Kompakte Spacing-Werte (`--shell-pad: 12px`, `--shell-gap: 12px`) |
| **Dark Mode** | Primär (Devs bevorzugen Dark) | ✅ Dark als Default (`data-theme="dark"`) |
| **Light Mode** | Sekundär aber vollständig | ✅ Light Mode vollständig unterstützt |
| **Animationen** | Minimal — Status-Transitions, Loading-Spinner | ✅ `--duration-fast: 120ms`, `--duration-normal: 200ms` |
| **Icons** | Outline-Stil (Lucide, Phosphor oder ähnlich) | ✅ Lucide-Style SVG Icons (Outline-Stil) |

## Typografie

### UI-Text (Sans-Serif)
```css
--font-body: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--font-display: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
```

### Code/Daten (Monospace)
```css
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
```

**Verwendung:**
- UI-Elemente, Labels, Navigation: `var(--font-body)`
- Code-Blöcke, Terminal-Output, JSON: `var(--font-mono)`
- Headlines: `var(--font-display)`

## Border-Radius

```css
--radius-xs: 4px;   /* Kleine Buttons, Badges */
--radius-sm: 8px;   /* Standard-Buttons, Inputs */
--radius-md: 12px;  /* Karten, Modals */
--radius-lg: 16px;  /* Große Karten */
--radius-xl: 20px;  /* Sehr große Container */
--radius-full: 9999px; /* Pills, Avatare */
```

**Richtlinien:**
- Buttons: `--radius-sm` (8px)
- Karten: `--radius-md` (12px)
- Input-Felder: `--radius-sm` (8px)
- Modals: `--radius-md` (12px)
- Avatare: `--radius-full` (9999px)

## Schatten

```css
--glass-shadow-sm: 0 2px 12px rgba(26, 22, 20, 0.06), 0 1px 3px rgba(26, 22, 20, 0.04);
--glass-shadow-md: 0 8px 32px rgba(26, 22, 20, 0.08), 0 2px 8px rgba(26, 22, 20, 0.04);
--glass-shadow-lg: 0 20px 56px rgba(26, 22, 20, 0.12), 0 4px 16px rgba(26, 22, 20, 0.06);
```

**Verwendung:**
- Karten: `--glass-shadow-sm` oder `--glass-shadow-md`
- Modals/Dropdowns: `--glass-shadow-md` oder `--glass-shadow-lg`
- Hover-States: Leicht erhöhter Schatten
- **NICHT** für normale UI-Elemente (Buttons, Inputs ohne Elevation)

## Spacing & Dichte

```css
--shell-pad: 12px;      /* Standard-Padding */
--shell-gap: 12px;      /* Standard-Gap */
```

**Richtlinien:**
- Kompakte Spacing-Werte bevorzugen
- Viel Information auf wenig Platz
- Konsistente 12px-Grid verwenden
- Größere Abstände nur für visuelle Trennung (Sections)

## Dark Mode (Primär)

**Default Theme:** `dark`

```css
:root,
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0a0a0a;
  --text: #e5e5e5;
  /* ... */
}
```

**Richtlinien:**
- Dark Mode als Standard
- Hoher Kontrast für Lesbarkeit
- Dezente Akzente (nicht zu grell)

## Light Mode (Sekundär)

```css
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #faf7f2;
  --text: #1a1614;
  /* ... */
}
```

**Richtlinien:**
- Vollständig unterstützt
- Gleiche Funktionalität wie Dark Mode
- Angepasste Kontraste für Light Mode

## Animationen

```css
--duration-fast: 120ms;
--duration-normal: 200ms;
--duration-slow: 350ms;
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
```

**Verwendung:**
- Status-Transitions: `--duration-fast` (120ms)
- Hover-Effekte: `--duration-normal` (200ms)
- Loading-Spinner: Kontinuierlich, keine Dauer
- **Minimal** — nur wo nötig
- `prefers-reduced-motion` respektieren

**Erlaubte Animationen:**
- ✅ Status-Transitions (Hover, Active, Focus)
- ✅ Loading-Spinner
- ✅ Fade-In/Out für Modals
- ✅ Slide-Transitions für Sidebar/Panel

**Nicht erlaubt:**
- ❌ Übermäßige Animationen
- ❌ Bouncy/Spring-Effekte (außer spezifisch gewünscht)
- ❌ Auto-Animationen ohne User-Interaktion

## Icons

**Stil:** Outline (Lucide-Style)

**Richtlinien:**
- Konsistente Icon-Größen:
  - `--icon-size-xs: 0.9rem` (14.4px)
  - `--icon-size-sm: 1.05rem` (16.8px)
  - `--icon-size-md: 1.25rem` (20px)
  - `--icon-size-xl: 2.4rem` (38.4px)
- Outline-Stil (keine Filled-Icons)
- `currentColor` für Stroke (passt sich an Theme an)
- Konsistente Stroke-Width (meist 2px)

## Farben & Akzente

### Dark Mode
- **Background:** `#0a0a0a` (sehr dunkel)
- **Text:** `#e5e5e5` (hell)
- **Akzent:** `#c73526` (Rot/Orange)
- **Success:** `#0d9b7a` (Grün)
- **Danger:** `#c73526` (Rot)

### Light Mode
- **Background:** `#faf7f2` (warmes Weiß)
- **Text:** `#1a1614` (dunkel)
- **Akzent:** `#c73526` (Rot/Orange)
- **Success:** `#0d9b7a` (Grün)
- **Danger:** `#c73526` (Rot)

## Komponenten-Spezifikationen

### Buttons
- Border-Radius: `--radius-sm` (8px)
- Padding: `8px 16px` (kompakt)
- Font: `var(--font-body)` (Inter)
- Hover: Leichte Hintergrund-Änderung
- Active: Leicht gedrückt (Transform oder Shadow)

### Karten
- Border-Radius: `--radius-md` (12px)
- Shadow: `--glass-shadow-sm` oder `--glass-shadow-md`
- Padding: `16px` oder `20px`
- Background: `var(--card)` oder `var(--vscode-panel)`

### Input-Felder
- Border-Radius: `--radius-sm` (8px)
- Border: `1px solid var(--border)`
- Padding: `8px 12px`
- Font: `var(--font-body)` für Text, `var(--font-mono)` für Code/JSON

### Modals
- Border-Radius: `--radius-md` (12px)
- Shadow: `--glass-shadow-lg`
- Backdrop: Dunkler Overlay mit Blur
- Animation: Fade-In (200ms)

## Checkliste für neue Komponenten

- [ ] Border-Radius zwischen 4-8px (Standard: 8px)
- [ ] Schatten nur für Karten/Modals (nicht für normale Buttons)
- [ ] Kompakte Spacing-Werte (12px-Grid)
- [ ] Monospace für Code/Daten, Sans-Serif für UI
- [ ] Outline-Icons (Lucide-Style)
- [ ] Minimal Animationen (nur Status-Transitions)
- [ ] Dark Mode als Default
- [ ] Light Mode vollständig unterstützt
- [ ] `prefers-reduced-motion` respektieren

## Beispiele

### Gute Implementierung ✅
```css
.card {
  border-radius: var(--radius-md); /* 12px */
  box-shadow: var(--glass-shadow-sm);
  padding: 16px;
  background: var(--card);
}

.button {
  border-radius: var(--radius-sm); /* 8px */
  padding: 8px 16px;
  transition: background var(--duration-fast) var(--ease-out);
}
```

### Schlechte Implementierung ❌
```css
.card {
  border-radius: 20px; /* Zu groß */
  box-shadow: 0 10px 40px rgba(0,0,0,0.5); /* Zu stark */
  padding: 24px; /* Zu viel Padding */
}

.button {
  border-radius: 0; /* Keine Rundung */
  animation: bounce 1s infinite; /* Zu viel Animation */
}
```

# HTML Template Reference

> Complete HTML page skeleton for LLM-generated HMI UI pages.
> The LLM must use this template as the base structure when generating every HMI dashboard page.
> All visual values use CSS custom properties from the active design scheme -- never hardcode colors, spacing, radii, or typography values.

---

## Full Page Template

```html
<!DOCTYPE html>
<html lang="en" data-theme="day">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>HMI Dashboard</title>
  <style>
    /* ================================================================
       CSS Custom Properties -- Design Tokens
       Populated from the active design scheme JSON.
       See: default-design-scheme.json and design-scheme-schema.json
       ================================================================ */
    :root {
      /* --- Colors --- */
      --color-primary: #1A73E8;
      --color-secondary: #5F6368;
      --color-surface: #FFFFFF;
      --color-surface-dark: #1E1E1E;
      --color-accent: #FF6D00;
      --color-text-primary: #202124;
      --color-text-secondary: #5F6368;
      --color-text-disabled: #9AA0A6;
      --color-status-success: #34A853;
      --color-status-warning: #FBBC04;
      --color-status-error: #EA4335;

      /* --- Theme-aware aliases (light defaults) --- */
      --theme-background: #FFFFFF;
      --theme-text: #202124;

      /* --- Typography --- */
      --font-family: "HarmonyOS Sans", system-ui, sans-serif;
      --font-h1: 28px;
      --font-h2: 22px;
      --font-h3: 18px;
      --font-body: 14px;
      --font-caption: 12px;
      --font-weight-regular: 400;
      --font-weight-medium: 500;
      --font-weight-bold: 700;

      /* --- Spacing --- */
      --spacing-xs: 4px;
      --spacing-sm: 8px;
      --spacing-md: 16px;
      --spacing-lg: 24px;
      --spacing-xl: 32px;

      /* --- Border Radius --- */
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-pill: 999px;

      /* --- Elevation --- */
      --elevation-card: 0 2px 8px rgba(0,0,0,0.1);
      --elevation-modal: 0 8px 32px rgba(0,0,0,0.2);

      /* --- Animation --- */
      --animation-duration: 300ms;
      --animation-easing: cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* ================================================================
       Dark / Night Theme Overrides
       Applied when <html data-theme="night">
       ================================================================ */
    [data-theme="night"] {
      --color-surface: #1E1E1E;
      --color-surface-dark: #121212;
      --color-text-primary: #E8EAED;
      --color-text-secondary: #9AA0A6;
      --color-text-disabled: #5F6368;
      --theme-background: #1E1E1E;
      --theme-text: #E8EAED;
      --elevation-card: 0 2px 8px rgba(0,0,0,0.3);
      --elevation-modal: 0 8px 32px rgba(0,0,0,0.5);
    }

    /* ================================================================
       Base Reset & Body
       ================================================================ */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-family);
      background: var(--theme-background);
      color: var(--color-text-primary);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ================================================================
       Widget Base Styles
       See component-catalog.md for per-widget details.
       Class convention: .hmi-widget.hmi-widget--{type}.hmi-widget--{WxH}
       ================================================================ */
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

    [data-theme="night"] .hmi-widget {
      background: var(--color-surface-dark);
      color: var(--theme-text);
    }

    /* --- Widget Grid Sizes ---
       1x1 = 1 column, 1 row
       2x1 = 2 columns, 1 row
       2x2 = 2 columns, 2 rows
       4x1 = 4 columns (full width), 1 row */
    .hmi-widget--1x1 { grid-column: span 1; grid-row: span 1; }
    .hmi-widget--2x1 { grid-column: span 2; grid-row: span 1; }
    .hmi-widget--2x2 { grid-column: span 2; grid-row: span 2; }
    .hmi-widget--4x1 { grid-column: span 4; grid-row: span 1; }

    /* ================================================================
       Header
       ================================================================ */
    .hmi-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md) var(--spacing-lg);
      background: var(--theme-background);
      flex-shrink: 0;
    }

    .hmi-header__time {
      font-size: var(--font-h1);
      font-weight: var(--font-weight-bold);
      color: var(--color-text-primary);
    }

    .hmi-header__date {
      font-size: var(--font-body);
      font-weight: var(--font-weight-regular);
      color: var(--color-text-secondary);
      margin-left: var(--spacing-sm);
    }

    .hmi-header__status {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .hmi-header__status-indicator {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    }

    .hmi-header__scheme-btn {
      width: 40px;
      height: 40px;
      border: none;
      border-radius: var(--radius-pill);
      background: var(--color-surface);
      box-shadow: var(--elevation-card);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--animation-duration) var(--animation-easing);
      position: relative;
    }

    .hmi-header__scheme-btn:hover {
      box-shadow: var(--elevation-modal);
      filter: brightness(1.05);
    }

    .hmi-header__scheme-btn:active {
      transform: scale(0.95);
    }

    .hmi-header__scheme-btn[data-tooltip]:hover::after {
      content: attr(data-tooltip);
      position: absolute;
      bottom: -32px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--color-text-primary);
      color: var(--color-surface);
      font-size: var(--font-caption);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      white-space: nowrap;
      pointer-events: none;
      z-index: 100;
    }

    [data-theme="night"] .hmi-header__scheme-btn {
      background: var(--color-surface-dark);
    }

    /* ================================================================
       Widget Grid Container
       4-column grid, max 3 rows.
       Gap sourced from design tokens.
       ================================================================ */
    .hmi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-md);
      padding: 0 var(--spacing-lg);
      flex: 1;
      align-content: start;
      overflow-y: auto;
      /* Max 3 rows: rows are auto-sized, constrained by content */
      grid-auto-rows: minmax(0, 1fr);
    }

    /* ================================================================
       Scene Mode Bar
       Horizontal scrollable row of pill-shaped mode buttons.
       ================================================================ */
    .hmi-scene-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-md) var(--spacing-lg);
      overflow-x: auto;
      flex-shrink: 0;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none; /* Firefox */
    }

    .hmi-scene-bar::-webkit-scrollbar {
      display: none; /* Chrome/Safari */
    }

    .hmi-scene-btn {
      flex-shrink: 0;
      padding: var(--spacing-sm) var(--spacing-lg);
      border: 1px solid var(--color-secondary);
      border-radius: var(--radius-pill);
      background: transparent;
      color: var(--color-text-secondary);
      font-family: var(--font-family);
      font-size: var(--font-body);
      font-weight: var(--font-weight-medium);
      cursor: pointer;
      transition: all var(--animation-duration) var(--animation-easing);
      white-space: nowrap;
    }

    .hmi-scene-btn:hover {
      background: var(--color-secondary);
      color: var(--color-surface);
    }

    .hmi-scene-btn--active {
      background: var(--color-primary);
      color: var(--color-surface);
      border-color: var(--color-primary);
      font-weight: var(--font-weight-bold);
    }

    .hmi-scene-btn--active:hover {
      background: var(--color-primary);
      filter: brightness(1.1);
    }

    [data-theme="night"] .hmi-scene-btn {
      border-color: var(--color-text-secondary);
      color: var(--color-text-secondary);
    }

    [data-theme="night"] .hmi-scene-btn:hover {
      background: var(--color-text-secondary);
      color: var(--color-surface-dark);
    }

    /* ================================================================
       Chatbot Entry
       Floating action button (bottom-right) that expands into a
       chat panel with message history, input field, and send button.
       ================================================================ */
    .hmi-chatbot-fab {
      position: fixed;
      bottom: var(--spacing-lg);
      right: var(--spacing-lg);
      width: 56px;
      height: 56px;
      border: none;
      border-radius: var(--radius-pill);
      background: var(--color-primary);
      color: var(--color-surface);
      box-shadow: var(--elevation-modal);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--animation-duration) var(--animation-easing);
      z-index: 1000;
    }

    .hmi-chatbot-fab:hover {
      transform: scale(1.08);
      filter: brightness(1.1);
    }

    .hmi-chatbot-fab:active {
      transform: scale(0.95);
    }

    /* Hidden when chat panel is open */
    .hmi-chatbot-fab--hidden {
      transform: scale(0);
      opacity: 0;
      pointer-events: none;
    }

    .hmi-chat-panel {
      position: fixed;
      bottom: var(--spacing-lg);
      right: var(--spacing-lg);
      width: 360px;
      height: 480px;
      background: var(--color-surface);
      border-radius: var(--radius-lg);
      box-shadow: var(--elevation-modal);
      display: flex;
      flex-direction: column;
      z-index: 1001;
      overflow: hidden;
      /* Collapsed state: scale from bottom-right */
      transform: scale(0);
      transform-origin: bottom right;
      opacity: 0;
      pointer-events: none;
      transition: transform var(--animation-duration) var(--animation-easing),
                  opacity var(--animation-duration) var(--animation-easing);
    }

    .hmi-chat-panel--open {
      transform: scale(1);
      opacity: 1;
      pointer-events: auto;
    }

    [data-theme="night"] .hmi-chat-panel {
      background: var(--color-surface-dark);
    }

    .hmi-chat-panel__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--color-secondary);
      flex-shrink: 0;
    }

    .hmi-chat-panel__title {
      font-size: var(--font-h3);
      font-weight: var(--font-weight-medium);
      color: var(--color-text-primary);
    }

    .hmi-chat-panel__close {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: var(--radius-pill);
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background var(--animation-duration) var(--animation-easing);
    }

    .hmi-chat-panel__close:hover {
      background: var(--color-secondary);
      color: var(--color-surface);
    }

    .hmi-chat-panel__messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .hmi-chat-bubble {
      max-width: 80%;
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-md);
      font-size: var(--font-body);
      line-height: 1.5;
      word-wrap: break-word;
    }

    .hmi-chat-bubble--user {
      align-self: flex-end;
      background: var(--color-primary);
      color: var(--color-surface);
      border-bottom-right-radius: var(--spacing-xs);
    }

    .hmi-chat-bubble--assistant {
      align-self: flex-start;
      background: var(--color-surface);
      color: var(--color-text-primary);
      border: 1px solid var(--color-secondary);
      border-bottom-left-radius: var(--spacing-xs);
    }

    [data-theme="night"] .hmi-chat-bubble--assistant {
      background: var(--color-surface-dark);
      color: var(--theme-text);
      border-color: var(--color-text-secondary);
    }

    .hmi-chat-panel__input-area {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border-top: 1px solid var(--color-secondary);
      flex-shrink: 0;
    }

    .hmi-chat-panel__input {
      flex: 1;
      padding: var(--spacing-sm) var(--spacing-md);
      border: 1px solid var(--color-secondary);
      border-radius: var(--radius-pill);
      background: var(--theme-background);
      color: var(--color-text-primary);
      font-family: var(--font-family);
      font-size: var(--font-body);
      outline: none;
      transition: border-color var(--animation-duration) var(--animation-easing);
    }

    .hmi-chat-panel__input:focus {
      border-color: var(--color-primary);
    }

    .hmi-chat-panel__input::placeholder {
      color: var(--color-text-disabled);
    }

    .hmi-chat-panel__send {
      width: 40px;
      height: 40px;
      border: none;
      border-radius: var(--radius-pill);
      background: var(--color-primary);
      color: var(--color-surface);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all var(--animation-duration) var(--animation-easing);
    }

    .hmi-chat-panel__send:hover {
      filter: brightness(1.1);
    }

    .hmi-chat-panel__send:active {
      transform: scale(0.9);
    }

    /* ================================================================
       Design Scheme Upload Modal
       Shown when the header upload icon is clicked.
       Supports drag-and-drop for .json, .pdf, .docx, .xlsx, .fig
       ================================================================ */
    .hmi-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 2000;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .hmi-modal-backdrop--visible {
      display: flex;
    }

    .hmi-modal {
      width: 480px;
      max-width: 90vw;
      max-height: 80vh;
      background: var(--color-surface);
      border-radius: var(--radius-lg);
      box-shadow: var(--elevation-modal);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    [data-theme="night"] .hmi-modal {
      background: var(--color-surface-dark);
    }

    .hmi-modal__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-lg);
      border-bottom: 1px solid var(--color-secondary);
    }

    .hmi-modal__title {
      font-size: var(--font-h2);
      font-weight: var(--font-weight-bold);
      color: var(--color-text-primary);
    }

    .hmi-modal__close {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: var(--radius-pill);
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .hmi-modal__close:hover {
      background: var(--color-secondary);
      color: var(--color-surface);
    }

    .hmi-modal__body {
      padding: var(--spacing-lg);
      flex: 1;
      overflow-y: auto;
    }

    .hmi-upload-zone {
      border: 2px dashed var(--color-secondary);
      border-radius: var(--radius-md);
      padding: var(--spacing-xl);
      text-align: center;
      cursor: pointer;
      transition: all var(--animation-duration) var(--animation-easing);
    }

    .hmi-upload-zone:hover,
    .hmi-upload-zone--dragover {
      border-color: var(--color-primary);
      background: rgba(26, 115, 232, 0.05);
    }

    [data-theme="night"] .hmi-upload-zone:hover,
    [data-theme="night"] .hmi-upload-zone--dragover {
      background: rgba(26, 115, 232, 0.1);
    }

    .hmi-upload-zone__icon {
      margin-bottom: var(--spacing-md);
      color: var(--color-text-secondary);
    }

    .hmi-upload-zone__text {
      font-size: var(--font-body);
      color: var(--color-text-secondary);
      margin-bottom: var(--spacing-sm);
    }

    .hmi-upload-zone__formats {
      font-size: var(--font-caption);
      color: var(--color-text-disabled);
    }

    .hmi-upload-preview {
      margin-top: var(--spacing-lg);
      padding: var(--spacing-md);
      background: var(--theme-background);
      border: 1px solid var(--color-secondary);
      border-radius: var(--radius-md);
      font-family: monospace;
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
      max-height: 200px;
      overflow-y: auto;
      display: none; /* Shown after file is parsed */
    }

    .hmi-upload-preview--visible {
      display: block;
    }

    .hmi-modal__footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      border-top: 1px solid var(--color-secondary);
    }

    .hmi-btn {
      padding: var(--spacing-sm) var(--spacing-lg);
      border: none;
      border-radius: var(--radius-pill);
      font-family: var(--font-family);
      font-size: var(--font-body);
      font-weight: var(--font-weight-medium);
      cursor: pointer;
      transition: all var(--animation-duration) var(--animation-easing);
    }

    .hmi-btn--secondary {
      background: transparent;
      color: var(--color-text-secondary);
      border: 1px solid var(--color-secondary);
    }

    .hmi-btn--secondary:hover {
      background: var(--color-secondary);
      color: var(--color-surface);
    }

    .hmi-btn--primary {
      background: var(--color-primary);
      color: var(--color-surface);
    }

    .hmi-btn--primary:hover {
      filter: brightness(1.1);
    }

    .hmi-btn--primary:active {
      transform: scale(0.97);
    }

    /* ================================================================
       Edit Mode Overlay
       Activated by toggleEditMode(). Scales down the widget grid,
       shows alignment guidelines, and adds drag handles.
       ================================================================ */
    .hmi-grid--edit-mode {
      transform: scale(0.85);
      transform-origin: top center;
      transition: transform var(--animation-duration) var(--animation-easing);
    }

    .hmi-edit-grid-overlay {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 500;
      display: none;
    }

    .hmi-edit-grid-overlay--visible {
      display: block;
    }

    /* Grid guidelines rendered as repeating column lines */
    .hmi-edit-grid-overlay__lines {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-md);
      padding: 0 var(--spacing-lg);
      opacity: 0.15;
    }

    .hmi-edit-grid-overlay__col {
      border-left: 1px dashed var(--color-primary);
      border-right: 1px dashed var(--color-primary);
    }

    .hmi-edit-drag-handle {
      position: absolute;
      top: var(--spacing-xs);
      right: var(--spacing-xs);
      width: 24px;
      height: 24px;
      border-radius: var(--radius-sm);
      background: var(--color-primary);
      color: var(--color-surface);
      display: none; /* Shown in edit mode */
      align-items: center;
      justify-content: center;
      cursor: grab;
      z-index: 10;
      font-size: var(--font-caption);
    }

    .hmi-grid--edit-mode .hmi-edit-drag-handle {
      display: flex;
    }

    .hmi-edit-toolbar {
      position: fixed;
      bottom: var(--spacing-lg);
      left: 50%;
      transform: translateX(-50%);
      display: none;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-lg);
      background: var(--color-surface);
      border-radius: var(--radius-pill);
      box-shadow: var(--elevation-modal);
      z-index: 600;
    }

    .hmi-edit-toolbar--visible {
      display: flex;
    }

    [data-theme="night"] .hmi-edit-toolbar {
      background: var(--color-surface-dark);
    }

    .hmi-edit-toolbar__btn {
      padding: var(--spacing-sm) var(--spacing-md);
      border: none;
      border-radius: var(--radius-pill);
      font-family: var(--font-family);
      font-size: var(--font-caption);
      font-weight: var(--font-weight-medium);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      transition: all var(--animation-duration) var(--animation-easing);
    }

    .hmi-edit-toolbar__btn--add {
      background: var(--color-primary);
      color: var(--color-surface);
    }

    .hmi-edit-toolbar__btn--remove {
      background: var(--color-status-error);
      color: var(--color-surface);
    }

    .hmi-edit-toolbar__btn--exit {
      background: var(--color-secondary);
      color: var(--color-surface);
    }

    .hmi-edit-toolbar__btn:hover {
      filter: brightness(1.1);
    }
  </style>
</head>
<body>

  <!-- ================================================================
       SECTION 1: Header
       Displays time, date, status indicators, and the design scheme
       upload button. The upload button opens the scheme upload modal.
       ================================================================ -->
  <header class="hmi-header">
    <div style="display: flex; align-items: baseline;">
      <span class="hmi-header__time" id="headerTime">10:30</span>
      <span class="hmi-header__date" id="headerDate">Mon, Mar 10</span>
    </div>

    <div class="hmi-header__status">
      <!-- GENERATE: status indicators here -->
      <!-- Examples: connectivity, battery, signal strength, temperature -->
      <div class="hmi-header__status-indicator">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
          <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
          <circle cx="12" cy="20" r="1"/>
        </svg>
        <span>Connected</span>
      </div>
      <div class="hmi-header__status-indicator">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="1" y="6" width="18" height="12" rx="2" ry="2"/>
          <line x1="23" y1="13" x2="23" y2="11"/>
        </svg>
        <span>85%</span>
      </div>

      <!-- Design Scheme Upload Button -->
      <button
        class="hmi-header__scheme-btn"
        data-tooltip="Upload Design Scheme"
        onclick="openSchemeUpload()"
        aria-label="Upload Design Scheme"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      </button>
    </div>
  </header>

  <!-- ================================================================
       SECTION 2: Widget Grid (UI Render Area)
       4-column CSS Grid layout, max 3 rows.
       The LLM fills this area with widgets from component-catalog.md.
       Each widget uses: .hmi-widget.hmi-widget--{type}.hmi-widget--{WxH}
       ================================================================ -->
  <main class="hmi-grid" id="widgetGrid">
    <!-- GENERATE: widgets here -->
    <!--
      Insert widgets from component-catalog.md based on the active
      widgetComposition. Each widget must use the correct CSS classes
      and data attributes:

        <div class="hmi-widget hmi-widget--{type} hmi-widget--{WxH}"
             data-widget-type="{type}"
             data-widget-size="{WxH}">
          ...widget content from component-catalog.md...
          <span class="hmi-edit-drag-handle" aria-label="Drag to reorder">&#x2630;</span>
        </div>

      Valid widget types: navigation, media, phone, climate,
      drive-mode, seat-adjustment, ambient-light, vehicle-status,
      trip-information, weather

      Valid sizes: 1x1, 2x1, 2x2, 4x1
      Grid: 4 columns, max 3 rows, max 12 widgets total.
    -->
    <!-- GENERATE: end widgets -->
  </main>

  <!-- ================================================================
       SECTION 3: Scene Mode Bar
       Horizontal scrollable bar with pill-shaped scene mode buttons.
       The active scene influences widget priority and theme hints.
       ================================================================ -->
  <nav class="hmi-scene-bar" id="sceneBar" aria-label="Scene modes">
    <button class="hmi-scene-btn hmi-scene-btn--active" data-scene="commute" onclick="selectScene('commute')">
      Commute
    </button>
    <button class="hmi-scene-btn" data-scene="relax" onclick="selectScene('relax')">
      Relax
    </button>
    <button class="hmi-scene-btn" data-scene="sport" onclick="selectScene('sport')">
      Sport
    </button>
    <button class="hmi-scene-btn" data-scene="rest" onclick="selectScene('rest')">
      Rest
    </button>
    <button class="hmi-scene-btn" data-scene="workout" onclick="selectScene('workout')">
      Workout
    </button>
    <button class="hmi-scene-btn" data-scene="night-driving" onclick="selectScene('night-driving')">
      Night Driving
    </button>
  </nav>

  <!-- ================================================================
       SECTION 4: Chatbot Entry
       Floating action button (bottom-right) that expands to a chat
       panel. The panel includes message history, a text input, and
       a send button. Collapse/expand is animated.
       ================================================================ -->

  <!-- Chatbot FAB -->
  <button class="hmi-chatbot-fab" id="chatbotFab" onclick="toggleChatbot()" aria-label="Open chatbot">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  </button>

  <!-- Chat Panel -->
  <div class="hmi-chat-panel" id="chatPanel">
    <div class="hmi-chat-panel__header">
      <span class="hmi-chat-panel__title">HMI Assistant</span>
      <button class="hmi-chat-panel__close" onclick="toggleChatbot()" aria-label="Close chatbot">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <div class="hmi-chat-panel__messages" id="chatMessages">
      <!-- GENERATE: chat message history here -->
      <!--
        Messages use .hmi-chat-bubble with modifiers:
          .hmi-chat-bubble--user      (user messages, aligned right)
          .hmi-chat-bubble--assistant  (bot messages, aligned left)
      -->
      <div class="hmi-chat-bubble hmi-chat-bubble--assistant">
        Hello! I can help you customize your dashboard. Try saying
        "make it sportier" or "switch to dark mode".
      </div>
      <!-- GENERATE: end chat messages -->
    </div>

    <div class="hmi-chat-panel__input-area">
      <input
        class="hmi-chat-panel__input"
        id="chatInput"
        type="text"
        placeholder="Type a message..."
        autocomplete="off"
        aria-label="Chat message input"
      />
      <button class="hmi-chat-panel__send" id="chatSend" onclick="sendChatMessage()" aria-label="Send message">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- ================================================================
       SECTION 5: Design Scheme Upload Modal
       Hidden by default. Shown when the header upload icon is clicked.
       Accepts drag-and-drop file uploads (.json, .pdf, .docx, .xlsx, .fig).
       Parsed result is previewed before confirmation.
       ================================================================ -->
  <div class="hmi-modal-backdrop" id="schemeModal">
    <div class="hmi-modal" role="dialog" aria-labelledby="schemeModalTitle">
      <div class="hmi-modal__header">
        <h2 class="hmi-modal__title" id="schemeModalTitle">Upload Design Scheme</h2>
        <button class="hmi-modal__close" onclick="closeSchemeUpload()" aria-label="Close modal">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="hmi-modal__body">
        <!-- Drag-and-drop zone -->
        <div
          class="hmi-upload-zone"
          id="uploadZone"
          ondragover="handleDragOver(event)"
          ondragleave="handleDragLeave(event)"
          ondrop="handleDrop(event)"
          onclick="document.getElementById('fileInput').click()"
        >
          <div class="hmi-upload-zone__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div class="hmi-upload-zone__text">
            Drag and drop a design scheme file, or click to browse
          </div>
          <div class="hmi-upload-zone__formats">
            Accepted formats: .json, .pdf, .docx, .xlsx, .fig
          </div>
        </div>

        <input
          type="file"
          id="fileInput"
          accept=".json,.pdf,.docx,.xlsx,.fig"
          style="display: none;"
          onchange="handleFileSelect(event)"
        />

        <!-- Preview area for parsed result -->
        <div class="hmi-upload-preview" id="uploadPreview">
          <!-- Parsed scheme JSON preview will be rendered here -->
        </div>
      </div>

      <div class="hmi-modal__footer">
        <button class="hmi-btn hmi-btn--secondary" onclick="closeSchemeUpload()">Cancel</button>
        <button class="hmi-btn hmi-btn--primary" id="schemeConfirmBtn" onclick="confirmSchemeUpload()" disabled>
          Apply Scheme
        </button>
      </div>
    </div>
  </div>

  <!-- ================================================================
       SECTION 6: Edit Mode Overlay
       Grid guidelines and controls shown when in edit mode.
       The widget area scales to 0.85 and drag handles appear on
       each widget. An edit toolbar provides add/remove/exit actions.
       ================================================================ -->
  <div class="hmi-edit-grid-overlay" id="editGridOverlay">
    <div class="hmi-edit-grid-overlay__lines">
      <div class="hmi-edit-grid-overlay__col"></div>
      <div class="hmi-edit-grid-overlay__col"></div>
      <div class="hmi-edit-grid-overlay__col"></div>
      <div class="hmi-edit-grid-overlay__col"></div>
    </div>
  </div>

  <div class="hmi-edit-toolbar" id="editToolbar">
    <button class="hmi-edit-toolbar__btn hmi-edit-toolbar__btn--add" onclick="addWidget()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Add Widget
    </button>
    <button class="hmi-edit-toolbar__btn hmi-edit-toolbar__btn--remove" onclick="removeWidget()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      Remove Widget
    </button>
    <button class="hmi-edit-toolbar__btn hmi-edit-toolbar__btn--exit" onclick="toggleEditMode()">
      Exit Edit Mode
    </button>
  </div>

  <!-- ================================================================
       SECTION 7: Scripts
       Core page functions. The chatbot WebSocket connection is
       handled by chatbot-widget.js loaded as an external asset.
       ================================================================ -->
  <script src="chatbot-widget.js"></script>
  <script>
    /* ==============================================================
       applyDesignScheme(scheme)
       Maps a design scheme JSON object to CSS custom properties.
       Called when a new scheme is uploaded and confirmed, or when
       the page loads with a saved scheme from localStorage.
       ============================================================== */
    function applyDesignScheme(scheme) {
      const root = document.documentElement;

      // Colors
      if (scheme.tokens && scheme.tokens.colors) {
        const c = scheme.tokens.colors;
        if (c.primary)    root.style.setProperty('--color-primary', c.primary);
        if (c.secondary)  root.style.setProperty('--color-secondary', c.secondary);
        if (c.surface)    root.style.setProperty('--color-surface', c.surface);
        if (c.surfaceDark) root.style.setProperty('--color-surface-dark', c.surfaceDark);
        if (c.accent)     root.style.setProperty('--color-accent', c.accent);
        if (c.text) {
          if (c.text.primary)  root.style.setProperty('--color-text-primary', c.text.primary);
          if (c.text.secondary) root.style.setProperty('--color-text-secondary', c.text.secondary);
          if (c.text.disabled) root.style.setProperty('--color-text-disabled', c.text.disabled);
        }
        if (c.status) {
          if (c.status.success) root.style.setProperty('--color-status-success', c.status.success);
          if (c.status.warning) root.style.setProperty('--color-status-warning', c.status.warning);
          if (c.status.error)   root.style.setProperty('--color-status-error', c.status.error);
        }
      }

      // Theme-aware aliases
      if (scheme.themes) {
        const currentTheme = root.getAttribute('data-theme');
        const themeData = currentTheme === 'night' ? scheme.themes.dark : scheme.themes.light;
        if (themeData) {
          if (themeData.background) root.style.setProperty('--theme-background', themeData.background);
          if (themeData.text) root.style.setProperty('--theme-text', themeData.text);
        }
      }

      // Typography
      if (scheme.tokens && scheme.tokens.typography) {
        const t = scheme.tokens.typography;
        if (t.fontFamily) root.style.setProperty('--font-family', t.fontFamily);
        if (t.scale) {
          if (t.scale.h1)      root.style.setProperty('--font-h1', t.scale.h1);
          if (t.scale.h2)      root.style.setProperty('--font-h2', t.scale.h2);
          if (t.scale.h3)      root.style.setProperty('--font-h3', t.scale.h3);
          if (t.scale.body)    root.style.setProperty('--font-body', t.scale.body);
          if (t.scale.caption) root.style.setProperty('--font-caption', t.scale.caption);
        }
        if (t.weight) {
          if (t.weight.regular) root.style.setProperty('--font-weight-regular', t.weight.regular);
          if (t.weight.medium)  root.style.setProperty('--font-weight-medium', t.weight.medium);
          if (t.weight.bold)    root.style.setProperty('--font-weight-bold', t.weight.bold);
        }
      }

      // Spacing
      if (scheme.tokens && scheme.tokens.spacing) {
        const s = scheme.tokens.spacing;
        if (s.xs) root.style.setProperty('--spacing-xs', s.xs);
        if (s.sm) root.style.setProperty('--spacing-sm', s.sm);
        if (s.md) root.style.setProperty('--spacing-md', s.md);
        if (s.lg) root.style.setProperty('--spacing-lg', s.lg);
        if (s.xl) root.style.setProperty('--spacing-xl', s.xl);
      }

      // Radius
      if (scheme.tokens && scheme.tokens.radius) {
        const r = scheme.tokens.radius;
        if (r.sm)   root.style.setProperty('--radius-sm', r.sm);
        if (r.md)   root.style.setProperty('--radius-md', r.md);
        if (r.lg)   root.style.setProperty('--radius-lg', r.lg);
        if (r.pill) root.style.setProperty('--radius-pill', r.pill);
      }

      // Elevation
      if (scheme.tokens && scheme.tokens.elevation) {
        const e = scheme.tokens.elevation;
        if (e.card)  root.style.setProperty('--elevation-card', e.card);
        if (e.modal) root.style.setProperty('--elevation-modal', e.modal);
      }

      // Animation
      if (scheme.constraints && scheme.constraints.animation) {
        const a = scheme.constraints.animation;
        if (a.maxDuration) root.style.setProperty('--animation-duration', a.maxDuration);
        if (a.easing)      root.style.setProperty('--animation-easing', a.easing);
      }

      // Persist the applied scheme
      savePreference('designScheme', scheme);
    }

    /* ==============================================================
       switchTheme(mode)
       Toggles the data-theme attribute on <html>.
       Accepted values: "day", "night", "auto"
       Auto mode checks the current hour (6-18 = day, else night).
       ============================================================== */
    function switchTheme(mode) {
      const root = document.documentElement;

      if (mode === 'auto') {
        const hour = new Date().getHours();
        mode = (hour >= 6 && hour < 18) ? 'day' : 'night';
      }

      root.setAttribute('data-theme', mode);

      // Re-apply theme-aware aliases from saved scheme
      const savedScheme = loadPreference('designScheme');
      if (savedScheme && savedScheme.themes) {
        const themeData = mode === 'night' ? savedScheme.themes.dark : savedScheme.themes.light;
        if (themeData) {
          if (themeData.background) root.style.setProperty('--theme-background', themeData.background);
          if (themeData.text) root.style.setProperty('--theme-text', themeData.text);
        }
      }

      savePreference('themeMode', mode);
    }

    /* ==============================================================
       toggleEditMode()
       Enters or exits edit mode. In edit mode:
       - The widget grid scales to 0.85
       - Grid guideline overlay becomes visible
       - Drag handles appear on each widget
       - The edit toolbar (add/remove/exit) is shown
       ============================================================== */
    let isEditMode = false;

    function toggleEditMode() {
      isEditMode = !isEditMode;
      const grid = document.getElementById('widgetGrid');
      const overlay = document.getElementById('editGridOverlay');
      const toolbar = document.getElementById('editToolbar');

      if (isEditMode) {
        grid.classList.add('hmi-grid--edit-mode');
        overlay.classList.add('hmi-edit-grid-overlay--visible');
        toolbar.classList.add('hmi-edit-toolbar--visible');
      } else {
        grid.classList.remove('hmi-grid--edit-mode');
        overlay.classList.remove('hmi-edit-grid-overlay--visible');
        toolbar.classList.remove('hmi-edit-toolbar--visible');
      }
    }

    /* ==============================================================
       toggleChatbot()
       Expands or collapses the chat panel. When the panel opens,
       the FAB hides; when it closes, the FAB reappears.
       ============================================================== */
    let isChatOpen = false;

    function toggleChatbot() {
      isChatOpen = !isChatOpen;
      const fab = document.getElementById('chatbotFab');
      const panel = document.getElementById('chatPanel');

      if (isChatOpen) {
        fab.classList.add('hmi-chatbot-fab--hidden');
        panel.classList.add('hmi-chat-panel--open');
        document.getElementById('chatInput').focus();
      } else {
        fab.classList.remove('hmi-chatbot-fab--hidden');
        panel.classList.remove('hmi-chat-panel--open');
      }
    }

    /* ==============================================================
       sendChatMessage()
       Reads the chat input, appends a user bubble, clears the
       input, and delegates to the chatbot-widget.js WebSocket
       handler for response processing.
       ============================================================== */
    function sendChatMessage() {
      const input = document.getElementById('chatInput');
      const text = input.value.trim();
      if (!text) return;

      // Append user message bubble
      const messages = document.getElementById('chatMessages');
      const bubble = document.createElement('div');
      bubble.className = 'hmi-chat-bubble hmi-chat-bubble--user';
      bubble.textContent = text;
      messages.appendChild(bubble);

      // Clear input
      input.value = '';

      // Scroll to bottom
      messages.scrollTop = messages.scrollHeight;

      // Connect to OpenClaw Gateway - provided by chatbot-widget.js
      if (typeof window.sendToChatbot === 'function') {
        window.sendToChatbot(text);
      }
    }

    // Allow Enter key to send messages
    document.getElementById('chatInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    /* ==============================================================
       openSchemeUpload() / closeSchemeUpload()
       Shows or hides the design scheme upload modal.
       ============================================================== */
    function openSchemeUpload() {
      const modal = document.getElementById('schemeModal');
      modal.classList.add('hmi-modal-backdrop--visible');
    }

    function closeSchemeUpload() {
      const modal = document.getElementById('schemeModal');
      modal.classList.remove('hmi-modal-backdrop--visible');
      // Reset upload state
      document.getElementById('uploadPreview').classList.remove('hmi-upload-preview--visible');
      document.getElementById('uploadPreview').textContent = '';
      document.getElementById('schemeConfirmBtn').disabled = true;
      document.getElementById('fileInput').value = '';
      window._pendingScheme = null;
    }

    /* ==============================================================
       File Upload Handlers
       Handle drag-and-drop and file selection for design scheme
       uploads. Accepted formats: .json, .pdf, .docx, .xlsx, .fig
       ============================================================== */
    function handleDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('uploadZone').classList.add('hmi-upload-zone--dragover');
    }

    function handleDragLeave(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('uploadZone').classList.remove('hmi-upload-zone--dragover');
    }

    function handleDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('uploadZone').classList.remove('hmi-upload-zone--dragover');

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        processUploadedFile(files[0]);
      }
    }

    function handleFileSelect(e) {
      const files = e.target.files;
      if (files.length > 0) {
        processUploadedFile(files[0]);
      }
    }

    function processUploadedFile(file) {
      const validExtensions = ['.json', '.pdf', '.docx', '.xlsx', '.fig'];
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!validExtensions.includes(ext)) {
        alert('Unsupported file format. Please upload: ' + validExtensions.join(', '));
        return;
      }

      if (ext === '.json') {
        // Parse JSON directly
        const reader = new FileReader();
        reader.onload = function(e) {
          try {
            const scheme = JSON.parse(e.target.result);
            showSchemePreview(scheme);
          } catch (err) {
            alert('Invalid JSON file: ' + err.message);
          }
        };
        reader.readAsText(file);
      } else {
        // Non-JSON formats: show filename and indicate server-side parsing needed
        const preview = document.getElementById('uploadPreview');
        preview.textContent = 'File: ' + file.name + '\nFormat: ' + ext +
          '\n\nThis file format requires server-side parsing.\n' +
          'The design scheme will be extracted after upload.';
        preview.classList.add('hmi-upload-preview--visible');
        // Store file reference for server upload
        window._pendingSchemeFile = file;
        document.getElementById('schemeConfirmBtn').disabled = false;
      }
    }

    function showSchemePreview(scheme) {
      const preview = document.getElementById('uploadPreview');
      preview.textContent = JSON.stringify(scheme, null, 2);
      preview.classList.add('hmi-upload-preview--visible');
      window._pendingScheme = scheme;
      document.getElementById('schemeConfirmBtn').disabled = false;
    }

    function confirmSchemeUpload() {
      if (window._pendingScheme) {
        applyDesignScheme(window._pendingScheme);
        closeSchemeUpload();
      } else if (window._pendingSchemeFile) {
        // Delegate to chatbot-widget.js for server-side parsing
        if (typeof window.uploadSchemeFile === 'function') {
          window.uploadSchemeFile(window._pendingSchemeFile);
        }
        closeSchemeUpload();
      }
    }

    /* ==============================================================
       selectScene(mode)
       Activates a scene mode button and deactivates all others.
       The active scene is persisted and can influence widget
       priority and theme hints.
       ============================================================== */
    function selectScene(mode) {
      const buttons = document.querySelectorAll('.hmi-scene-btn');
      buttons.forEach(function(btn) {
        btn.classList.remove('hmi-scene-btn--active');
        if (btn.getAttribute('data-scene') === mode) {
          btn.classList.add('hmi-scene-btn--active');
        }
      });
      savePreference('sceneMode', mode);
    }

    /* ==============================================================
       addWidget() / removeWidget()
       Stubs for edit-mode widget management.
       Full implementation is handled by chatbot-widget.js
       which manages widget composition through the LLM.
       ============================================================== */
    function addWidget() {
      // Stub: open widget picker or delegate to chatbot
      if (typeof window.openWidgetPicker === 'function') {
        window.openWidgetPicker();
      }
    }

    function removeWidget() {
      // Stub: enable widget removal selection or delegate to chatbot
      if (typeof window.enableWidgetRemoval === 'function') {
        window.enableWidgetRemoval();
      }
    }

    /* ==============================================================
       Preference Persistence (localStorage)
       Save and load user preferences so the dashboard restores
       its state across sessions.
       ============================================================== */
    function savePreference(key, value) {
      try {
        const prefs = JSON.parse(localStorage.getItem('hmi-preferences') || '{}');
        prefs[key] = value;
        localStorage.setItem('hmi-preferences', JSON.stringify(prefs));
      } catch (e) {
        // localStorage may be unavailable in some embedded contexts
      }
    }

    function loadPreference(key) {
      try {
        const prefs = JSON.parse(localStorage.getItem('hmi-preferences') || '{}');
        return prefs[key] || null;
      } catch (e) {
        return null;
      }
    }

    function loadAllPreferences() {
      try {
        return JSON.parse(localStorage.getItem('hmi-preferences') || '{}');
      } catch (e) {
        return {};
      }
    }

    function clearPreferences() {
      try {
        localStorage.removeItem('hmi-preferences');
      } catch (e) {
        // Ignore
      }
    }

    /* ==============================================================
       Page Initialization
       Restores saved preferences (theme, scene, design scheme)
       when the page loads.
       ============================================================== */
    (function init() {
      // Restore theme
      const savedTheme = loadPreference('themeMode');
      if (savedTheme) {
        switchTheme(savedTheme);
      }

      // Restore scene
      const savedScene = loadPreference('sceneMode');
      if (savedScene) {
        selectScene(savedScene);
      }

      // Restore design scheme
      const savedScheme = loadPreference('designScheme');
      if (savedScheme) {
        applyDesignScheme(savedScheme);
      }

      // Update header time every minute
      function updateTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        document.getElementById('headerTime').textContent = hours + ':' + minutes;

        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        document.getElementById('headerDate').textContent =
          days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();
      }

      updateTime();
      setInterval(updateTime, 60000);
    })();
  </script>
</body>
</html>
```

---

## Section Reference

| Section | Element ID | Purpose |
|---------|-----------|---------|
| Header | `headerTime`, `headerDate` | Clock and date display, updated every 60s |
| Header | scheme button | Opens design scheme upload modal |
| Widget Grid | `widgetGrid` | 4-column CSS Grid for widget placement |
| Scene Bar | `sceneBar` | Horizontal scrollable mode selector |
| Chatbot FAB | `chatbotFab` | Floating button to open chat panel |
| Chat Panel | `chatPanel` | Expandable chat interface with messages and input |
| Upload Modal | `schemeModal` | Design scheme file upload with drag-and-drop |
| Edit Overlay | `editGridOverlay` | Grid guidelines shown in edit mode |
| Edit Toolbar | `editToolbar` | Add/remove widget buttons, exit edit mode |

---

## CSS Class Quick Reference

| Class | Purpose |
|-------|---------|
| `.hmi-widget` | Base widget styling (background, radius, shadow, transitions) |
| `.hmi-widget--{type}` | Widget type identifier (e.g., `--navigation`, `--media`) |
| `.hmi-widget--{WxH}` | Widget grid size (e.g., `--1x1`, `--2x1`, `--2x2`, `--4x1`) |
| `.hmi-widget--disabled` | Disabled state (opacity 0.5, no pointer events) |
| `.hmi-scene-btn` | Scene mode pill button |
| `.hmi-scene-btn--active` | Active scene mode |
| `.hmi-chat-bubble--user` | User chat message (right-aligned, primary bg) |
| `.hmi-chat-bubble--assistant` | Bot chat message (left-aligned, surface bg) |
| `.hmi-btn--primary` | Primary action button |
| `.hmi-btn--secondary` | Secondary/cancel button |
| `.hmi-grid--edit-mode` | Applies scale(0.85) to widget grid |

---

## Script API Quick Reference

| Function | Description |
|----------|-------------|
| `applyDesignScheme(scheme)` | Maps design scheme JSON tokens to CSS custom properties |
| `switchTheme(mode)` | Toggles `data-theme` attribute (`"day"`, `"night"`, `"auto"`) |
| `toggleEditMode()` | Enters/exits edit mode with grid scaling and overlays |
| `toggleChatbot()` | Expands/collapses the chat panel |
| `openSchemeUpload()` | Opens the design scheme upload modal |
| `closeSchemeUpload()` | Closes the upload modal and resets state |
| `selectScene(mode)` | Activates a scene mode button |
| `sendChatMessage()` | Sends the chat input text to the chatbot |
| `savePreference(key, value)` | Persists a preference to localStorage |
| `loadPreference(key)` | Loads a preference from localStorage |
| `clearPreferences()` | Removes all saved preferences |

---

## Generation Rules for LLMs

1. **Always start from this template.** Do not invent a different page structure.
2. **Fill `<!-- GENERATE: ... -->` markers** with content appropriate for the active `widgetComposition` and `sceneMode`.
3. **Use only `var(--token-name)` for all visual values.** Never hardcode hex colors, pixel spacing, font sizes, or border radii.
4. **Respect the 4-column, 3-row grid.** Widget sizes must be one of: `1x1`, `2x1`, `2x2`, `4x1`. Total widgets must not exceed `constraints.maxWidgets` (default: 12).
5. **Follow the CSS class convention** from component-catalog.md: `.hmi-widget.hmi-widget--{type}.hmi-widget--{WxH}`.
6. **Include `data-widget-type` and `data-widget-size` attributes** on every widget root element.
7. **Include a `.hmi-edit-drag-handle`** inside every widget for edit mode support.
8. **Both themes must work.** Test that the generated page looks correct with both `data-theme="day"` and `data-theme="night"`.
9. **Load `chatbot-widget.js`** as an external script. Do not inline the WebSocket connection logic.
10. **Preserve all script functions.** Do not remove or rename any function listed in the Script API Quick Reference.

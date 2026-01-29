// Clawd IDE - Enhanced Application
// Phase 1: Core Editor + Phase 2: AI Features Foundation

// ============================================
// STATE
// ============================================
const state = {
  terminal: null,
  terminalFitAddon: null,
  terminalSearchAddon: null,
  ws: null,
  workspace: '',
  
  // File management
  currentFile: null,
  openFiles: new Map(), // path -> { path, name, model, modified, originalContent, preview }
  recentFiles: [],
  
  // Split Panes
  panes: [{
    id: 0,
    editor: null,
    files: new Map(), // path -> { path, name, model, modified, originalContent }
    activeFile: null
  }],
  activePane: 0,
  splitDirection: 'horizontal', // 'horizontal' or 'vertical'
  
  // Gateway/AI
  gatewayConnected: false,
  aiThinking: false,
  currentStreamingMessage: null,
  
  // Find/Replace
  findState: {
    visible: false,
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    matches: [],
    currentMatch: 0
  },
  
  // Inline Edit (Cmd+K)
  inlineEdit: {
    visible: false,
    originalCode: '',
    generatedCode: '',
    selection: null,
    paneId: 0
  },
  
  // Git
  git: {
    branch: 'main',
    ahead: 0,
    behind: 0
  },
  
  // Browser Panels (Phase 3)
  browsers: new Map(), // id -> { id, url, title, history, historyIndex, viewport, console, network }
  activeBrowser: null,
  browserNextId: 1,
  liveReload: {
    enabled: true,
    connected: false
  },
  
  // Agent Mode (Sprint 1)
  agent: {
    active: false,
    mode: 'safe', // 'safe' | 'standard' | 'autonomous'
    task: null,
    taskId: null,
    plan: [], // { id, description, status: 'pending'|'running'|'complete'|'failed'|'skipped', details: string }
    currentStep: -1,
    changes: [], // { file, type: 'create'|'modify'|'delete', originalContent, newContent, hunks, approved: bool }
    rollbackCommit: null,
    verification: {
      running: false,
      typescript: null,
      eslint: null,
      tests: null
    },
    paused: false,
    error: null
  }
};

// Convenience getter for active editor
Object.defineProperty(state, 'editor', {
  get() {
    const pane = state.panes[state.activePane];
    return pane ? pane.editor : null;
  }
});

// ============================================
// FILE ICONS (SVG)
// ============================================
const FILE_ICONS = {
  // Folders
  folder: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`,
  
  // JavaScript/TypeScript
  js: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h18v18H3V3zm4.73 15.04c.4.85 1.19 1.55 2.54 1.55 1.5 0 2.53-.8 2.53-2.55v-5.78h-1.7V17c0 .86-.35 1.08-.9 1.08-.58 0-.82-.4-1.09-.87l-1.38.83zm5.98-.18c.5.98 1.51 1.73 3.09 1.73 1.6 0 2.8-.83 2.8-2.36 0-1.41-.81-2.04-2.25-2.66l-.42-.18c-.73-.31-1.04-.52-1.04-1.02 0-.41.31-.73.81-.73.48 0 .8.21 1.09.73l1.31-.87c-.55-.96-1.33-1.33-2.4-1.33-1.51 0-2.48.96-2.48 2.23 0 1.38.81 2.03 2.03 2.55l.42.18c.78.34 1.24.55 1.24 1.13 0 .48-.45.83-1.15.83-.83 0-1.31-.43-1.67-1.03l-1.38.8z"/></svg>`,
  ts: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h18v18H3V3zm10.71 13.44v1.85c.31.16.68.28 1.1.36.43.09.86.13 1.3.13.43 0 .82-.04 1.18-.13.36-.09.67-.23.92-.42.26-.19.46-.44.6-.74.14-.31.21-.68.21-1.11 0-.32-.05-.6-.14-.84-.09-.24-.23-.45-.4-.64-.17-.18-.38-.35-.62-.49-.24-.14-.52-.28-.82-.4-.23-.1-.42-.19-.58-.27-.16-.08-.29-.17-.39-.25-.1-.09-.17-.18-.22-.28-.05-.1-.07-.21-.07-.34 0-.12.02-.23.07-.32.05-.1.12-.18.21-.25.09-.07.21-.12.34-.16.14-.04.29-.05.47-.05.12 0 .26.01.4.03.14.02.28.05.43.1.15.04.29.1.44.17.14.07.28.15.4.25v-1.73c-.26-.11-.55-.19-.88-.24-.33-.05-.69-.08-1.09-.08-.42 0-.81.05-1.16.14-.35.09-.66.24-.92.43-.26.19-.46.44-.6.74-.14.3-.22.66-.22 1.07 0 .53.14.97.43 1.32.29.35.73.65 1.33.91.23.1.44.2.62.29.18.09.34.19.46.28.13.1.23.2.29.31.07.11.1.24.1.38 0 .11-.02.22-.06.31-.04.1-.11.18-.2.25-.09.07-.2.13-.35.17-.14.04-.31.06-.51.06-.35 0-.69-.06-1.02-.19-.33-.13-.64-.32-.92-.58zm-4.02-5.28H6.64v7.43h1.92v-5.55h1.89v-1.88h-1.76z"/></svg>`,
  jsx: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 10.11c1.03 0 1.87.84 1.87 1.89 0 1-.84 1.85-1.87 1.85S10.13 13 10.13 12c0-1.05.84-1.89 1.87-1.89M7.37 20c.63.38 2.01-.2 3.6-1.7-.52-.59-1.03-1.23-1.51-1.9-.82-.08-1.63-.2-2.4-.36-.51 2.14-.32 3.61.31 3.96m.71-5.74l-.29-.51c-.11.29-.22.58-.29.86.27.06.57.11.88.16l-.3-.51m6.54-.76l.81-1.5-.81-1.5c-.3-.53-.62-1-.91-1.47C13.17 9 12.6 9 12 9s-1.17 0-1.71.03c-.29.47-.61.94-.91 1.47l-.81 1.5.81 1.5c.3.53.62 1 .91 1.47.54.03 1.11.03 1.71.03s1.17 0 1.71-.03c.29-.47.61-.94.91-1.47M12 6.78c-.19.22-.39.45-.59.72h1.18c-.2-.27-.4-.5-.59-.72m0 10.44c.19-.22.39-.45.59-.72h-1.18c.2.27.4.5.59.72M16.62 4c-.62-.38-2 .2-3.59 1.7.52.59 1.03 1.23 1.51 1.9.82.08 1.63.2 2.4.36.51-2.14.32-3.61-.32-3.96m-.7 5.74l.29.51c.11-.29.22-.58.29-.86-.27-.06-.57-.11-.88-.16l.3.51m1.45-7.05c1.47.84 1.63 3.05 1.01 5.63 2.54.75 4.37 1.99 4.37 3.68s-1.83 2.93-4.37 3.68c.62 2.58.46 4.79-1.01 5.63-1.46.84-3.45-.12-5.37-1.95-1.92 1.83-3.91 2.79-5.38 1.95-1.46-.84-1.62-3.05-1-5.63-2.54-.75-4.37-1.99-4.37-3.68s1.83-2.93 4.37-3.68c-.62-2.58-.46-4.79 1-5.63 1.47-.84 3.46.12 5.38 1.95 1.92-1.83 3.91-2.79 5.37-1.95M17.08 12c.34.75.64 1.5.89 2.26 2.1-.63 3.28-1.53 3.28-2.26s-1.18-1.63-3.28-2.26c-.25.76-.55 1.51-.89 2.26M6.92 12c-.34-.75-.64-1.5-.89-2.26-2.1.63-3.28 1.53-3.28 2.26s1.18 1.63 3.28 2.26c.25-.76.55-1.51.89-2.26m9 2.26l-.3.51c.31-.05.61-.1.88-.16-.07-.28-.18-.57-.29-.86l-.29.51m-2.89 4.04c1.59 1.5 2.97 2.08 3.59 1.7.64-.35.83-1.82.32-3.96-.77.16-1.58.28-2.4.36-.48.67-.99 1.31-1.51 1.9M8.08 9.74l.3-.51c-.31.05-.61.1-.88.16.07.28.18.57.29.86l.29-.51m2.89-4.04C9.38 4.2 8 3.62 7.37 4c-.63.35-.82 1.82-.31 3.96.77-.16 1.58-.28 2.4-.36.48-.67.99-1.31 1.51-1.9z"/></svg>`,
  tsx: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 10.11c1.03 0 1.87.84 1.87 1.89 0 1-.84 1.85-1.87 1.85S10.13 13 10.13 12c0-1.05.84-1.89 1.87-1.89M7.37 20c.63.38 2.01-.2 3.6-1.7-.52-.59-1.03-1.23-1.51-1.9-.82-.08-1.63-.2-2.4-.36-.51 2.14-.32 3.61.31 3.96m.71-5.74l-.29-.51c-.11.29-.22.58-.29.86.27.06.57.11.88.16l-.3-.51m6.54-.76l.81-1.5-.81-1.5c-.3-.53-.62-1-.91-1.47C13.17 9 12.6 9 12 9s-1.17 0-1.71.03c-.29.47-.61.94-.91 1.47l-.81 1.5.81 1.5c.3.53.62 1 .91 1.47.54.03 1.11.03 1.71.03s1.17 0 1.71-.03c.29-.47.61-.94.91-1.47M12 6.78c-.19.22-.39.45-.59.72h1.18c-.2-.27-.4-.5-.59-.72m0 10.44c.19-.22.39-.45.59-.72h-1.18c.2.27.4.5.59.72M16.62 4c-.62-.38-2 .2-3.59 1.7.52.59 1.03 1.23 1.51 1.9.82.08 1.63.2 2.4.36.51-2.14.32-3.61-.32-3.96m-.7 5.74l.29.51c.11-.29.22-.58.29-.86-.27-.06-.57-.11-.88-.16l.3.51m1.45-7.05c1.47.84 1.63 3.05 1.01 5.63 2.54.75 4.37 1.99 4.37 3.68s-1.83 2.93-4.37 3.68c.62 2.58.46 4.79-1.01 5.63-1.46.84-3.45-.12-5.37-1.95-1.92 1.83-3.91 2.79-5.38 1.95-1.46-.84-1.62-3.05-1-5.63-2.54-.75-4.37-1.99-4.37-3.68s1.83-2.93 4.37-3.68c-.62-2.58-.46-4.79 1-5.63 1.47-.84 3.46.12 5.38 1.95 1.92-1.83 3.91-2.79 5.37-1.95M17.08 12c.34.75.64 1.5.89 2.26 2.1-.63 3.28-1.53 3.28-2.26s-1.18-1.63-3.28-2.26c-.25.76-.55 1.51-.89 2.26M6.92 12c-.34-.75-.64-1.5-.89-2.26-2.1.63-3.28 1.53-3.28 2.26s1.18 1.63 3.28 2.26c.25-.76.55-1.51.89-2.26m9 2.26l-.3.51c.31-.05.61-.1.88-.16-.07-.28-.18-.57-.29-.86l-.29.51m-2.89 4.04c1.59 1.5 2.97 2.08 3.59 1.7.64-.35.83-1.82.32-3.96-.77.16-1.58.28-2.4.36-.48.67-.99 1.31-1.51 1.9M8.08 9.74l.3-.51c-.31.05-.61.1-.88.16.07.28.18.57.29.86l.29-.51m2.89-4.04C9.38 4.2 8 3.62 7.37 4c-.63.35-.82 1.82-.31 3.96.77-.16 1.58-.28 2.4-.36.48-.67.99-1.31 1.51-1.9z"/></svg>`,
  
  // Data formats
  json: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h2v2H5v5a2 2 0 01-2 2 2 2 0 012 2v5h2v2H5c-1.07-.27-2-.9-2-2v-4a2 2 0 00-2-2H0v-2h1a2 2 0 002-2V5a2 2 0 012-2m14 0a2 2 0 012 2v4a2 2 0 002 2h1v2h-1a2 2 0 00-2 2v4a2 2 0 01-2 2h-2v-2h2v-5a2 2 0 012-2 2 2 0 01-2-2V5h-2V3h2m-7 12a1 1 0 011 1 1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1m-4 0a1 1 0 011 1 1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1m8 0a1 1 0 011 1 1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1z"/></svg>`,
  yaml: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.89 3l5.46 5.46L12 14.8V21H3V3h9.89M12 5H5v14h5v-5.64L15.64 8 12 4.36V5z"/></svg>`,
  yml: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.89 3l5.46 5.46L12 14.8V21H3V3h9.89M12 5H5v14h5v-5.64L15.64 8 12 4.36V5z"/></svg>`,
  
  // Markup/Style
  html: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.56l4.07-1.13.55-6.1H9.38L9.2 8.3h7.6l.2-2.03H7l.56 6.01h6.89l-.23 2.58-2.22.6-2.22-.6-.14-1.66h-2l.29 3.19L12 17.56M4.07 3h15.86L18.5 19.2 12 21l-6.5-1.8L4.07 3z"/></svg>`,
  css: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l-.65 3.34h13.59L17.5 8.5H4.27l-.53 3.01h13.22l-.83 4.35-4.77 1.6-4.12-1.6.27-1.91H4.39l-.67 4.49 7.16 2.51 7.85-2.77L21 3H5z"/></svg>`,
  scss: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0110 10 10 10 0 01-10 10A10 10 0 012 12 10 10 0 0112 2m-1.23 16.5c.45 1.27-.14 1.95-.5 2.09-.36.14-.73-.09-.86-.27-.14-.18-.09-.54.09-.68.18-.13.36-.04.45.09.14.18.18.36-.05.54-.04.05-.13.14-.04.27.09.14.45.23.68 0 .27-.27.36-.86.05-1.54-.14-.36-.73-1.04-1.36-1.77.18-.86.5-2.18.68-2.68.14-.36.5-1.23.91-1.27.4-.05.72.5.59 1.27-.14.77-.64 1.86-.78 2.09-.13.23-.04.5.14.5.18 0 .54-.36.72-.73.23-.45.36-.91.5-1.45.13-.55.22-1.36-.32-1.91-.31-.36-.86-.54-1.27-.22-.5.36-.68 1.09-.82 1.68-.14.59-.36 1.59-.5 2.09-.63-.77-1.31-1.45-1.45-2.27-.14-.82.36-1.68 1.04-2 .55-.27 1.59-.23 2.5.32.86.5 1.45 1.18 1.68 2 .27.95.05 1.68-.36 2.36-.36.59-.95 1.09-1.41 1.5z"/></svg>`,
  
  // Markdown/Text
  md: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.56 18H3.44C2.65 18 2 17.37 2 16.59V7.41C2 6.63 2.65 6 3.44 6h17.12c.79 0 1.44.63 1.44 1.41v9.18c0 .78-.65 1.41-1.44 1.41M6.81 15.19v-3.66l1.92 2.35 1.92-2.35v3.66h1.93V8.81h-1.93l-1.92 2.35-1.92-2.35H4.89v6.38h1.92M19.69 12h-1.92V8.81h-1.92V12h-1.93l2.89 3.28L19.69 12z"/></svg>`,
  txt: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6m4 18H6V4h7v5h5v11z"/></svg>`,
  
  // Python
  py: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 7.5A2.86 2.86 0 0122 10.36v3.28A2.86 2.86 0 0119.14 16.5h-6.28v.86h3.43a.86.86 0 110 1.71H7.71a.86.86 0 110-1.71h3.43v-.86H4.86A2.86 2.86 0 012 13.64v-3.28A2.86 2.86 0 014.86 7.5h6.28v-.86H7.71a.86.86 0 110-1.71h8.58a.86.86 0 110 1.71h-3.43v.86h6.28M6.57 12.79a1.07 1.07 0 100-2.15 1.07 1.07 0 000 2.15m10.86 0a1.07 1.07 0 100-2.15 1.07 1.07 0 000 2.15z"/></svg>`,
  
  // Shell
  sh: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 9h2.31l.32-3.27A2 2 0 019.61 4h4.78a2 2 0 011.98 1.73l.32 3.27H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2m2 11h10v-2H7v2m0-4h10v-2H7v2z"/></svg>`,
  bash: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 9h2.31l.32-3.27A2 2 0 019.61 4h4.78a2 2 0 011.98 1.73l.32 3.27H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2m2 11h10v-2H7v2m0-4h10v-2H7v2z"/></svg>`,
  zsh: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 9h2.31l.32-3.27A2 2 0 019.61 4h4.78a2 2 0 011.98 1.73l.32 3.27H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2v-9a2 2 0 012-2m2 11h10v-2H7v2m0-4h10v-2H7v2z"/></svg>`,
  
  // Config
  env: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4m0 4a3 3 0 013 3 3 3 0 01-3 3 3 3 0 01-3-3 3 3 0 013-3m0 10.5c-2.5 0-4.71-1.28-6-3.22.03-2 4-3.08 6-3.08 2 0 5.97 1.08 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>`,
  gitignore: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.6 10.59L8.38 4.8l1.69 1.7c-.24.85.15 1.78.93 2.23v5.54a2.002 2.002 0 00-1 3.75 2 2 0 003-1.75V8.73a2 2 0 00.73-.57l1.63 1.63a2 2 0 000 2.82l4.24 4.25c.78.78 2.04.78 2.83 0l1.41-1.41c.78-.78.78-2.05 0-2.83l-4.25-4.24a2 2 0 00-2.82 0l-1.63-1.63A2 2 0 0012.56 4a2 2 0 00-2.44-.66L8.38 1.6 2.6 7.38l2.2 2.21 1-1-1.2-1.2 4.3-4.3 4.24 4.25a2 2 0 00-1 3.1l-4.24-4.25L7.1 7l-1-1L3.8 8.3l1.2 1.2-1.4 1.39-1 .7z"/></svg>`,
  
  // Images
  png: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5M21 3H3C2 3 1 4 1 5v14c0 1 1 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2z"/></svg>`,
  jpg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5M21 3H3C2 3 1 4 1 5v14c0 1 1 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2z"/></svg>`,
  jpeg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5M21 3H3C2 3 1 4 1 5v14c0 1 1 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2z"/></svg>`,
  gif: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5M21 3H3C2 3 1 4 1 5v14c0 1 1 2 2 2h18c1 0 2-1 2-2V5c0-1-1-2-2-2z"/></svg>`,
  svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2m3 12l3-4.5L14 14l3-4 1.5 2H18v3H6v-2l2 2z"/></svg>`,
  
  // Misc
  lock: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17a2 2 0 002-2 2 2 0 00-2-2 2 2 0 00-2 2 2 2 0 002 2m6-9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V10a2 2 0 012-2h1V6a5 5 0 015-5 5 5 0 015 5v2h1m-6-5a3 3 0 00-3 3v2h6V6a3 3 0 00-3-3z"/></svg>`,
  
  // Default
  default: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6m4 18H6V4h7v5h5v11z"/></svg>`
};

// Get icon for file
function getFileIconSvg(filename, isDirectory = false, isOpen = false) {
  if (isDirectory) {
    return isOpen ? FILE_ICONS.folderOpen : FILE_ICONS.folder;
  }
  
  const ext = filename.split('.').pop().toLowerCase();
  const name = filename.toLowerCase();
  
  // Special files
  if (name === '.gitignore') return FILE_ICONS.gitignore;
  if (name === '.env' || name.startsWith('.env.')) return FILE_ICONS.env;
  if (name.includes('lock')) return FILE_ICONS.lock;
  
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

function getFileIconClass(filename, isDirectory = false) {
  if (isDirectory) return 'folder';
  const ext = filename.split('.').pop().toLowerCase();
  const name = filename.toLowerCase();
  if (name === '.gitignore') return 'git';
  if (name === '.env' || name.startsWith('.env.')) return 'env';
  if (name.includes('lock')) return 'lock';
  return FILE_ICONS[ext] ? ext : 'default';
}

// ============================================
// INITIALIZATION
// ============================================
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

require(['vs/editor/editor.main'], function() {
  monaco.editor.defineTheme('clawd-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6A9955' },
      { token: 'keyword', foreground: '569CD6' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'function', foreground: 'DCDCAA' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'variable', foreground: '9CDCFE' },
    ],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#cccccc',
      'editorCursor.foreground': '#4ade80',
      'editor.lineHighlightBackground': '#2d2d2d',
      'editorLineNumber.foreground': '#858585',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editorBracketMatch.background': '#0d3a58',
      'editorBracketMatch.border': '#4ade80',
    }
  });
  
  // Light theme for Monaco
  monaco.editor.defineTheme('clawd-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'd73a49' },
      { token: 'string', foreground: '032f62' },
      { token: 'number', foreground: '005cc5' },
      { token: 'function', foreground: '6f42c1' },
      { token: 'type', foreground: '22863a' },
      { token: 'variable', foreground: 'e36209' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#24292e',
      'editorCursor.foreground': '#16a34a',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editorLineNumber.foreground': '#959da5',
      'editorLineNumber.activeForeground': '#24292e',
      'editor.selectionBackground': '#c8e1ff',
      'editor.inactiveSelectionBackground': '#e8f0fe',
      'editorBracketMatch.background': '#c8e1ff',
      'editorBracketMatch.border': '#16a34a',
      'editorIndentGuide.background': '#eff2f5',
      'editorWhitespace.foreground': '#d1d5db',
    }
  });
  
  monaco.editor.setTheme('clawd-dark');
  init();
});

async function init() {
  // Get workspace
  const wsRes = await fetch('/api/workspace');
  const wsData = await wsRes.json();
  state.workspace = wsData.workspace;
  
  // Load settings first
  loadSettings();
  
  // Initialize components
  initTerminal();  // Must be before connectWebSocket so terminal is ready when ws opens
  if (typeof initMemoryPanel === 'function') initMemoryPanel();  // Memory panel
  connectWebSocket();
  await loadFileTree(state.workspace);
  setupKeyboardShortcuts();
  setupResizeHandlers();
  setupFindReplace();
  setupInlineEditKeyboard();
  loadGitStatus();
  checkGatewayStatus();
  loadSessionState();
  renderRecentFiles(); // Show recent files in explorer
  
  // Initialize Sprint 3 features
  if (typeof initProblemsPanel === 'function') {
    initProblemsPanel();
  }
  
  // Initialize debugger
  if (typeof initDebugger === 'function') {
    initDebugger();
  }
  
  // Initialize keybindings manager
  if (typeof KeybindingsManager !== 'undefined') {
    KeybindingsManager.init();
  }
  
  // Initialize theme manager
  if (typeof ThemeManager !== 'undefined') {
    ThemeManager.init();
  }
  
  // Initialize sound manager
  if (typeof SoundManager !== 'undefined') {
    SoundManager.init();
  }
  
  // Initialize onboarding (auto-starts for first-time users)
  if (typeof Onboarding !== 'undefined') {
    Onboarding.init();
  }
  
  // Initialize Brain module (Self-Learning System)
  if (typeof BrainModule !== 'undefined' && window.brainModule) {
    window.brainModule.init();
  }
}

function setupInlineEditKeyboard() {
  // Handle Enter to generate, Escape to close
  const input = document.getElementById('inlineEditInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const generateBtn = document.getElementById('inlineEditGenerate');
      const acceptBtn = document.getElementById('inlineEditAccept');
      
      if (acceptBtn.style.display !== 'none') {
        acceptInlineEdit();
      } else if (generateBtn.style.display !== 'none') {
        generateInlineEdit();
      }
    }
    if (e.key === 'Escape') {
      closeInlineEdit();
    }
  });
}

// ============================================
// WEBSOCKET CONNECTION
// ============================================
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  state.ws.onopen = () => {
    startTerminal();
  };
  
  state.ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleWebSocketMessage(data);
  };
  
  state.ws.onclose = () => {
    updateGatewayStatus(false);
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWebSocketMessage(data) {
  switch (data.type) {
    case 'terminal:output':
      // Use multi-terminal handler if available
      if (typeof handleTerminalOutput === 'function') {
        handleTerminalOutput(data.id, data.data);
      } else if (state.terminal) {
        state.terminal.write(data.data);
      }
      // Also write to right panel terminal if it exists (legacy)
      if (rightPanelState.terminalInstance && !data.id) {
        rightPanelState.terminalInstance.write(data.data);
      }
      break;
      
    case 'terminal:exit':
      if (typeof handleTerminalOutput === 'function') {
        handleTerminalOutput(data.id, '\r\n[Process exited]\r\n');
      } else if (state.terminal) {
        state.terminal.write('\r\n[Process exited]\r\n');
      }
      if (rightPanelState.terminalInstance && !data.id) {
        rightPanelState.terminalInstance.write('\r\n[Process exited]\r\n');
      }
      break;
      
    case 'gateway:status':
      updateGatewayStatus(data.connected);
      break;
      
    case 'gateway:health':
      // Health check from gateway - we're connected
      updateGatewayStatus(true);
      break;
      
    case 'gateway:tick':
      // Periodic tick - still connected
      if (!state.gatewayConnected) updateGatewayStatus(true);
      break;
      
    case 'clawd:typing':
      if (data.typing) {
        showThinkingWithTimer();
        setAiThinking(true);
      }
      break;
      
    case 'clawd:stream':
      setAiThinking(true); // Still thinking while streaming
      hideThinkingTimer(); // Hide timer when streaming starts
      if (data.delta) {
        appendToStreamingMessage(data.delta);
        // Also update right panel if visible
        if (rightPanelState.visible && rightPanelState.activePanel === 'ai') {
          appendToRightStreamingMessage(data.delta);
        }
      }
      break;
      
    case 'clawd:tool':
      // Tool call - show what Clawd is doing with detailed info
      const toolName = data.tool?.name || 'Unknown tool';
      const toolParams = data.tool?.input || data.tool?.params || {};
      const toolStatus = data.toolStatus || data.status || 'pending';
      
      setAiThinking(true, `Using ${toolName}...`);
      updateThinkingText(`Using ${toolName}...`);
      
      // Show tool call in chat
      if (toolStatus === 'start' || toolStatus === 'pending') {
        const toolId = showToolCall(toolName, toolParams, 'pending');
        // Store for later update
        if (data.tool?.id) {
          toolCallState.activeTools.set(data.tool.id, { elementId: toolId, name: toolName });
        }
      } else if (toolStatus === 'complete' || toolStatus === 'success') {
        // Find and update the tool call
        const toolInfo = data.tool?.id ? toolCallState.activeTools.get(data.tool.id) : null;
        if (toolInfo) {
          updateToolCall(toolInfo.elementId, 'success', data.tool?.result);
        }
      } else if (toolStatus === 'error') {
        const toolInfo = data.tool?.id ? toolCallState.activeTools.get(data.tool.id) : null;
        if (toolInfo) {
          updateToolCall(toolInfo.elementId, 'error', data.tool?.error);
        }
      }
      break;
      
    case 'clawd:response':
      hideThinkingTimer();
      hideTypingIndicator();
      setAiThinking(false);
      // Only add message if there's actual content (not empty string)
      if (data.data && data.data.trim()) {
        if (state.currentStreamingMessage) {
          finalizeStreamingMessage(data.data);
        } else {
          addAiMessage('assistant', data.data);
        }
        // Also add to right panel if visible
        if (rightPanelState.visible && rightPanelState.activePanel === 'ai') {
          addRightAiMessage('assistant', data.data);
        }
      } else if (data.final) {
        // Empty response but marked final - command completed silently
        // Just refresh context in case something changed
        fetchContextUsage();
      }
      // Clear any pending streaming message even if response is empty
      state.currentStreamingMessage = null;
      break;
      
    // Agent Mode messages
    case 'agent:plan':
    case 'agent:step-start':
    case 'agent:step-preview':
    case 'agent:step-complete':
    case 'agent:step-failed':
    case 'agent:complete':
    case 'agent:error':
      handleAgentMessage(data);
      break;
    
    // Debug events (Phase 2)
    case 'debug:stopped':
    case 'debug:continued':
    case 'debug:terminated':
    case 'debug:output':
    case 'debug:stackTrace':
      if (typeof handleDebugEvent === 'function') {
        const eventType = data.type.replace('debug:', '');
        handleDebugEvent(eventType, data);
      }
      break;
  }
}

// Right panel streaming message handling
let rightStreamingMessage = null;

function appendToRightStreamingMessage(delta) {
  const messages = document.getElementById('rightAiMessages');
  if (!rightStreamingMessage) {
    rightStreamingMessage = document.createElement('div');
    rightStreamingMessage.className = 'ai-message assistant';
    rightStreamingMessage.innerHTML = '<strong>Clawd 🐾</strong><div class="message-content streaming-content streaming-cursor"></div>';
    messages.appendChild(rightStreamingMessage);
  }
  
  const content = rightStreamingMessage.querySelector('.streaming-content');
  content.textContent += delta;
  messages.scrollTop = messages.scrollHeight;
}

function finalizeRightStreamingMessage() {
  if (rightStreamingMessage) {
    const content = rightStreamingMessage.querySelector('.streaming-content');
    content.classList.remove('streaming-cursor');
    rightStreamingMessage = null;
  }
}

// ============================================
// STATUS BAR & CONTEXT USAGE
// ============================================
const contextState = {
  used: 0,
  max: 200000,
  percentage: 0,
  tier: 'light', // light, elevated, high, danger
  lastUpdate: 0,
  updateInterval: null
};

async function checkGatewayStatus() {
  try {
    const res = await fetch('/api/gateway/status');
    const data = await res.json();
    updateGatewayStatus(data.connected);
    
    // Start context polling if connected
    if (data.connected && !contextState.updateInterval) {
      fetchContextUsage();
      contextState.updateInterval = setInterval(fetchContextUsage, 2000); // Every 2s
    }
  } catch (e) {
    updateGatewayStatus(false);
  }
}

async function fetchContextUsage() {
  try {
    const res = await fetch('/api/context');
    const data = await res.json();
    
    if (data.context) {
      updateContextDisplay(data.context);
    }
  } catch (e) {
    console.debug('Context fetch failed:', e);
  }
}

function updateContextDisplay(context) {
  contextState.used = context.used;
  contextState.max = context.max;
  contextState.percentage = context.percentage;
  contextState.lastUpdate = Date.now();
  
  // Determine tier based on percentage
  let tier = 'light';
  if (context.percentage >= 90) {
    tier = 'danger';
  } else if (context.percentage >= 75) {
    tier = 'high';
  } else if (context.percentage >= 60) {
    tier = 'elevated';
  }
  contextState.tier = tier;
  
  // Update UI
  const barFill = document.getElementById('contextBarFill');
  const contextText = document.getElementById('contextText');
  const contextUsage = document.getElementById('contextUsage');
  
  if (barFill) {
    barFill.style.width = `${context.percentage}%`;
    barFill.className = `context-bar-fill ${tier}`;
  }
  
  if (contextText) {
    // Format: "63% ctx" or "127k/200k"
    const usedK = Math.round(context.used / 1000);
    const maxK = Math.round(context.max / 1000);
    contextText.textContent = `${context.percentage}% (${usedK}k)`;
    contextText.className = `context-text ${tier}`;
  }
  
  if (contextUsage) {
    const usedK = Math.round(context.used / 1000);
    const maxK = Math.round(context.max / 1000);
    contextUsage.title = `Context: ${usedK}k / ${maxK}k tokens (${context.percentage}%)\nTier: ${tier.charAt(0).toUpperCase() + tier.slice(1)}\n${context.compactions || 0} compactions`;
  }
  
  // Show warning if high
  if (tier === 'danger' && !contextState.dangerWarningShown) {
    showNotification('⚠️ Context at 90%+ - Consider checkpointing!', 'warning');
    contextState.dangerWarningShown = true;
  } else if (tier !== 'danger') {
    contextState.dangerWarningShown = false;
  }
}

function showContextDetail() {
  const usedK = Math.round(contextState.used / 1000);
  const maxK = Math.round(contextState.max / 1000);
  const remaining = maxK - usedK;
  
  const tierDescriptions = {
    light: '✅ Plenty of room',
    elevated: '📊 Monitor usage',
    high: '⚠️ Consider checkpointing soon',
    danger: '🚨 Checkpoint recommended!'
  };
  
  const tierColors = {
    light: '#4ade80',
    elevated: '#3794ff',
    high: '#cca700',
    danger: '#f44747'
  };
  
  // Create popup
  const existing = document.getElementById('contextDetailPopup');
  if (existing) {
    existing.remove();
    return;
  }
  
  const popup = document.createElement('div');
  popup.id = 'contextDetailPopup';
  popup.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    z-index: 10000;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    min-width: 280px;
  `;
  
  popup.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <span style="font-weight: 600; font-size: 14px;">🧠 Context Usage</span>
      <span style="cursor: pointer; opacity: 0.6;" onclick="this.parentElement.parentElement.remove()">✕</span>
    </div>
    <div style="margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span style="color: var(--text-secondary); font-size: 12px;">Used</span>
        <span style="font-size: 12px; font-weight: 500;">${usedK}k / ${maxK}k tokens</span>
      </div>
      <div style="width: 100%; height: 8px; background: var(--bg-primary); border-radius: 4px; overflow: hidden;">
        <div style="width: ${contextState.percentage}%; height: 100%; background: ${tierColors[contextState.tier]}; border-radius: 4px;"></div>
      </div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px;">
      <div>
        <span style="color: var(--text-secondary);">Percentage</span>
        <div style="font-weight: 600; color: ${tierColors[contextState.tier]};">${contextState.percentage}%</div>
      </div>
      <div>
        <span style="color: var(--text-secondary);">Remaining</span>
        <div style="font-weight: 500;">${remaining}k tokens</div>
      </div>
    </div>
    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
      <div style="font-size: 12px; color: ${tierColors[contextState.tier]};">
        ${tierDescriptions[contextState.tier]}
      </div>
    </div>
  `;
  
  document.body.appendChild(popup);
  
  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!popup.contains(e.target) && !e.target.closest('#contextUsage')) {
        popup.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 100);
}

function updateGatewayStatus(connected) {
  state.gatewayConnected = connected;

  const statusAi = document.getElementById('statusAi');
  const statusAiText = document.getElementById('statusAiText');

  statusAi.className = 'ai-status ' + (connected ? 'connected' : 'offline');
  statusAiText.textContent = connected ? 'Clawd Ready' : 'Local Mode';
  statusAi.title = connected
    ? 'Connected to DNA Gateway - AI features available'
    : 'Gateway unavailable - IDE works normally, AI features disabled';

  // Also update old status indicator for titlebar
  const statusEl = document.getElementById('connectionStatus');
  const indicatorEl = document.querySelector('.status-indicator');

  if (statusEl) {
    statusEl.textContent = connected ? 'Connected' : 'Local';
    statusEl.style.color = connected ? '#4ade80' : '#888';
  }
  if (indicatorEl) {
    indicatorEl.classList.toggle('online', connected);
  }
}

function setAiThinking(thinking, message = 'Thinking...') {
  state.aiThinking = thinking;
  const statusAi = document.getElementById('statusAi');
  const statusAiText = document.getElementById('statusAiText');

  if (thinking) {
    statusAi.className = 'ai-status thinking';
    statusAiText.textContent = message;
  } else if (state.gatewayConnected) {
    statusAi.className = 'ai-status connected';
    statusAiText.textContent = 'Clawd Ready';
  } else {
    statusAi.className = 'ai-status offline';
    statusAiText.textContent = 'Local Mode';
  }
}

function updateStatusBar() {
  const pane = getActivePane();
  const editor = pane?.editor;
  
  if (!editor) return;
  
  const position = editor.getPosition();
  const model = editor.getModel();
  
  // Position
  document.getElementById('statusLine').textContent = position?.lineNumber || 1;
  document.getElementById('statusColumn').textContent = position?.column || 1;
  
  // Language
  if (model) {
    const lang = model.getLanguageId();
    const langNames = {
      javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON',
      html: 'HTML', css: 'CSS', markdown: 'Markdown', python: 'Python',
      plaintext: 'Plain Text', scss: 'SCSS', yaml: 'YAML', shell: 'Shell'
    };
    document.getElementById('statusLang').textContent = langNames[lang] || lang;
  }
  
  // Pane indicator (if multiple panes)
  if (state.panes.length > 1) {
    document.getElementById('statusLang').textContent += ` (Pane ${state.activePane + 1})`;
  }
}

// ============================================
// FILE TREE
// ============================================
async function loadFileTree(path) {
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    renderFileTree(data.items, document.getElementById('fileTree'), path);
  } catch (err) {
    console.error('Failed to load file tree:', err);
  }
}

function renderFileTree(items, container, parentPath) {
  container.innerHTML = '';
  
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.dataset.path = item.path;
    div.dataset.type = item.type;
    
    const iconClass = getFileIconClass(item.name, item.type === 'directory');
    const iconSvg = getFileIconSvg(item.name, item.type === 'directory');
    
    div.innerHTML = `
      <span class="file-icon ${iconClass}">${iconSvg}</span>
      <span class="name">${item.name}</span>
    `;
    
    div.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e, item);
    };
    
    if (item.type === 'directory') {
      div.onclick = (e) => {
        e.stopPropagation();
        toggleDirectory(div, item.path);
      };
      
      const children = document.createElement('div');
      children.className = 'directory-children collapsed';
      container.appendChild(div);
      container.appendChild(children);
    } else {
      div.onclick = (e) => {
        // Double-click to pin, single-click for preview
        openFile(item.path, e.detail === 1);
      };
      div.ondblclick = () => openFile(item.path, false);
      
      // Hover preview
      let previewTimeout;
      div.onmouseenter = (e) => {
        previewTimeout = setTimeout(() => showFilePreview(item.path, e), 500);
      };
      div.onmouseleave = () => {
        clearTimeout(previewTimeout);
        hideFilePreview();
      };
      
      container.appendChild(div);
    }
  }
}

async function toggleDirectory(element, path) {
  const children = element.nextElementSibling;
  if (!children) return;
  
  const iconEl = element.querySelector('.file-icon');
  
  if (children.classList.contains('collapsed')) {
    children.classList.remove('collapsed');
    iconEl.innerHTML = FILE_ICONS.folderOpen;
    
    if (children.children.length === 0) {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      renderFileTree(data.items, children, path);
    }
  } else {
    children.classList.add('collapsed');
    iconEl.innerHTML = FILE_ICONS.folder;
  }
}

// ============================================
// FILE PREVIEW ON HOVER
// ============================================
let filePreviewCache = new Map();

async function showFilePreview(filePath, event) {
  // Don't preview binary files
  const ext = filePath.split('.').pop()?.toLowerCase();
  const binaryExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'tar', 'gz'];
  if (binaryExts.includes(ext)) return;
  
  // Get or fetch content
  let content = filePreviewCache.get(filePath);
  if (!content) {
    try {
      const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const data = await res.json();
      content = data.content;
      // Cache with size limit
      if (filePreviewCache.size > 50) {
        const firstKey = filePreviewCache.keys().next().value;
        filePreviewCache.delete(firstKey);
      }
      filePreviewCache.set(filePath, content);
    } catch (e) {
      return;
    }
  }
  
  // Create preview tooltip
  let preview = document.getElementById('filePreview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'filePreview';
    preview.className = 'file-preview-tooltip';
    document.body.appendChild(preview);
  }
  
  // Get first N lines
  const lines = content.split('\n').slice(0, 15);
  const truncated = lines.join('\n') + (content.split('\n').length > 15 ? '\n...' : '');
  const language = getLanguageFromPath(filePath);
  
  preview.innerHTML = `
    <div class="preview-header">
      <span class="preview-filename">${filePath.split('/').pop()}</span>
      <span class="preview-lines">${content.split('\n').length} lines</span>
    </div>
    <pre class="preview-content"><code class="language-${language}">${escapeHtml(truncated)}</code></pre>
  `;
  
  // Position near cursor
  const rect = event.target.getBoundingClientRect();
  preview.style.left = `${rect.right + 10}px`;
  preview.style.top = `${Math.min(rect.top, window.innerHeight - 300)}px`;
  preview.classList.add('visible');
}

function hideFilePreview() {
  const preview = document.getElementById('filePreview');
  if (preview) {
    preview.classList.remove('visible');
  }
}

function getLanguageFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  const map = {
    'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust', 'java': 'java',
    'html': 'html', 'css': 'css', 'scss': 'scss', 'json': 'json', 'md': 'markdown',
    'sh': 'bash', 'yml': 'yaml', 'yaml': 'yaml', 'xml': 'xml', 'sql': 'sql'
  };
  return map[ext] || 'plaintext';
}

// ============================================
// PANE MANAGEMENT
// ============================================
function createPane(id) {
  return {
    id,
    editor: null,
    files: new Map(),
    activeFile: null
  };
}

function getActivePane() {
  return state.panes[state.activePane];
}

function setActivePane(paneId) {
  state.activePane = paneId;
  
  // Update visual state
  document.querySelectorAll('.editor-pane').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.paneId) === paneId);
  });
  
  const pane = state.panes[paneId];
  if (pane) {
    state.currentFile = pane.activeFile;
    updateBreadcrumbs(pane.activeFile);
    updateStatusBar();
  }
}

function splitPane(direction = 'horizontal') {
  if (state.panes.length >= 4) {
    showNotification('Maximum 4 panes allowed', 'warning');
    return;
  }
  
  const newPaneId = state.panes.length;
  const newPane = createPane(newPaneId);
  state.panes.push(newPane);
  state.splitDirection = direction;
  
  // Create DOM elements for new pane
  const panesContainer = document.getElementById('editorPanes');
  panesContainer.classList.toggle('vertical', direction === 'vertical');
  
  const paneEl = document.createElement('div');
  paneEl.className = 'editor-pane';
  paneEl.id = `editorPane${newPaneId}`;
  paneEl.dataset.paneId = newPaneId;
  paneEl.innerHTML = `
    <div class="pane-tabs-container">
      <div class="pane-tabs" id="paneTabs${newPaneId}"></div>
      <div class="pane-actions">
        <button class="pane-action-btn" onclick="closePane(${newPaneId})" title="Close Pane">×</button>
      </div>
    </div>
    <div class="pane-editor-container" id="paneEditor${newPaneId}">
      <div class="welcome-screen" id="welcomeScreen${newPaneId}">
        <p style="color: var(--text-secondary);">Open a file to start editing</p>
      </div>
    </div>
  `;
  
  // Add resize handle to previous pane
  const prevPane = document.getElementById(`editorPane${newPaneId - 1}`);
  if (prevPane && !prevPane.querySelector('.pane-resize-handle')) {
    const handle = document.createElement('div');
    handle.className = `pane-resize-handle ${direction === 'horizontal' ? 'horizontal' : 'vertical'}`;
    handle.dataset.paneId = newPaneId - 1;
    prevPane.appendChild(handle);
    setupPaneResizeHandle(handle, newPaneId - 1);
  }
  
  panesContainer.appendChild(paneEl);
  
  // Focus new pane
  setActivePane(newPaneId);
  
  // If current file exists, open it in new pane too
  const currentPane = state.panes[0];
  if (currentPane.activeFile) {
    openFileInPane(currentPane.activeFile, newPaneId, false);
  }
  
  showNotification(`Split ${direction}`, 'info');
}

function closePane(paneId) {
  if (state.panes.length <= 1) {
    showNotification('Cannot close last pane', 'warning');
    return;
  }
  
  const pane = state.panes[paneId];
  if (!pane) return;
  
  // Dispose editor
  if (pane.editor) {
    pane.editor.dispose();
  }
  
  // Remove from array
  state.panes.splice(paneId, 1);
  
  // Update pane IDs
  state.panes.forEach((p, i) => p.id = i);
  
  // Remove DOM element
  const paneEl = document.getElementById(`editorPane${paneId}`);
  if (paneEl) paneEl.remove();
  
  // Switch to first pane
  setActivePane(0);
  
  // Re-render panes with updated IDs
  rerenderPanes();
}

function rerenderPanes() {
  const panesContainer = document.getElementById('editorPanes');
  panesContainer.innerHTML = '';
  
  state.panes.forEach((pane, i) => {
    pane.id = i;
    const paneEl = document.createElement('div');
    paneEl.className = 'editor-pane' + (i === state.activePane ? ' active' : '');
    paneEl.id = `editorPane${i}`;
    paneEl.dataset.paneId = i;
    paneEl.innerHTML = `
      <div class="pane-tabs-container">
        <div class="pane-tabs" id="paneTabs${i}"></div>
        ${state.panes.length > 1 ? `
        <div class="pane-actions">
          <button class="pane-action-btn" onclick="closePane(${i})" title="Close Pane">×</button>
        </div>
        ` : ''}
      </div>
      <div class="pane-editor-container" id="paneEditor${i}"></div>
    `;
    panesContainer.appendChild(paneEl);
    
    // Recreate editor
    if (pane.activeFile) {
      initPaneEditor(i);
      renderPaneTabs(i);
    }
  });
}

function setupPaneResizeHandle(handle, paneId) {
  let isResizing = false;
  let startX, startY, startWidth, startHeight;
  
  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    const paneEl = document.getElementById(`editorPane${paneId}`);
    startWidth = paneEl.offsetWidth;
    startHeight = paneEl.offsetHeight;
    handle.classList.add('active');
    document.body.style.cursor = state.splitDirection === 'horizontal' ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const paneEl = document.getElementById(`editorPane${paneId}`);
    
    if (state.splitDirection === 'horizontal') {
      const delta = e.clientX - startX;
      const newWidth = Math.max(200, startWidth + delta);
      paneEl.style.flex = 'none';
      paneEl.style.width = `${newWidth}px`;
    } else {
      const delta = e.clientY - startY;
      const newHeight = Math.max(100, startHeight + delta);
      paneEl.style.flex = 'none';
      paneEl.style.height = `${newHeight}px`;
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ============================================
// FILE OPERATIONS
// ============================================
async function openFile(path, preview = false) {
  return openFileInPane(path, state.activePane, preview);
}

async function openFileInPane(path, paneId, preview = false) {
  try {
    const pane = state.panes[paneId];
    if (!pane) return;
    
    // If already open in this pane, just switch to it
    if (pane.files.has(path)) {
      const file = pane.files.get(path);
      if (!preview && file.preview) {
        file.preview = false;
      }
      switchToFileInPane(path, paneId);
      return;
    }
    
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    
    if (data.error) {
      showNotification(`Error: ${data.error}`, 'error');
      return;
    }
    
    // If opening preview, close existing preview in this pane
    if (preview) {
      for (const [existingPath, file] of pane.files) {
        if (file.preview) {
          closeFileInPane(existingPath, paneId, true);
          break;
        }
      }
    }
    
    const uri = monaco.Uri.file(`${paneId}:${path}`); // Unique URI per pane
    let model = monaco.editor.getModel(uri);
    if (!model) {
      const language = getLanguageForFile(path);
      model = monaco.editor.createModel(data.content, language, uri);
    }
    
    pane.files.set(path, {
      path,
      name: data.name,
      model,
      modified: false,
      originalContent: data.content,
      preview
    });
    
    // Also track in global openFiles for backwards compat
    if (!state.openFiles.has(path)) {
      state.openFiles.set(path, { path, name: data.name, model: null, modified: false, originalContent: data.content, preview });
    }
    
    // Initialize editor if needed
    if (!pane.editor) {
      initPaneEditor(paneId);
    }
    
    // Hide welcome screen
    const welcomeScreen = document.getElementById(`welcomeScreen${paneId}`);
    if (welcomeScreen) welcomeScreen.style.display = 'none';
    
    // Set model
    pane.editor.setModel(model);
    pane.activeFile = path;
    
    // Render tabs
    renderPaneTabs(paneId);
    
    // Update state
    if (paneId === state.activePane) {
      state.currentFile = path;
      updateBreadcrumbs(path);
      updateStatusBar();
    }
    
    // Update file tree selection
    document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.path === path);
    });
    
    addToRecent(path);
    
  } catch (err) {
    console.error('Failed to open file:', err);
    showNotification('Failed to open file', 'error');
  }
}

function initPaneEditor(paneId) {
  const pane = state.panes[paneId];
  const container = document.getElementById(`paneEditor${paneId}`);
  
  if (!container || pane.editor) return;
  
  pane.editor = monaco.editor.create(container, {
    theme: 'clawd-dark',
    fontSize: 14,
    fontFamily: "'SF Mono', 'Fira Code', Menlo, Monaco, monospace",
    fontLigatures: true,
    minimap: { enabled: true, scale: 1 },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on',
    lineNumbers: 'on',
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    padding: { top: 10 },
    glyphMargin: true, // Enable for breakpoints
  });
  
  // Setup breakpoint gutter click handler
  if (typeof setupBreakpointGutter === 'function') {
    setupBreakpointGutter(pane.editor, paneId);
  }
  
  // Track changes
  pane.editor.onDidChangeModelContent(() => {
    if (pane.activeFile && pane.files.has(pane.activeFile)) {
      const file = pane.files.get(pane.activeFile);
      const isModified = pane.editor.getValue() !== file.originalContent;
      if (file.modified !== isModified) {
        file.modified = isModified;
        updatePaneTabModified(paneId, pane.activeFile, isModified);
      }
    }
  });
  
  // Track cursor position
  pane.editor.onDidChangeCursorPosition(() => {
    if (paneId === state.activePane) {
      updateStatusBar();
      updateCurrentSymbol();
    }
  });
  
  // Focus handler
  pane.editor.onDidFocusEditorText(() => {
    setActivePane(paneId);
  });
  
  // Add commands
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => showInlineEditWidget(paneId));
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => toggleFindWidget(false));
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => toggleFindWidget(true));
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, openGlobalSearch);
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backslash, () => splitPane('horizontal'));
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Backslash, () => splitPane('vertical'));
  pane.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, () => showCodeActionsWidget(paneId));
  
  // Context menu
  addEditorContextActionsToPane(pane.editor);
  
  // Inline completions
  initInlineCompletionsForPane(paneId);
}

function switchToFileInPane(path, paneId) {
  const pane = state.panes[paneId];
  if (!pane || !pane.files.has(path)) return;
  
  const file = pane.files.get(path);
  pane.editor.setModel(file.model);
  pane.activeFile = path;
  
  renderPaneTabs(paneId);
  
  // Update breakpoint decorations for new file
  if (typeof updatePaneBreakpointDecorations === 'function') {
    updatePaneBreakpointDecorations(paneId);
  }
  
  if (paneId === state.activePane) {
    state.currentFile = path;
    updateBreadcrumbs(path);
    updateStatusBar();
  }
}

function closeFileInPane(path, paneId, force = false) {
  const pane = state.panes[paneId];
  if (!pane || !pane.files.has(path)) return;
  
  const file = pane.files.get(path);
  
  if (!force && file.modified && !confirm('Unsaved changes. Close anyway?')) return;
  
  file.model.dispose();
  pane.files.delete(path);
  
  if (pane.files.size > 0) {
    const nextPath = pane.files.keys().next().value;
    switchToFileInPane(nextPath, paneId);
  } else {
    pane.activeFile = null;
    if (pane.editor) pane.editor.setModel(null);
    const welcomeScreen = document.getElementById(`welcomeScreen${paneId}`);
    if (welcomeScreen) welcomeScreen.style.display = 'flex';
  }
  
  renderPaneTabs(paneId);
  
  if (paneId === state.activePane) {
    state.currentFile = pane.activeFile;
    updateBreadcrumbs(pane.activeFile);
  }
  
  saveSessionState();
}

function renderPaneTabs(paneId) {
  const pane = state.panes[paneId];
  const tabsContainer = document.getElementById(`paneTabs${paneId}`);
  if (!tabsContainer) return;
  
  tabsContainer.innerHTML = '';
  
  for (const [path, file] of pane.files) {
    const tab = document.createElement('div');
    tab.className = 'pane-tab' + (path === pane.activeFile ? ' active' : '') + (file.modified ? ' modified' : '');
    tab.dataset.path = path;
    
    const iconClass = getFileIconClass(file.name);
    const iconSvg = getFileIconSvg(file.name);
    
    tab.innerHTML = `
      <span class="file-icon ${iconClass}">${iconSvg}</span>
      <span class="name">${file.name}</span>
      <span class="close" data-path="${path}">×</span>
    `;
    
    tab.onclick = (e) => {
      if (e.target.classList.contains('close')) {
        closeFileInPane(e.target.dataset.path, paneId);
      } else {
        switchToFileInPane(path, paneId);
      }
    };
    
    // Tab context menu
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      showTabContextMenu(e, path, paneId);
    };
    
    tabsContainer.appendChild(tab);
  }
}

// Tab context menu
function showTabContextMenu(event, path, paneId) {
  // Remove existing
  document.querySelectorAll('.tab-context-menu').forEach(m => m.remove());
  
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu context-menu';
  menu.innerHTML = `
    <div class="context-item" onclick="closeFileInPane('${path}', ${paneId}); closeTabContextMenu()">
      <span>Close</span>
      <kbd>⌘W</kbd>
    </div>
    <div class="context-item" onclick="closeOtherTabs('${path}', ${paneId}); closeTabContextMenu()">
      <span>Close Others</span>
    </div>
    <div class="context-item" onclick="closeTabsToRight('${path}', ${paneId}); closeTabContextMenu()">
      <span>Close to the Right</span>
    </div>
    <div class="context-item" onclick="closeAllTabs(${paneId}); closeTabContextMenu()">
      <span>Close All</span>
    </div>
    <div class="context-separator"></div>
    <div class="context-item" onclick="copyPath('${path}'); closeTabContextMenu()">
      <span>Copy Path</span>
    </div>
    <div class="context-item" onclick="revealInExplorer('${path}'); closeTabContextMenu()">
      <span>Reveal in Explorer</span>
    </div>
  `;
  
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  document.body.appendChild(menu);
  
  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', closeTabContextMenu);
  }, 10);
}

function closeTabContextMenu() {
  document.querySelectorAll('.tab-context-menu').forEach(m => m.remove());
  document.removeEventListener('click', closeTabContextMenu);
}

function closeOtherTabs(keepPath, paneId) {
  const pane = state.panes[paneId];
  if (!pane) return;
  
  const pathsToClose = [...pane.files.keys()].filter(p => p !== keepPath);
  pathsToClose.forEach(p => closeFileInPane(p, paneId));
}

function closeTabsToRight(path, paneId) {
  const pane = state.panes[paneId];
  if (!pane) return;
  
  const paths = [...pane.files.keys()];
  const index = paths.indexOf(path);
  if (index === -1) return;
  
  const pathsToClose = paths.slice(index + 1);
  pathsToClose.forEach(p => closeFileInPane(p, paneId));
}

function closeAllTabs(paneId) {
  const pane = state.panes[paneId];
  if (!pane) return;
  
  const pathsToClose = [...pane.files.keys()];
  pathsToClose.forEach(p => closeFileInPane(p, paneId));
}

function copyPath(path) {
  navigator.clipboard.writeText(path);
  showNotification('Path copied!', 'success');
}

function revealInExplorer(path) {
  // Expand parent folders and highlight file
  const parts = path.split('/');
  let currentPath = '';
  
  // Expand each folder
  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += (i > 0 ? '/' : '') + parts[i];
    const folderItem = document.querySelector(`.file-item[data-path="${currentPath}"]`);
    if (folderItem) {
      const children = folderItem.nextElementSibling;
      if (children?.classList.contains('collapsed')) {
        toggleDirectory(folderItem, currentPath);
      }
    }
  }
  
  // Highlight the file
  setTimeout(() => {
    const fileItem = document.querySelector(`.file-item[data-path="${path}"]`);
    if (fileItem) {
      fileItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      fileItem.classList.add('highlighted');
      setTimeout(() => fileItem.classList.remove('highlighted'), 2000);
    }
  }, 300);
}

function updatePaneTabModified(paneId, path, modified) {
  const tabsContainer = document.getElementById(`paneTabs${paneId}`);
  if (!tabsContainer) return;
  
  const tab = tabsContainer.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (tab) tab.classList.toggle('modified', modified);
}

function getLanguageForFile(path) {
  const ext = path.split('.').pop().toLowerCase();
  const languages = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', md: 'markdown', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini',
    sql: 'sql', graphql: 'graphql', xml: 'xml', svg: 'xml',
  };
  return languages[ext] || 'plaintext';
}

async function saveCurrentFile() {
  const pane = getActivePane();
  if (!pane || !pane.activeFile || !pane.editor) return;
  
  const content = pane.editor.getValue();
  const path = pane.activeFile;
  
  try {
    const res = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content })
    });
    
    const data = await res.json();
    if (data.success) {
      const file = pane.files.get(path);
      if (file) {
        file.originalContent = content;
        file.modified = false;
        updatePaneTabModified(pane.id, path, false);
      }
      // Play save sound directly (faster than notification hook)
      if (typeof playSound === 'function') playSound('save');
      showNotification('File saved', 'success');
      saveSessionState();
    }
  } catch (err) {
    showNotification('Failed to save file', 'error');
  }
}

function addToRecent(path) {
  state.recentFiles = state.recentFiles.filter(p => p !== path);
  state.recentFiles.unshift(path);
  if (state.recentFiles.length > 10) state.recentFiles.pop();
  renderRecentFiles();
}

// Recent Files UI
let recentFilesCollapsed = false;

function toggleRecentFiles() {
  recentFilesCollapsed = !recentFilesCollapsed;
  const list = document.getElementById('recentFilesList');
  const toggle = document.getElementById('recentFilesToggle');
  
  if (list) list.style.display = recentFilesCollapsed ? 'none' : 'block';
  if (toggle) toggle.textContent = recentFilesCollapsed ? '▶' : '▼';
}

function renderRecentFiles() {
  const list = document.getElementById('recentFilesList');
  if (!list) return;
  
  if (state.recentFiles.length === 0) {
    list.innerHTML = '<div class="recent-file-item" style="color: var(--text-secondary); cursor: default;">No recent files</div>';
    return;
  }
  
  list.innerHTML = state.recentFiles.slice(0, 5).map(path => {
    const name = path.split('/').pop();
    const dir = path.split('/').slice(0, -1).join('/') || '.';
    const iconSvg = getFileIconSvg(name);
    
    return `
      <div class="recent-file-item" onclick="openFile('${path}')">
        <span class="file-icon">${iconSvg}</span>
        <span class="recent-file-name">${name}</span>
        <span class="recent-file-path">${dir}</span>
      </div>
    `;
  }).join('');
}

// ============================================
// TABS
// ============================================
function addTab(path, name, preview = false) {
  const tabs = document.getElementById('tabs');
  const tab = document.createElement('div');
  tab.className = 'tab' + (preview ? ' preview' : '');
  tab.dataset.path = path;
  tab.draggable = true;
  
  const iconClass = getFileIconClass(name);
  const iconSvg = getFileIconSvg(name);
  
  tab.innerHTML = `
    <span class="file-icon ${iconClass}">${iconSvg}</span>
    <span class="name">${name}</span>
    <span class="close" onclick="event.stopPropagation(); closeTab('${path.replace(/'/g, "\\'")}')">×</span>
  `;
  
  tab.onclick = () => switchToTab(path);
  tabs.appendChild(tab);
}

function switchToTab(path) {
  if (!state.openFiles.has(path)) return;
  const file = state.openFiles.get(path);
  state.editor.setModel(file.model);
  state.currentFile = path;
  updateActiveTab(path);
  updateBreadcrumbs(path);
  updateStatusBar();
}

function updateActiveTab(path) {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.path === path);
  });
}

function updateTabModified(path, modified) {
  const tab = document.querySelector(`.tab[data-path="${CSS.escape(path)}"]`);
  if (tab) tab.classList.toggle('modified', modified);
}

function updateTabPreviewState(path, preview) {
  const tab = document.querySelector(`.tab[data-path="${CSS.escape(path)}"]`);
  if (tab) tab.classList.toggle('preview', preview);
}

function closeTab(path, force = false) {
  const file = state.openFiles.get(path);
  if (!file) return;
  
  if (!force && file.modified && !confirm('Unsaved changes. Close anyway?')) return;
  
  file.model.dispose();
  state.openFiles.delete(path);
  
  const tab = document.querySelector(`.tab[data-path="${CSS.escape(path)}"]`);
  if (tab) tab.remove();
  
  if (state.openFiles.size > 0) {
    const nextPath = state.openFiles.keys().next().value;
    switchToTab(nextPath);
  } else {
    state.currentFile = null;
    document.getElementById('welcomeScreen').style.display = 'flex';
    document.getElementById('breadcrumbs').style.display = 'none';
    if (state.editor) state.editor.setModel(null);
  }
  
  saveSessionState();
}

function setupTabDragging() {
  const tabs = document.getElementById('tabs');
  let draggedTab = null;
  
  tabs.addEventListener('dragstart', (e) => {
    if (e.target.classList.contains('tab')) {
      draggedTab = e.target;
      e.target.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  
  tabs.addEventListener('dragend', (e) => {
    if (e.target.classList.contains('tab')) {
      e.target.classList.remove('dragging');
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
      draggedTab = null;
    }
  });
  
  tabs.addEventListener('dragover', (e) => {
    e.preventDefault();
    const target = e.target.closest('.tab');
    if (target && target !== draggedTab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
      target.classList.add('drag-over');
    }
  });
  
  tabs.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.tab');
    if (target && draggedTab && target !== draggedTab) {
      const allTabs = [...tabs.querySelectorAll('.tab')];
      const draggedIndex = allTabs.indexOf(draggedTab);
      const targetIndex = allTabs.indexOf(target);
      
      if (draggedIndex < targetIndex) {
        target.after(draggedTab);
      } else {
        target.before(draggedTab);
      }
    }
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
  });
}

// ============================================
// BREADCRUMBS
// ============================================
const breadcrumbState = {
  currentSymbol: null,
  symbols: []
};

function updateBreadcrumbs(path) {
  const breadcrumbs = document.getElementById('breadcrumbs');
  if (!path) {
    breadcrumbs.style.display = 'none';
    return;
  }
  
  breadcrumbs.style.display = 'flex';
  
  const relativePath = path.replace(state.workspace + '/', '');
  const parts = relativePath.split('/');
  
  let html = '';
  let currentPath = state.workspace;
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    currentPath += '/' + part;
    const isLast = i === parts.length - 1;
    const isDir = !isLast;
    
    const iconClass = isDir ? 'folder' : getFileIconClass(part);
    const iconSvg = isDir ? FILE_ICONS.folder : getFileIconSvg(part);
    
    html += `
      <div class="breadcrumb-item ${isDir ? 'has-dropdown' : ''}" data-path="${currentPath}" onclick="breadcrumbClick(event, '${currentPath.replace(/'/g, "\\'")}', ${isDir})">
        <span class="file-icon ${iconClass}">${iconSvg}</span>
        <span>${part}</span>
        ${isDir ? '<span class="breadcrumb-arrow">▾</span>' : ''}
      </div>
    `;
    
    if (!isLast) {
      html += `<span class="breadcrumb-separator">›</span>`;
    }
  }
  
  // Add symbol breadcrumb segment
  html += `<span class="breadcrumb-separator">›</span>`;
  html += `
    <div class="breadcrumb-item breadcrumb-symbol has-dropdown" onclick="showSymbolDropdown(event)">
      <span class="symbol-icon">○</span>
      <span id="currentSymbolName">Select symbol...</span>
      <span class="breadcrumb-arrow">▾</span>
    </div>
  `;
  
  breadcrumbs.innerHTML = html;
  
  // Load symbols for current file
  loadFileSymbols(path);
}

async function loadFileSymbols(path) {
  const editor = state.editor;
  if (!editor) return;
  
  // Get symbols from Monaco's document symbol provider
  const model = editor.getModel();
  if (!model) return;
  
  try {
    const symbols = await monaco.languages.getLanguages()
      .find(l => l.id === model.getLanguageId())
      ?.loader?.()
      ?.then(() => monaco.editor.getModelMarkers({ resource: model.uri }));
    
    // Use Monaco's built-in outline provider
    const outline = await getDocumentSymbols(model);
    breadcrumbState.symbols = outline;
    
    // Update symbol based on cursor position
    updateCurrentSymbol();
  } catch (e) {
    breadcrumbState.symbols = [];
  }
}

async function getDocumentSymbols(model) {
  // Try to get symbols from Monaco
  const symbols = [];
  
  // Simple regex-based symbol extraction for common patterns
  const content = model.getValue();
  const lines = content.split('\n');
  
  const patterns = [
    // Functions
    { regex: /(?:function|async function)\s+(\w+)\s*\(/g, kind: 'function', icon: 'ƒ' },
    { regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, kind: 'function', icon: 'ƒ' },
    { regex: /(?:const|let|var)\s+(\w+)\s*=\s*function/g, kind: 'function', icon: 'ƒ' },
    // Classes
    { regex: /class\s+(\w+)/g, kind: 'class', icon: '◆' },
    // Methods (inside objects/classes)
    { regex: /^\s*(\w+)\s*\([^)]*\)\s*\{/gm, kind: 'method', icon: '○' },
    { regex: /^\s*(?:async\s+)?(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/gm, kind: 'method', icon: '○' },
    // Markdown headers
    { regex: /^(#{1,6})\s+(.+)$/gm, kind: 'header', icon: '#', nameGroup: 2 }
  ];
  
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        const name = match[pattern.nameGroup || 1];
        if (name && !name.match(/^(if|for|while|switch|catch|return)$/)) {
          symbols.push({
            name,
            kind: pattern.kind,
            icon: pattern.icon,
            line: lineNum + 1,
            column: match.index + 1
          });
        }
      }
    }
  }
  
  return symbols;
}

function updateCurrentSymbol() {
  const editor = state.editor;
  if (!editor || breadcrumbState.symbols.length === 0) return;
  
  const position = editor.getPosition();
  if (!position) return;
  
  // Find the symbol containing current cursor position
  let currentSymbol = null;
  for (const symbol of breadcrumbState.symbols) {
    if (symbol.line <= position.lineNumber) {
      currentSymbol = symbol;
    } else {
      break;
    }
  }
  
  const symbolNameEl = document.getElementById('currentSymbolName');
  if (symbolNameEl && currentSymbol) {
    symbolNameEl.textContent = currentSymbol.name;
    breadcrumbState.currentSymbol = currentSymbol;
  }
}

function breadcrumbClick(event, path, isDir) {
  event.stopPropagation();
  
  if (isDir) {
    showBreadcrumbDropdown(event.currentTarget, path);
  } else {
    openFile(path);
  }
}

async function showBreadcrumbDropdown(element, dirPath) {
  closeBreadcrumbDropdowns();
  
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`);
    const data = await res.json();
    
    const dropdown = document.createElement('div');
    dropdown.className = 'breadcrumb-dropdown';
    
    let html = '';
    for (const item of data.items.slice(0, 20)) {
      const iconClass = getFileIconClass(item.name, item.type === 'directory');
      const iconSvg = getFileIconSvg(item.name, item.type === 'directory');
      html += `
        <div class="breadcrumb-dropdown-item" onclick="breadcrumbDropdownSelect('${item.path.replace(/'/g, "\\'")}', ${item.type === 'directory'})">
          <span class="file-icon ${iconClass}">${iconSvg}</span>
          <span>${item.name}</span>
        </div>
      `;
    }
    
    dropdown.innerHTML = html;
    
    // Position dropdown
    const rect = element.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.left = rect.left + 'px';
    
    document.body.appendChild(dropdown);
    
    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', closeBreadcrumbDropdowns, { once: true });
    }, 0);
  } catch (e) {
    console.error('Failed to load directory:', e);
  }
}

function showSymbolDropdown(event) {
  event.stopPropagation();
  closeBreadcrumbDropdowns();
  
  if (breadcrumbState.symbols.length === 0) {
    return;
  }
  
  const dropdown = document.createElement('div');
  dropdown.className = 'breadcrumb-dropdown symbol-dropdown';
  
  let html = '';
  for (const symbol of breadcrumbState.symbols) {
    html += `
      <div class="breadcrumb-dropdown-item" onclick="goToSymbol(${symbol.line})">
        <span class="symbol-icon">${symbol.icon}</span>
        <span>${symbol.name}</span>
        <span class="symbol-line">:${symbol.line}</span>
      </div>
    `;
  }
  
  dropdown.innerHTML = html || '<div class="breadcrumb-dropdown-empty">No symbols found</div>';
  
  // Position dropdown
  const rect = event.currentTarget.getBoundingClientRect();
  dropdown.style.top = (rect.bottom + 2) + 'px';
  dropdown.style.left = rect.left + 'px';
  
  document.body.appendChild(dropdown);
  
  setTimeout(() => {
    document.addEventListener('click', closeBreadcrumbDropdowns, { once: true });
  }, 0);
}

function goToSymbol(line) {
  closeBreadcrumbDropdowns();
  const editor = state.editor;
  if (editor) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }
}

function breadcrumbDropdownSelect(path, isDir) {
  closeBreadcrumbDropdowns();
  if (isDir) {
    // Could navigate to folder or expand it
  } else {
    openFile(path);
  }
}

function closeBreadcrumbDropdowns() {
  document.querySelectorAll('.breadcrumb-dropdown').forEach(el => el.remove());
}

// Update symbol on cursor position change
function setupBreadcrumbCursorTracking() {
  // Listen to cursor changes on all editors
  setInterval(() => {
    if (state.editor) {
      updateCurrentSymbol();
    }
  }, 500);
}

// Initialize cursor tracking
setupBreadcrumbCursorTracking();

// ============================================
// FIND & REPLACE
// ============================================
function setupFindReplace() {
  const findInput = document.getElementById('findInput');
  const replaceInput = document.getElementById('replaceInput');
  
  findInput.addEventListener('input', () => performFind());
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.shiftKey ? findPrevious() : findNext();
    }
    if (e.key === 'Escape') closeFindWidget();
  });
  
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFindWidget();
  });
  
  document.getElementById('findCaseSensitive').onclick = () => toggleFindOption('caseSensitive');
  document.getElementById('findWholeWord').onclick = () => toggleFindOption('wholeWord');
  document.getElementById('findRegex').onclick = () => toggleFindOption('regex');
  document.getElementById('findPrev').onclick = findPrevious;
  document.getElementById('findNext').onclick = findNext;
  document.getElementById('findClose').onclick = closeFindWidget;
  document.getElementById('replaceOne').onclick = replaceOne;
  document.getElementById('replaceAll').onclick = replaceAll;
}

function toggleFindWidget(showReplace = false) {
  const widget = document.getElementById('findWidget');
  const replaceRow = document.getElementById('replaceRow');
  const findInput = document.getElementById('findInput');
  
  if (widget.classList.contains('visible') && !showReplace) {
    closeFindWidget();
    return;
  }
  
  widget.classList.add('visible');
  replaceRow.style.display = showReplace ? 'flex' : 'none';
  
  // Pre-fill with selection
  if (state.editor) {
    const selection = state.editor.getSelection();
    const selectedText = state.editor.getModel().getValueInRange(selection);
    if (selectedText && !selectedText.includes('\n')) {
      findInput.value = selectedText;
    }
  }
  
  findInput.focus();
  findInput.select();
  performFind();
}

function closeFindWidget() {
  document.getElementById('findWidget').classList.remove('visible');
  if (state.editor) {
    state.editor.setSelection(new monaco.Selection(0, 0, 0, 0));
    state.editor.focus();
  }
}

function toggleFindOption(option) {
  state.findState[option] = !state.findState[option];
  document.getElementById(`find${option.charAt(0).toUpperCase() + option.slice(1)}`).classList.toggle('active', state.findState[option]);
  performFind();
}

function performFind() {
  if (!state.editor) return;
  
  const query = document.getElementById('findInput').value;
  if (!query) {
    document.getElementById('findCount').textContent = '0 of 0';
    return;
  }
  
  const model = state.editor.getModel();
  const matches = model.findMatches(
    query,
    true, // searchOnlyEditableRange
    state.findState.regex,
    state.findState.caseSensitive,
    state.findState.wholeWord ? query : null,
    true // captureMatches
  );
  
  state.findState.matches = matches;
  state.findState.currentMatch = 0;
  
  if (matches.length > 0) {
    // Highlight first match
    state.editor.setSelection(matches[0].range);
    state.editor.revealLineInCenter(matches[0].range.startLineNumber);
    state.findState.currentMatch = 1;
  }
  
  document.getElementById('findCount').textContent = matches.length > 0 
    ? `${state.findState.currentMatch} of ${matches.length}` 
    : 'No results';
}

function findNext() {
  if (state.findState.matches.length === 0) return;
  
  state.findState.currentMatch++;
  if (state.findState.currentMatch > state.findState.matches.length) {
    state.findState.currentMatch = 1;
  }
  
  const match = state.findState.matches[state.findState.currentMatch - 1];
  state.editor.setSelection(match.range);
  state.editor.revealLineInCenter(match.range.startLineNumber);
  
  document.getElementById('findCount').textContent = `${state.findState.currentMatch} of ${state.findState.matches.length}`;
}

function findPrevious() {
  if (state.findState.matches.length === 0) return;
  
  state.findState.currentMatch--;
  if (state.findState.currentMatch < 1) {
    state.findState.currentMatch = state.findState.matches.length;
  }
  
  const match = state.findState.matches[state.findState.currentMatch - 1];
  state.editor.setSelection(match.range);
  state.editor.revealLineInCenter(match.range.startLineNumber);
  
  document.getElementById('findCount').textContent = `${state.findState.currentMatch} of ${state.findState.matches.length}`;
}

function replaceOne() {
  if (!state.editor || state.findState.matches.length === 0) return;
  
  const replaceText = document.getElementById('replaceInput').value;
  const match = state.findState.matches[state.findState.currentMatch - 1];
  
  state.editor.executeEdits('replace', [{
    range: match.range,
    text: replaceText,
    forceMoveMarkers: true
  }]);
  
  performFind();
}

function replaceAll() {
  if (!state.editor || state.findState.matches.length === 0) return;
  
  const replaceText = document.getElementById('replaceInput').value;
  const edits = state.findState.matches.map(match => ({
    range: match.range,
    text: replaceText,
    forceMoveMarkers: true
  }));
  
  state.editor.executeEdits('replaceAll', edits);
  showNotification(`Replaced ${edits.length} occurrences`, 'success');
  performFind();
}

// ============================================
// EDITOR CONTEXT ACTIONS
// ============================================
function addEditorContextActions() {
  // Legacy - for backwards compatibility
}

function addEditorContextActionsToPane(editor) {
  editor.addAction({
    id: 'clawd-edit',
    label: '🐾 Edit with AI (⌘K)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
    contextMenuGroupId: 'clawd',
    contextMenuOrder: 0,
    run: () => showInlineEditWidget(state.activePane)
  });
  
  editor.addAction({
    id: 'clawd-explain',
    label: '🐾 Explain this code',
    contextMenuGroupId: 'clawd',
    contextMenuOrder: 1,
    run: () => explainSelectedCode()
  });
  
  editor.addAction({
    id: 'clawd-improve',
    label: '🐾 Improve this code',
    contextMenuGroupId: 'clawd',
    contextMenuOrder: 2,
    run: () => improveSelectedCode()
  });
  
  editor.addAction({
    id: 'clawd-test',
    label: '🐾 Write tests',
    contextMenuGroupId: 'clawd',
    contextMenuOrder: 3,
    run: () => writeTestsForCode()
  });
  
  editor.addAction({
    id: 'clawd-fix',
    label: '🐾 Fix this code',
    contextMenuGroupId: 'clawd',
    contextMenuOrder: 4,
    run: () => fixSelectedCode()
  });
  
  editor.addAction({
    id: 'clawd-doc',
    label: '🐾 Add documentation',
    contextMenuGroupId: 'clawd',
    contextMenuOrder: 5,
    run: () => addDocumentation()
  });
}

function initInlineCompletionsForPane(paneId) {
  const pane = state.panes[paneId];
  if (!pane || !pane.editor) return;
  
  // Inline completions are complex - skip for now in split panes
  // The main pane will handle completions
  if (paneId === 0) {
    initInlineCompletions();
  }
}

// ============================================
// AI FEATURES
// ============================================
function getSelectedCode() {
  const pane = getActivePane();
  if (!pane || !pane.editor) return '';
  const selection = pane.editor.getSelection();
  return pane.editor.getModel().getValueInRange(selection);
}

function explainSelectedCode() {
  const code = getSelectedCode();
  if (!code) {
    showNotification('Select some code first', 'error');
    return;
  }
  switchPanel('ai');
  sendAiMessageWithContext(`Explain this code in detail:\n\`\`\`\n${code}\n\`\`\``);
}

function improveSelectedCode() {
  const code = getSelectedCode();
  if (!code) {
    showNotification('Select some code first', 'error');
    return;
  }
  switchPanel('ai');
  sendAiMessageWithContext(`Improve this code - make it more efficient, readable, and follow best practices. Show me the improved version:\n\`\`\`\n${code}\n\`\`\``);
}

function writeTestsForCode() {
  const code = getSelectedCode() || (state.editor ? state.editor.getValue() : '');
  if (!code) {
    showNotification('No code to test', 'error');
    return;
  }
  switchPanel('ai');
  sendAiMessageWithContext(`Write comprehensive tests for this code:\n\`\`\`\n${code}\n\`\`\``);
}

function fixSelectedCode() {
  const code = getSelectedCode();
  if (!code) {
    showNotification('Select some code first', 'error');
    return;
  }
  switchPanel('ai');
  sendAiMessageWithContext(`Fix any bugs or issues in this code:\n\`\`\`\n${code}\n\`\`\``);
}

function addDocumentation() {
  const code = getSelectedCode();
  if (!code) {
    showNotification('Select some code first', 'error');
    return;
  }
  switchPanel('ai');
  sendAiMessageWithContext(`Add comprehensive documentation (JSDoc/docstrings) to this code:\n\`\`\`\n${code}\n\`\`\``);
}

// ============================================
// INLINE EDIT (Cmd+K) WITH DIFF PREVIEW
// ============================================
function showInlineEditWidget(paneId = state.activePane) {
  const pane = state.panes[paneId];
  if (!pane || !pane.editor) return;
  
  const selection = pane.editor.getSelection();
  const selectedCode = pane.editor.getModel().getValueInRange(selection);
  
  if (!selectedCode || selectedCode.trim().length === 0) {
    showNotification('Select some code first, then press ⌘K', 'warning');
    return;
  }
  
  // Store state
  state.inlineEdit = {
    visible: true,
    originalCode: selectedCode,
    generatedCode: '',
    selection: selection,
    paneId: paneId
  };
  
  // Position widget near selection
  const widget = document.getElementById('inlineEditWidget');
  const editorEl = document.getElementById(`paneEditor${paneId}`);
  const rect = editorEl.getBoundingClientRect();
  
  // Get cursor position in screen coordinates
  const position = pane.editor.getPosition();
  const coords = pane.editor.getScrolledVisiblePosition(position);
  
  let top = rect.top + (coords?.top || 100) + 30;
  let left = rect.left + Math.min(coords?.left || 50, rect.width - 520);
  
  // Keep on screen
  if (top + 400 > window.innerHeight) {
    top = Math.max(100, rect.top + (coords?.top || 100) - 300);
  }
  if (left < 20) left = 20;
  
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.style.display = 'block';
  
  // Update file name
  const fileName = pane.activeFile ? pane.activeFile.split('/').pop() : 'untitled';
  document.getElementById('inlineEditFile').textContent = fileName;
  
  // Reset UI
  document.getElementById('inlineEditInput').value = '';
  document.getElementById('inlineEditPreview').style.display = 'none';
  document.getElementById('inlineEditLoading').style.display = 'none';
  document.getElementById('inlineEditGenerate').style.display = 'inline-block';
  document.getElementById('inlineEditAccept').style.display = 'none';
  document.getElementById('inlineEditRegenerate').style.display = 'none';
  
  // Focus input
  setTimeout(() => {
    const input = document.getElementById('inlineEditInput');
    input.focus();
  }, 50);
}

function closeInlineEdit() {
  state.inlineEdit.visible = false;
  document.getElementById('inlineEditWidget').style.display = 'none';
}

async function generateInlineEdit() {
  const prompt = document.getElementById('inlineEditInput').value.trim();
  if (!prompt) {
    showNotification('Enter a description of what you want', 'warning');
    return;
  }
  
  const { originalCode, paneId } = state.inlineEdit;
  const pane = state.panes[paneId];
  if (!pane) return;
  
  // Show loading
  document.getElementById('inlineEditLoading').style.display = 'flex';
  document.getElementById('inlineEditGenerate').style.display = 'none';
  setAiThinking(true, 'Generating code...');
  
  try {
    const language = pane.editor.getModel().getLanguageId();
    
    const response = await fetch('/api/inline-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originalCode,
        prompt,
        language,
        filename: pane.activeFile
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      showNotification(`Error: ${data.error}`, 'error');
      document.getElementById('inlineEditLoading').style.display = 'none';
      document.getElementById('inlineEditGenerate').style.display = 'inline-block';
      setAiThinking(false);
      return;
    }
    
    state.inlineEdit.generatedCode = data.code || '';
    
    // Show diff preview
    showDiffPreview(originalCode, state.inlineEdit.generatedCode);
    
    // Update UI
    document.getElementById('inlineEditLoading').style.display = 'none';
    document.getElementById('inlineEditGenerate').style.display = 'none';
    document.getElementById('inlineEditAccept').style.display = 'inline-block';
    document.getElementById('inlineEditRegenerate').style.display = 'inline-block';
    setAiThinking(false);
    
  } catch (err) {
    console.error('Inline edit failed:', err);
    showNotification('Generation failed', 'error');
    document.getElementById('inlineEditLoading').style.display = 'none';
    document.getElementById('inlineEditGenerate').style.display = 'inline-block';
    setAiThinking(false);
  }
}

function regenerateInlineEdit() {
  // Reset and regenerate
  document.getElementById('inlineEditPreview').style.display = 'none';
  document.getElementById('inlineEditAccept').style.display = 'none';
  document.getElementById('inlineEditRegenerate').style.display = 'none';
  generateInlineEdit();
}

function showDiffPreview(original, modified) {
  const preview = document.getElementById('inlineEditPreview');
  const diffContainer = document.getElementById('inlineEditDiff');
  
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');
  
  // Simple diff algorithm
  let html = '';
  const maxLen = Math.max(originalLines.length, modifiedLines.length);
  
  // Use a simple LCS-based diff
  const diff = computeSimpleDiff(originalLines, modifiedLines);
  
  diff.forEach(item => {
    const escapedLine = escapeHtml(item.line);
    if (item.type === 'removed') {
      html += `<div class="diff-line removed">${escapedLine}</div>`;
    } else if (item.type === 'added') {
      html += `<div class="diff-line added">${escapedLine}</div>`;
    } else {
      html += `<div class="diff-line unchanged">${escapedLine}</div>`;
    }
  });
  
  diffContainer.innerHTML = html;
  preview.style.display = 'block';
}

function computeSimpleDiff(original, modified) {
  const result = [];
  let i = 0, j = 0;
  
  while (i < original.length || j < modified.length) {
    if (i >= original.length) {
      // Remaining lines are additions
      result.push({ type: 'added', line: modified[j] });
      j++;
    } else if (j >= modified.length) {
      // Remaining lines are deletions
      result.push({ type: 'removed', line: original[i] });
      i++;
    } else if (original[i] === modified[j]) {
      // Lines match
      result.push({ type: 'unchanged', line: original[i] });
      i++;
      j++;
    } else {
      // Look ahead to find matching line
      let foundInModified = modified.slice(j + 1, j + 5).indexOf(original[i]);
      let foundInOriginal = original.slice(i + 1, i + 5).indexOf(modified[j]);
      
      if (foundInModified !== -1 && (foundInOriginal === -1 || foundInModified <= foundInOriginal)) {
        // Lines were added
        for (let k = 0; k <= foundInModified; k++) {
          result.push({ type: 'added', line: modified[j + k] });
        }
        j += foundInModified + 1;
      } else if (foundInOriginal !== -1) {
        // Lines were removed
        for (let k = 0; k <= foundInOriginal; k++) {
          result.push({ type: 'removed', line: original[i + k] });
        }
        i += foundInOriginal + 1;
      } else {
        // Line was modified (show as remove + add)
        result.push({ type: 'removed', line: original[i] });
        result.push({ type: 'added', line: modified[j] });
        i++;
        j++;
      }
    }
  }
  
  return result;
}

function acceptInlineEdit() {
  const { generatedCode, selection, paneId } = state.inlineEdit;
  const pane = state.panes[paneId];
  
  if (!pane || !pane.editor || !generatedCode) return;
  
  // Replace the selected text with generated code
  pane.editor.executeEdits('inline-edit', [{
    range: selection,
    text: generatedCode,
    forceMoveMarkers: true
  }]);
  
  closeInlineEdit();
  showNotification('Code updated!', 'success');
}

// Legacy function for backwards compatibility
function showInlineEdit() {
  showInlineEditWidget(state.activePane);
}

// ============================================
// SMART CODE ACTIONS (Lightbulb) - Cmd+.
// ============================================

const codeActionsState = {
  visible: false,
  position: null,
  paneId: null,
  actions: [],
  selectedIndex: 0
};

function showCodeActionsWidget(paneId = state.activePane) {
  const pane = state.panes[paneId];
  if (!pane || !pane.editor) return;
  
  const position = pane.editor.getPosition();
  const selection = pane.editor.getSelection();
  const model = pane.editor.getModel();
  const lineContent = model.getLineContent(position.lineNumber);
  const language = model.getLanguageId();
  
  // Get selected code or current line
  const hasSelection = !selection.isEmpty();
  const selectedCode = hasSelection 
    ? model.getValueInRange(selection) 
    : lineContent;
  
  // Store state
  codeActionsState.visible = true;
  codeActionsState.position = position;
  codeActionsState.paneId = paneId;
  codeActionsState.selectedIndex = 0;
  
  // Position widget near cursor
  const widget = document.getElementById('codeActionsWidget');
  const editorEl = document.getElementById(`paneEditor${paneId}`);
  const rect = editorEl.getBoundingClientRect();
  const coords = pane.editor.getScrolledVisiblePosition(position);
  
  let top = rect.top + (coords?.top || 100) + 24;
  let left = rect.left + (coords?.left || 50);
  
  // Keep on screen
  if (top + 350 > window.innerHeight) {
    top = Math.max(50, top - 380);
  }
  if (left + 320 > window.innerWidth) {
    left = window.innerWidth - 340;
  }
  if (left < 10) left = 10;
  
  widget.style.top = `${top}px`;
  widget.style.left = `${left}px`;
  widget.style.display = 'block';
  
  // Show loading
  document.getElementById('codeActionsList').innerHTML = '';
  document.getElementById('codeActionsLoading').style.display = 'flex';
  
  // Generate actions
  generateCodeActions(selectedCode, lineContent, language, position, hasSelection, paneId);
}

async function generateCodeActions(code, lineContent, language, position, hasSelection, paneId) {
  const pane = state.panes[paneId];
  const actions = [];
  
  // === AI SUGGESTIONS (async) ===
  const aiSuggestions = await getAICodeActionSuggestions(code, language, pane.activeFile, hasSelection);
  
  // AI suggestions
  aiSuggestions.forEach(suggestion => {
    actions.push({
      icon: '🐾',
      label: suggestion.label,
      category: 'AI Suggestions',
      action: () => applyAICodeAction(suggestion, paneId)
    });
  });
  
  // === REFACTORING OPTIONS ===
  const isFunction = /function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|=>\s*{/.test(code);
  const isArrowFunction = /=>\s*[{(]?/.test(code);
  const isTraditionalFunction = /function\s+\w+/.test(code);
  const hasVariableDeclaration = /(?:const|let|var)\s+\w+/.test(code);
  
  if (isFunction || hasSelection) {
    actions.push({
      icon: '📝',
      label: 'Extract to function',
      category: 'Refactoring',
      action: () => extractToFunction(paneId)
    });
  }
  
  if (isTraditionalFunction) {
    actions.push({
      icon: '🔄',
      label: 'Convert to arrow function',
      category: 'Refactoring',
      action: () => convertToArrowFunction(paneId)
    });
  }
  
  if (isArrowFunction && !isTraditionalFunction) {
    actions.push({
      icon: '🔄',
      label: 'Convert to traditional function',
      category: 'Refactoring',
      action: () => convertToTraditionalFunction(paneId)
    });
  }
  
  if (hasVariableDeclaration) {
    actions.push({
      icon: '✏️',
      label: 'Rename symbol',
      category: 'Refactoring',
      action: () => renameSymbol(paneId)
    });
  }
  
  // === QUICK ACTIONS ===
  actions.push({
    icon: '📋',
    label: 'Copy to clipboard',
    category: 'Quick Actions',
    action: () => {
      navigator.clipboard.writeText(code);
      showNotification('Copied to clipboard', 'success');
      closeCodeActionsWidget();
    }
  });
  
  if (hasSelection) {
    actions.push({
      icon: '💬',
      label: 'Ask Clawd about this',
      category: 'Quick Actions',
      action: () => {
        closeCodeActionsWidget();
        const chatInput = document.getElementById('aiChatInput');
        if (chatInput) {
          chatInput.value = `Explain this code:\n\`\`\`${language}\n${code}\n\`\`\``;
          chatInput.focus();
        }
      }
    });
  }
  
  // Store and render
  codeActionsState.actions = actions;
  renderCodeActions(actions);
}

async function getAICodeActionSuggestions(code, language, filename, hasSelection) {
  try {
    const response = await fetch('/api/code-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language, filename, hasSelection })
    });
    
    if (!response.ok) {
      // Return smart defaults if API fails
      return getDefaultAISuggestions(code, language, hasSelection);
    }
    
    const data = await response.json();
    return data.suggestions || getDefaultAISuggestions(code, language, hasSelection);
  } catch (e) {
    console.warn('Code actions API error:', e);
    return getDefaultAISuggestions(code, language, hasSelection);
  }
}

function getDefaultAISuggestions(code, language, hasSelection) {
  const suggestions = [];
  
  // Analyze code to provide smart defaults
  const isAsync = /async|await|\.then\(|Promise/.test(code);
  const isFunction = /function|=>/.test(code);
  const hasError = /error|Error|catch|throw/.test(code);
  const hasNoComments = !/\/\/|\/\*|\*\//.test(code);
  
  if (isFunction && hasNoComments) {
    suggestions.push({
      label: 'Add documentation',
      prompt: 'Add JSDoc documentation to this code'
    });
  }
  
  if (isFunction && !hasError) {
    suggestions.push({
      label: 'Add error handling',
      prompt: 'Add proper error handling to this code'
    });
  }
  
  if (isAsync && code.includes('.then(')) {
    suggestions.push({
      label: 'Convert to async/await',
      prompt: 'Convert this Promise chain to async/await syntax'
    });
  }
  
  if (isFunction) {
    suggestions.push({
      label: 'Generate unit tests',
      prompt: 'Generate unit tests for this code'
    });
  }
  
  if (hasSelection && code.length > 50) {
    suggestions.push({
      label: 'Simplify this code',
      prompt: 'Simplify and optimize this code while preserving functionality'
    });
  }
  
  return suggestions;
}

function renderCodeActions(actions) {
  const list = document.getElementById('codeActionsList');
  document.getElementById('codeActionsLoading').style.display = 'none';
  
  if (actions.length === 0) {
    list.innerHTML = '<div class="code-actions-empty">No actions available</div>';
    return;
  }
  
  // Group by category
  const grouped = {};
  actions.forEach(action => {
    const cat = action.category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(action);
  });
  
  let html = '';
  let globalIndex = 0;
  
  for (const [category, items] of Object.entries(grouped)) {
    html += `<div class="code-actions-category">${category}</div>`;
    items.forEach(item => {
      html += `
        <div class="code-actions-item ${globalIndex === codeActionsState.selectedIndex ? 'selected' : ''}" 
             data-index="${globalIndex}"
             onclick="executeCodeAction(${globalIndex})"
             onmouseenter="selectCodeAction(${globalIndex})">
          <span class="code-actions-icon">${item.icon}</span>
          <span class="code-actions-label">${item.label}</span>
        </div>
      `;
      globalIndex++;
    });
  }
  
  list.innerHTML = html;
}

function selectCodeAction(index) {
  codeActionsState.selectedIndex = index;
  document.querySelectorAll('.code-actions-item').forEach((el, i) => {
    el.classList.toggle('selected', i === index);
  });
}

function executeCodeAction(index) {
  const action = codeActionsState.actions[index];
  if (action && action.action) {
    action.action();
  }
}

async function applyAICodeAction(suggestion, paneId) {
  closeCodeActionsWidget();
  
  const pane = state.panes[paneId];
  if (!pane) return;
  
  const selection = pane.editor.getSelection();
  const model = pane.editor.getModel();
  const code = selection.isEmpty() 
    ? model.getLineContent(pane.editor.getPosition().lineNumber)
    : model.getValueInRange(selection);
  
  // Use inline edit infrastructure
  state.inlineEdit = {
    visible: true,
    originalCode: code,
    generatedCode: '',
    selection: selection.isEmpty() 
      ? new monaco.Selection(
          pane.editor.getPosition().lineNumber, 1,
          pane.editor.getPosition().lineNumber, model.getLineContent(pane.editor.getPosition().lineNumber).length + 1
        )
      : selection,
    paneId: paneId
  };
  
  // Show loading notification
  showNotification(`🐾 ${suggestion.label}...`, 'info');
  setAiThinking(true, suggestion.label);
  
  try {
    const language = model.getLanguageId();
    
    const response = await fetch('/api/inline-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originalCode: code,
        prompt: suggestion.prompt,
        language,
        filename: pane.activeFile
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      showNotification(`Error: ${data.error}`, 'error');
      setAiThinking(false);
      return;
    }
    
    state.inlineEdit.generatedCode = data.code || '';
    
    // Show inline edit widget with diff
    const widget = document.getElementById('inlineEditWidget');
    const editorEl = document.getElementById(`paneEditor${paneId}`);
    const rect = editorEl.getBoundingClientRect();
    
    widget.style.top = `${rect.top + 100}px`;
    widget.style.left = `${rect.left + 50}px`;
    widget.style.display = 'block';
    
    document.getElementById('inlineEditInput').value = suggestion.prompt;
    showDiffPreview(code, state.inlineEdit.generatedCode);
    
    document.getElementById('inlineEditLoading').style.display = 'none';
    document.getElementById('inlineEditGenerate').style.display = 'none';
    document.getElementById('inlineEditAccept').style.display = 'inline-block';
    document.getElementById('inlineEditRegenerate').style.display = 'inline-block';
    
    setAiThinking(false);
  } catch (e) {
    showNotification(`Error: ${e.message}`, 'error');
    setAiThinking(false);
  }
}

function extractToFunction(paneId) {
  closeCodeActionsWidget();
  const name = prompt('Function name:', 'extractedFunction');
  if (!name) return;
  
  const pane = state.panes[paneId];
  const selection = pane.editor.getSelection();
  const model = pane.editor.getModel();
  const code = model.getValueInRange(selection);
  
  // Create function with extracted code
  const newFunction = `function ${name}() {\n  ${code.replace(/\n/g, '\n  ')}\n}\n\n`;
  const functionCall = `${name}();`;
  
  // Replace selection with function call
  pane.editor.executeEdits('extract-function', [{
    range: selection,
    text: functionCall
  }]);
  
  // Insert function at start of file
  pane.editor.executeEdits('extract-function', [{
    range: new monaco.Range(1, 1, 1, 1),
    text: newFunction
  }]);
  
  showNotification(`Extracted to ${name}()`, 'success');
}

function convertToArrowFunction(paneId) {
  closeCodeActionsWidget();
  
  // Use AI to convert
  applyAICodeAction({
    label: 'Convert to arrow function',
    prompt: 'Convert this traditional function to an arrow function. Keep the same functionality.'
  }, paneId);
}

function convertToTraditionalFunction(paneId) {
  closeCodeActionsWidget();
  
  applyAICodeAction({
    label: 'Convert to traditional function',
    prompt: 'Convert this arrow function to a traditional function declaration. Keep the same functionality.'
  }, paneId);
}

function renameSymbol(paneId) {
  closeCodeActionsWidget();
  
  const pane = state.panes[paneId];
  const position = pane.editor.getPosition();
  const model = pane.editor.getModel();
  const word = model.getWordAtPosition(position);
  
  if (!word) {
    showNotification('Place cursor on a symbol to rename', 'warning');
    return;
  }
  
  const newName = prompt('New name:', word.word);
  if (!newName || newName === word.word) return;
  
  // Simple find & replace in current file
  const content = model.getValue();
  const regex = new RegExp(`\\b${word.word}\\b`, 'g');
  const newContent = content.replace(regex, newName);
  
  model.setValue(newContent);
  showNotification(`Renamed "${word.word}" to "${newName}"`, 'success');
}

function closeCodeActionsWidget() {
  codeActionsState.visible = false;
  document.getElementById('codeActionsWidget').style.display = 'none';
}

// Keyboard navigation for code actions
document.addEventListener('keydown', (e) => {
  if (!codeActionsState.visible) return;
  
  if (e.key === 'Escape') {
    closeCodeActionsWidget();
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    selectCodeAction(Math.min(codeActionsState.selectedIndex + 1, codeActionsState.actions.length - 1));
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    selectCodeAction(Math.max(codeActionsState.selectedIndex - 1, 0));
    e.preventDefault();
  } else if (e.key === 'Enter') {
    executeCodeAction(codeActionsState.selectedIndex);
    e.preventDefault();
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (codeActionsState.visible) {
    const widget = document.getElementById('codeActionsWidget');
    if (!widget.contains(e.target)) {
      closeCodeActionsWidget();
    }
  }
});

// Export for window
window.showCodeActionsWidget = showCodeActionsWidget;
window.closeCodeActionsWidget = closeCodeActionsWidget;
window.executeCodeAction = executeCodeAction;
window.selectCodeAction = selectCodeAction;

function sendAiMessageWithContext(message) {
  addAiMessage('user', message);
  setAiThinking(true);
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    // Check if memory should be included
    const includeMemory = typeof isMemoryEnabled === 'function' ? isMemoryEnabled() : true;
    
    state.ws.send(JSON.stringify({
      type: 'clawd:message',
      message,
      currentFile: state.currentFile,
      selectedCode: getSelectedCode(),
      includeMemory
    }));
  }
}

// AI Chat UI
function showTypingIndicator() {
  const messages = document.getElementById('aiMessages');
  let indicator = document.getElementById('typingIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'typingIndicator';
    indicator.className = 'ai-message assistant';
    indicator.innerHTML = `
      <strong>Clawd 🐾</strong>
      <p><span class="loading-dots"><span></span><span></span><span></span></span> Thinking...</p>
    `;
    messages.appendChild(indicator);
  }
  messages.scrollTop = messages.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  if (indicator) indicator.remove();
  setAiThinking(false);
}

function appendToStreamingMessage(delta) {
  if (!state.currentStreamingMessage) {
    hideTypingIndicator();
    state.currentStreamingMessage = document.createElement('div');
    state.currentStreamingMessage.className = 'ai-message assistant';
    state.currentStreamingMessage.innerHTML = '<strong>Clawd 🐾</strong><div class="message-content streaming-content"></div>';
    document.getElementById('aiMessages').appendChild(state.currentStreamingMessage);
  }
  
  const content = state.currentStreamingMessage.querySelector('.streaming-content');
  content.textContent += delta;
  
  const messages = document.getElementById('aiMessages');
  messages.scrollTop = messages.scrollHeight;
}

function finalizeStreamingMessage(fullContent) {
  if (state.currentStreamingMessage) {
    const content = state.currentStreamingMessage.querySelector('.streaming-content');
    content.innerHTML = formatAiResponse(fullContent);
    addCodeBlockActions(state.currentStreamingMessage);
    state.currentStreamingMessage = null;
  }
  setAiThinking(false);
}

function addAiMessage(role, content) {
  hideTypingIndicator();
  state.currentStreamingMessage = null;
  
  const messages = document.getElementById('aiMessages');
  const div = document.createElement('div');
  div.className = `ai-message ${role}`;
  
  const formatted = role === 'assistant' ? formatAiResponse(content) : escapeHtml(content);
  
  div.innerHTML = `
    <strong>${role === 'user' ? 'You' : 'Clawd 🐾'}</strong>
    <div class="message-content">${formatted}</div>
  `;
  
  if (role === 'assistant') {
    addCodeBlockActions(div);
  }
  
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  
  if (role === 'assistant') setAiThinking(false);
}

function addCodeBlockActions(container) {
  container.querySelectorAll('pre.code-block').forEach(pre => {
    const actions = document.createElement('div');
    actions.className = 'code-block-actions';
    actions.innerHTML = `
      <button class="code-action" onclick="copyCodeBlock(this)" title="Copy">📋</button>
      <button class="code-action" onclick="insertCodeAtCursor(this)" title="Insert at cursor">↳</button>
      <button class="code-action" onclick="replaceSelection(this)" title="Replace selection">⎘</button>
    `;
    pre.appendChild(actions);
  });
}

function copyCodeBlock(btn) {
  const code = btn.closest('pre').querySelector('code')?.textContent || btn.closest('pre').textContent;
  navigator.clipboard.writeText(code.replace(/📋↳⎘$/, '').trim());
  showNotification('Copied!', 'success');
}

function insertCodeAtCursor(btn) {
  const code = btn.closest('pre').querySelector('code')?.textContent || btn.closest('pre').textContent;
  const cleanCode = code.replace(/📋↳⎘$/, '').trim();
  
  if (state.editor) {
    const position = state.editor.getPosition();
    state.editor.executeEdits('insert', [{
      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
      text: cleanCode,
      forceMoveMarkers: true
    }]);
    showNotification('Inserted!', 'success');
  }
}

function replaceSelection(btn) {
  const code = btn.closest('pre').querySelector('code')?.textContent || btn.closest('pre').textContent;
  const cleanCode = code.replace(/📋↳⎘$/, '').trim();
  
  if (state.editor) {
    const selection = state.editor.getSelection();
    state.editor.executeEdits('replace', [{
      range: selection,
      text: cleanCode,
      forceMoveMarkers: true
    }]);
    showNotification('Replaced!', 'success');
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatAiResponse(content) {
  // Code blocks
  content = content.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre class="code-block" data-lang="${lang || ''}"><code>${escapeHtml(code.trim())}</code></pre>`;
  });
  
  // Inline code
  content = content.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Bold
  content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  content = content.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Line breaks
  content = content.replace(/\n/g, '<br>');
  
  return content;
}

// ============================================
// SLASH COMMANDS
// ============================================
const slashCommands = {
  '/help': {
    description: 'Show available commands',
    handler: () => {
      const helpText = `**🐾 Clawd IDE Commands**

**IDE Commands (local):**
• \`/help\` - Show this help
• \`/clear\` - Clear chat history
• \`/status\` - Show IDE status

**Code Commands (select code first):**
• \`⌘K\` - Inline AI edit
• \`/explain\` - Explain selected code
• \`/improve\` - Improve selected code
• \`/tests\` - Write tests for selected code
• \`/fix\` - Fix issues in selected code
• \`/docs\` - Add documentation

**DNA Commands (sent to gateway):**
• \`/compact\` - Compact context
• \`/reasoning\` - Toggle reasoning mode
• \`/model\` - Change model
• Other \`/\` commands passed to DNA

**Keyboard Shortcuts:**
• \`⌘P\` - Quick open / command palette
• \`⌘S\` - Save file
• \`⌘F\` - Find
• \`⌘H\` - Find and replace
• \`⌘\\\` - Split editor
• \`⌘\`\` - Toggle terminal
• \`⌘1-4\` - Switch panes`;
      addAiMessage('assistant', helpText);
    }
  },
  '/new': {
    description: 'Start new session',
    handler: async () => {
      try {
        setAiThinking(true, 'Resetting session...');
        const res = await fetch('/api/session/reset', { method: 'POST' });
        const data = await res.json();
        setAiThinking(false);
        
        if (data.ok) {
          addAiMessage('assistant', '✨ **Session reset!** Context cleared, starting fresh.');
          fetchContextUsage();
        } else {
          addAiMessage('assistant', `❌ Failed to reset session: ${data.error}`);
        }
      } catch (err) {
        setAiThinking(false);
        addAiMessage('assistant', `❌ Error resetting session: ${err.message}`);
      }
    }
  },
  '/clear': {
    description: 'Clear chat history',
    handler: () => {
      const messages = document.getElementById('aiMessages');
      messages.innerHTML = `
        <div class="ai-message assistant">
          <strong>Clawd 🐾</strong>
          <p>Chat cleared! Ready for new questions.</p>
        </div>
      `;
      showNotification('Chat cleared', 'success');
    }
  },
  '/status': {
    description: 'Show session status',
    handler: async () => {
      const statusText = `**🐾 IDE Status**

• **Gateway:** ${state.gatewayConnected ? '✅ Connected' : '❌ Offline'}
• **Context:** ${contextState.percentage}% (${Math.round(contextState.used/1000)}k / ${Math.round(contextState.max/1000)}k tokens)
• **Tier:** ${contextState.tier.charAt(0).toUpperCase() + contextState.tier.slice(1)}
• **Git Branch:** ${state.git.branch}
• **Open Files:** ${state.panes.reduce((sum, p) => sum + p.files.size, 0)}
• **Active Pane:** ${state.activePane + 1} of ${state.panes.length}
• **Workspace:** ${state.workspace}`;
      addAiMessage('assistant', statusText);
    }
  },
  '/explain': {
    description: 'Explain selected code',
    handler: () => explainSelectedCode()
  },
  '/improve': {
    description: 'Improve selected code',
    handler: () => improveSelectedCode()
  },
  '/tests': {
    description: 'Write tests for selected code',
    handler: () => writeTestsForCode()
  },
  '/fix': {
    description: 'Fix selected code',
    handler: () => fixSelectedCode()
  },
  '/docs': {
    description: 'Add documentation to selected code',
    handler: () => addDocumentation()
  }
};

function handleSlashCommand(message) {
  const parts = message.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  
  // IDE-specific commands handled locally
  if (slashCommands[command]) {
    slashCommands[command].handler();
    return true;
  }
  
  // Pass through other slash commands to gateway (like /new, /compact, /reasoning, etc.)
  return false;
}

// @ Mention Context State
const mentionContext = {
  items: [], // { type: 'file'|'folder'|'codebase'|'selection'|'git'|'terminal', path?: string, content?: string }
  autocompleteVisible: false,
  autocompleteIndex: 0
};

function sendAiMessage() {
  const input = document.getElementById('aiInput');
  const message = input.value.trim();
  if (!message) return;
  
  // Check for slash commands
  if (message.startsWith('/')) {
    addAiMessage('user', message);
    input.value = '';
    const handled = handleSlashCommand(message);
    if (handled) return;
    // If not handled locally, send to gateway (user message already added above)
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'clawd:message',
        message,
        currentFile: state.currentFile,
        selectedCode: getSelectedCode()
      }));
    }
    return;
  }
  
  // Parse @ mentions from message
  const { cleanMessage, contextItems } = parseAtMentions(message);
  
  // Add current context items from pills
  const allContext = [...mentionContext.items, ...contextItems];
  
  // Build context object for server
  const context = buildContextForMessage(allContext);
  
  // Show what context was included (user message with pills)
  addAiMessageWithContext('user', cleanMessage, allContext);
  input.value = '';
  
  // Clear context pills after sending
  mentionContext.items = [];
  updateContextPills();
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'clawd:message',
      message: cleanMessage,
      currentFile: state.currentFile,
      selectedCode: getSelectedCode(),
      context // Include parsed context
    }));
  }
}

// Parse @ mentions from message
function parseAtMentions(message) {
  const contextItems = [];
  let cleanMessage = message;
  
  // @file:path/to/file.js or @file path/to/file.js
  const filePattern = /@file[:\s]+([^\s@]+)/g;
  let match;
  while ((match = filePattern.exec(message)) !== null) {
    contextItems.push({ type: 'file', path: match[1] });
    cleanMessage = cleanMessage.replace(match[0], '').trim();
  }
  
  // @folder:path/to/folder or @folder path/to/folder
  const folderPattern = /@folder[:\s]+([^\s@]+)/g;
  while ((match = folderPattern.exec(message)) !== null) {
    contextItems.push({ type: 'folder', path: match[1] });
    cleanMessage = cleanMessage.replace(match[0], '').trim();
  }
  
  // @codebase - include project structure
  if (message.includes('@codebase')) {
    contextItems.push({ type: 'codebase' });
    cleanMessage = cleanMessage.replace(/@codebase/g, '').trim();
  }
  
  // @selection - include current selection
  if (message.includes('@selection')) {
    const selectedCode = getSelectedCode();
    if (selectedCode) {
      contextItems.push({ type: 'selection', content: selectedCode });
    }
    cleanMessage = cleanMessage.replace(/@selection/g, '').trim();
  }
  
  // @git - include git status
  if (message.includes('@git')) {
    contextItems.push({ type: 'git' });
    cleanMessage = cleanMessage.replace(/@git/g, '').trim();
  }
  
  // @terminal - include recent terminal output
  if (message.includes('@terminal')) {
    contextItems.push({ type: 'terminal' });
    cleanMessage = cleanMessage.replace(/@terminal/g, '').trim();
  }
  
  return { cleanMessage, contextItems };
}

// Build context content for server
function buildContextForMessage(contextItems) {
  const context = {
    files: [],
    folders: [],
    selection: null,
    codebase: false,
    git: false,
    terminal: false
  };
  
  for (const item of contextItems) {
    switch (item.type) {
      case 'file':
        context.files.push(item.path);
        break;
      case 'folder':
        context.folders.push(item.path);
        break;
      case 'selection':
        context.selection = item.content;
        break;
      case 'codebase':
        context.codebase = true;
        break;
      case 'git':
        context.git = true;
        break;
      case 'terminal':
        context.terminal = true;
        break;
    }
  }
  
  return context;
}

// Add message with context pills shown
function addAiMessageWithContext(role, content, contextItems) {
  const messages = document.getElementById('aiMessages');
  const div = document.createElement('div');
  div.className = `ai-message ${role}`;
  
  let contextHtml = '';
  if (contextItems && contextItems.length > 0) {
    contextHtml = `<div class="message-context-pills">${contextItems.map(item => {
      let icon = '📄';
      let label = item.path || item.type;
      switch (item.type) {
        case 'file': icon = '📄'; label = item.path; break;
        case 'folder': icon = '📁'; label = item.path; break;
        case 'codebase': icon = '🗂'; label = 'codebase'; break;
        case 'selection': icon = '✂'; label = 'selection'; break;
        case 'git': icon = '⎇'; label = 'git status'; break;
        case 'terminal': icon = '⌨'; label = 'terminal'; break;
      }
      return `<span class="context-pill">${icon} ${label}</span>`;
    }).join('')}</div>`;
  }
  
  div.innerHTML = `
    <strong>${role === 'user' ? 'You' : 'Clawd 🐾'}</strong>
    ${contextHtml}
    <div class="message-content">${formatAiResponse(content)}</div>
  `;
  
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// Add context pill to current context
function addContextPill(type, path) {
  // Check if already added
  const exists = mentionContext.items.some(i => i.type === type && i.path === path);
  if (exists) return;
  
  mentionContext.items.push({ type, path });
  updateContextPills();
}

// Remove context pill
function removeContextPill(index) {
  mentionContext.items.splice(index, 1);
  updateContextPills();
}

// Update context pills UI
function updateContextPills() {
  const container = document.getElementById('aiContextPills');
  if (!container) return;
  
  if (mentionContext.items.length === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }
  
  container.classList.remove('hidden');
  container.innerHTML = mentionContext.items.map((item, i) => {
    let icon = '📄';
    let label = item.path || item.type;
    switch (item.type) {
      case 'file': icon = '📄'; break;
      case 'folder': icon = '📁'; break;
      case 'codebase': icon = '🗂'; label = 'codebase'; break;
      case 'selection': icon = '✂'; label = 'selection'; break;
      case 'git': icon = '⎇'; label = 'git status'; break;
      case 'terminal': icon = '⌨'; label = 'terminal'; break;
    }
    return `<span class="context-pill" onclick="removeContextPill(${i})">${icon} ${label} <span class="pill-remove">×</span></span>`;
  }).join('');
}

// Show @ autocomplete menu
function showAtAutocomplete(input) {
  const cursorPos = input.selectionStart;
  const textBefore = input.value.substring(0, cursorPos);
  const atMatch = textBefore.match(/@(\w*)$/);
  
  if (!atMatch) {
    hideAtAutocomplete();
    return;
  }
  
  const query = atMatch[1].toLowerCase();
  const suggestions = [
    { type: 'file', label: '@file', desc: 'Include a specific file' },
    { type: 'folder', label: '@folder', desc: 'Include folder contents' },
    { type: 'codebase', label: '@codebase', desc: 'Include project overview' },
    { type: 'selection', label: '@selection', desc: 'Include current selection' },
    { type: 'git', label: '@git', desc: 'Include git status' },
    { type: 'terminal', label: '@terminal', desc: 'Include terminal output' }
  ].filter(s => s.label.toLowerCase().includes('@' + query));
  
  if (suggestions.length === 0) {
    hideAtAutocomplete();
    return;
  }
  
  const menu = document.getElementById('atAutocomplete');
  if (!menu) return;
  
  menu.innerHTML = suggestions.map((s, i) => `
    <div class="at-autocomplete-item ${i === mentionContext.autocompleteIndex ? 'selected' : ''}" 
         data-type="${s.type}" 
         onclick="selectAtAutocomplete('${s.type}')">
      <span class="at-label">${s.label}</span>
      <span class="at-desc">${s.desc}</span>
    </div>
  `).join('');
  
  menu.classList.remove('hidden');
  mentionContext.autocompleteVisible = true;
}

function hideAtAutocomplete() {
  const menu = document.getElementById('atAutocomplete');
  if (menu) menu.classList.add('hidden');
  mentionContext.autocompleteVisible = false;
  mentionContext.autocompleteIndex = 0;
}

function selectAtAutocomplete(type) {
  const input = document.getElementById('aiInput');
  const cursorPos = input.selectionStart;
  const textBefore = input.value.substring(0, cursorPos);
  const textAfter = input.value.substring(cursorPos);
  const atMatch = textBefore.match(/@\w*$/);
  
  if (atMatch) {
    const newText = textBefore.substring(0, atMatch.index) + '@' + type + ' ' + textAfter;
    input.value = newText;
    input.selectionStart = input.selectionEnd = atMatch.index + type.length + 2;
  }
  
  hideAtAutocomplete();
  input.focus();
}

function handleAiInput(event) {
  // Handle @ autocomplete navigation
  if (mentionContext.autocompleteVisible) {
    const menu = document.getElementById('atAutocomplete');
    const items = menu?.querySelectorAll('.at-autocomplete-item') || [];
    
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionContext.autocompleteIndex = Math.min(mentionContext.autocompleteIndex + 1, items.length - 1);
      updateAutocompleteSelection(items);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionContext.autocompleteIndex = Math.max(mentionContext.autocompleteIndex - 1, 0);
      updateAutocompleteSelection(items);
      return;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      const selected = items[mentionContext.autocompleteIndex];
      if (selected) {
        selectAtAutocomplete(selected.dataset.type);
      }
      return;
    }
    if (event.key === 'Escape') {
      hideAtAutocomplete();
      return;
    }
  }
  
  // Send message on Enter
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendAiMessage();
  }
}

function updateAutocompleteSelection(items) {
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === mentionContext.autocompleteIndex);
  });
}

// ============================================
// TERMINAL - See modules/terminal.js
// ============================================

// ============================================
// GIT - See modules/git.js
// ============================================

// ============================================
// SIDEBAR
// ============================================
function switchPanel(panel) {
  document.querySelectorAll('.activity-item').forEach(item => {
    item.classList.toggle('active', item.dataset.panel === panel);
  });
  
  document.querySelectorAll('.sidebar-panel').forEach(p => {
    p.classList.toggle('hidden', p.id !== `panel-${panel}`);
  });
  
  if (panel === 'git') loadGitStatus();
  if (panel === 'debug' && typeof renderBreakpointsPanel === 'function') {
    renderBreakpointsPanel();
  }
}

// Toggle debug section (Variables, Call Stack)
function toggleDebugSection(header) {
  const content = header.nextElementSibling;
  const arrow = header.querySelector('span');
  
  if (content.classList.contains('hidden')) {
    content.classList.remove('hidden');
    if (arrow) arrow.textContent = arrow.textContent.replace('▶', '▼');
  } else {
    content.classList.add('hidden');
    if (arrow) arrow.textContent = arrow.textContent.replace('▼', '▶');
  }
}
window.toggleDebugSection = toggleDebugSection;

// ============================================
// SEARCH
// ============================================
const searchState = {
  mode: 'content', // 'files' or 'content'
  debounceTimer: null
};

async function handleSearch(event) {
  const query = event.target.value.trim();
  if (query.length < 2) {
    document.getElementById('searchResults').innerHTML = '';
    return;
  }
  
  // Debounce content search (more expensive)
  clearTimeout(searchState.debounceTimer);
  searchState.debounceTimer = setTimeout(() => performSearch(query), 300);
}

async function performSearch(query) {
  const resultsEl = document.getElementById('searchResults');
  resultsEl.innerHTML = '<p style="padding: 10px; color: #888;">Searching...</p>';
  
  // Check if semantic search is enabled
  const semanticToggle = document.getElementById('semanticSearchToggle');
  const useSemanticSearch = semanticToggle?.checked;
  
  try {
    // Build promises array
    const promises = [
      fetch(`/api/search?query=${encodeURIComponent(query)}&path=${encodeURIComponent(state.workspace)}`),
      fetch(`/api/search/content?query=${encodeURIComponent(query)}&path=${encodeURIComponent(state.workspace)}`)
    ];
    
    // Add semantic search if enabled
    if (useSemanticSearch) {
      promises.push(fetch(`/api/search/semantic?query=${encodeURIComponent(query)}&limit=10`));
    }
    
    const responses = await Promise.all(promises);
    const filesData = await responses[0].json();
    const contentData = await responses[1].json();
    const semanticData = useSemanticSearch ? await responses[2].json() : null;
    
    let html = '';
    
    // File name matches
    if (filesData.results?.length > 0) {
      html += '<div class="search-section"><div class="search-section-header">Files</div>';
      html += filesData.results.slice(0, 10).map(r => {
        const iconClass = getFileIconClass(r.name, r.type === 'directory');
        const iconSvg = getFileIconSvg(r.name, r.type === 'directory');
        return `
          <div class="search-result-item" onclick="openFile('${r.path.replace(/'/g, "\\'")}')">
            <span class="file-icon ${iconClass}">${iconSvg}</span>
            <span class="search-result-name">${highlightMatch(r.name, query)}</span>
          </div>
        `;
      }).join('');
      html += '</div>';
    }
    
    // Content matches (grouped by file)
    if (contentData.results?.length > 0) {
      // Group by file
      const byFile = {};
      for (const r of contentData.results) {
        if (!byFile[r.file]) byFile[r.file] = [];
        byFile[r.file].push(r);
      }
      
      html += '<div class="search-section"><div class="search-section-header">Content Matches</div>';
      
      for (const [filePath, matches] of Object.entries(byFile)) {
        const fileName = filePath.split('/').pop();
        const iconClass = getFileIconClass(fileName);
        const iconSvg = getFileIconSvg(fileName);
        const relativePath = filePath.replace(state.workspace + '/', '');
        
        html += `
          <div class="search-file-group">
            <div class="search-file-header" onclick="toggleSearchFileGroup(this)">
              <span class="file-icon ${iconClass}">${iconSvg}</span>
              <span class="search-file-name">${relativePath}</span>
              <span class="search-match-count">${matches.length}</span>
            </div>
            <div class="search-file-matches">
        `;
        
        for (const match of matches.slice(0, 5)) {
          const escapedPath = filePath.replace(/'/g, "\\'");
          html += `
            <div class="search-match-item" onclick="openFileAtLine('${escapedPath}', ${match.line})">
              <span class="search-line-num">${match.line}</span>
              <span class="search-line-text">${highlightMatch(escapeHtml(match.text), query)}</span>
            </div>
          `;
        }
        
        if (matches.length > 5) {
          html += `<div class="search-more">+${matches.length - 5} more matches</div>`;
        }
        
        html += '</div></div>';
      }
      html += '</div>';
    }
    
    // Semantic search results
    if (semanticData?.results?.length > 0) {
      html += '<div class="search-section"><div class="search-section-header">🧠 Semantic Matches</div>';
      
      for (const r of semanticData.results) {
        const fileName = r.file.split('/').pop();
        const iconClass = getFileIconClass(fileName);
        const iconSvg = getFileIconSvg(fileName);
        const score = Math.round(r.score * 100);
        const escapedPath = r.file.replace(/'/g, "\\'");
        
        // Truncate content preview
        const preview = r.content.length > 150 
          ? r.content.substring(0, 150) + '...' 
          : r.content;
        
        html += `
          <div class="search-semantic-result" onclick="openFileAtLine('${escapedPath}', ${r.startLine})">
            <div class="search-semantic-header">
              <span class="file-icon ${iconClass}">${iconSvg}</span>
              <span class="search-file-name">${r.file}</span>
              <span class="search-semantic-score">${score}%</span>
            </div>
            <div class="search-semantic-preview">${escapeHtml(preview)}</div>
            <div class="search-semantic-lines">Lines ${r.startLine}-${r.endLine}</div>
          </div>
        `;
      }
      html += '</div>';
    } else if (useSemanticSearch && semanticData?.error) {
      html += `<div class="search-section">
        <div class="search-section-header">🧠 Semantic Search</div>
        <p style="padding: 10px; color: var(--warning);">${escapeHtml(semanticData.error)}</p>
      </div>`;
    }
    
    resultsEl.innerHTML = html || '<p style="padding: 10px; color: #888;">No results</p>';
  } catch (err) {
    console.error('Search failed:', err);
    resultsEl.innerHTML = '<p style="padding: 10px; color: var(--error);">Search failed</p>';
  }
}

function highlightMatch(text, query) {
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toggleSearchFileGroup(el) {
  const matches = el.nextElementSibling;
  matches.classList.toggle('collapsed');
  el.classList.toggle('collapsed');
}

// Rebuild search index
async function rebuildIndex() {
  const btn = document.querySelector('.search-index-btn');
  if (btn) {
    btn.innerHTML = '<span class="spinning">⟳</span>';
    btn.disabled = true;
  }
  
  try {
    const res = await fetch('/api/index/rebuild', { method: 'POST' });
    const data = await res.json();
    
    if (data.error) {
      showNotification(`Index rebuild failed: ${data.error}`, 'error');
    } else {
      showNotification(`Indexed ${data.indexed} files in ${data.duration}`, 'success');
    }
  } catch (err) {
    showNotification('Index rebuild failed: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.innerHTML = '<span>⟳</span>';
      btn.disabled = false;
    }
  }
}
window.rebuildIndex = rebuildIndex;

// Open global search panel (Cmd+Shift+F)
function openGlobalSearch() {
  switchPanel('search');
  const input = document.getElementById('searchInput');
  if (input) {
    input.focus();
    input.select();
  }
}
window.openGlobalSearch = openGlobalSearch;

async function openFileAtLine(path, line) {
  await openFile(path, false);
  // Wait for editor to load, then go to line
  setTimeout(() => {
    const editor = state.editor;
    if (editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    }
  }, 100);
}

// ============================================
// COMMAND PALETTE
// ============================================
function toggleCommandPalette() {
  const palette = document.getElementById('commandPalette');
  const overlay = document.getElementById('overlay');
  const isHidden = palette.classList.contains('hidden');
  
  palette.classList.toggle('hidden', !isHidden);
  overlay.classList.toggle('hidden', !isHidden);
  
  if (isHidden) {
    const input = document.getElementById('commandInput');
    input.value = '';
    input.focus();
    updateCommandResults('');
  }
}

function closeCommandPalette() {
  document.getElementById('commandPalette').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
}

function handleCommandInput(event) {
  if (event.key === 'Escape') {
    closeCommandPalette();
    return;
  }
  if (event.key === 'Enter') {
    const selected = document.querySelector('.command-item.selected');
    if (selected) selected.click();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    navigateCommandResults(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  updateCommandResults(event.target.value);
}

function navigateCommandResults(direction) {
  const items = document.querySelectorAll('.command-item');
  let selected = document.querySelector('.command-item.selected');
  let index = Array.from(items).indexOf(selected);
  
  items[index]?.classList.remove('selected');
  index = (index + direction + items.length) % items.length;
  items[index]?.classList.add('selected');
}

function updateCommandResults(query) {
  query = query.toLowerCase();
  
  const commands = [
    { name: '🐾 Ask Clawd...', action: "switchPanel('ai'); document.getElementById('aiInput').focus()" },
    { name: '🐾 Inline Edit (Cmd+K)', action: 'showInlineEdit()' },
    { name: '🐾 Toggle Inline Completions', action: 'toggleInlineCompletions()' },
    { name: '🐾 Explain selected code', action: 'explainSelectedCode()' },
    { name: '🐾 Improve selected code', action: 'improveSelectedCode()' },
    { name: '🐾 Write tests', action: 'writeTestsForCode()' },
    { name: '🐾 Fix code', action: 'fixSelectedCode()' },
    { name: '🐾 Add documentation', action: 'addDocumentation()' },
    { name: 'Save File', shortcut: '⌘S', action: 'saveCurrentFile()' },
    { name: 'Find', shortcut: '⌘F', action: 'toggleFindWidget(false)' },
    { name: 'Find and Replace', shortcut: '⌘H', action: 'toggleFindWidget(true)' },
    { name: 'Toggle Terminal', shortcut: '⌘`', action: 'toggleTerminal()' },
    { name: 'New File', shortcut: '⌘N', action: 'createNewFile()' },
    { name: 'Close Tab', shortcut: '⌘W', action: 'state.currentFile && closeTab(state.currentFile)' },
    { name: 'Refresh Files', action: 'loadFileTree(state.workspace)' },
    { name: 'Git: Refresh Status', action: 'loadGitStatus()' },
    { name: 'View: Explorer', action: "switchPanel('explorer')" },
    { name: 'View: Search', action: "switchPanel('search')" },
    { name: 'View: Git', action: "switchPanel('git')" },
    { name: 'View: AI Chat', action: "switchPanel('ai')" },
  ];
  
  const filtered = commands.filter(c => c.name.toLowerCase().includes(query));
  
  const resultsHtml = filtered.map((c, i) => `
    <div class="command-item ${i === 0 ? 'selected' : ''}" onclick="${c.action}; closeCommandPalette();">
      <span class="name">${c.name}</span>
      ${c.shortcut ? `<kbd>${c.shortcut}</kbd>` : ''}
    </div>
  `).join('');
  
  document.getElementById('commandResults').innerHTML = resultsHtml || '<p style="padding: 15px; color: #888;">No commands found</p>';
}

// ============================================
// CONTEXT MENU
// ============================================
function showContextMenu(event, item) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.cssText = `
    position: fixed;
    left: ${event.clientX}px;
    top: ${event.clientY}px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    z-index: 10000;
    min-width: 180px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  
  const actions = [
    { label: 'Open', action: () => openFile(item.path) },
    { label: 'Copy Path', action: () => navigator.clipboard.writeText(item.path) },
    { label: '---' },
    { label: 'Delete', action: () => deleteItem(item.path), danger: true },
  ];
  
  actions.forEach(action => {
    if (action.label === '---') {
      const sep = document.createElement('div');
      sep.style.cssText = 'height: 1px; background: var(--border); margin: 4px 0;';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('div');
      btn.textContent = action.label;
      btn.style.cssText = `
        padding: 6px 12px;
        cursor: pointer;
        font-size: 12px;
        color: ${action.danger ? '#f44747' : 'var(--text-primary)'};
      `;
      btn.onmouseover = () => btn.style.background = 'var(--bg-hover)';
      btn.onmouseout = () => btn.style.background = '';
      btn.onclick = () => { action.action(); menu.remove(); };
      menu.appendChild(btn);
    }
  });
  
  document.body.appendChild(menu);
  
  setTimeout(() => {
    document.addEventListener('click', function handler() {
      menu.remove();
      document.removeEventListener('click', handler);
    });
  }, 100);
}

async function deleteItem(path) {
  if (!confirm(`Delete ${path.split('/').pop()}?`)) return;
  
  try {
    await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    loadFileTree(state.workspace);
    showNotification('Deleted', 'success');
  } catch (err) {
    showNotification('Delete failed', 'error');
  }
}

// ============================================
// FILE CREATION
// ============================================
async function createNewFile() {
  const name = prompt('Enter file name:');
  if (!name) return;
  
  const path = `${state.workspace}/${name}`;
  try {
    await fetch('/api/file/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, type: 'file' })
    });
    await loadFileTree(state.workspace);
    openFile(path);
    showNotification(`Created ${name}`, 'success');
  } catch (err) {
    showNotification('Failed to create file', 'error');
  }
}

async function createNewFolder() {
  const name = prompt('Enter folder name:');
  if (!name) return;
  
  const path = `${state.workspace}/${name}`;
  try {
    await fetch('/api/file/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, type: 'directory' })
    });
    await loadFileTree(state.workspace);
    showNotification(`Created folder ${name}`, 'success');
  } catch (err) {
    showNotification('Failed to create folder', 'error');
  }
}

function refreshFiles() {
  loadFileTree(state.workspace);
  showNotification('Files refreshed', 'info');
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd+K - AI Edit or Command Palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (state.editor && state.editor.hasTextFocus()) {
        showInlineEditWidget(state.activePane);
      } else {
        toggleCommandPalette();
      }
    }
    
    // Cmd+P - Quick Open
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault();
      toggleCommandPalette();
    }
    
    // Cmd+` - Toggle Terminal
    if ((e.metaKey || e.ctrlKey) && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
    }
    
    // Cmd+Shift+D - Open Debug Panel
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'd') {
      e.preventDefault();
      switchPanel('debug');
    }
    
    // Ctrl+Shift+5 - Split Terminal Horizontally
    if (e.ctrlKey && e.shiftKey && e.key === '5') {
      e.preventDefault();
      if (typeof splitTerminal === 'function') {
        splitTerminal('horizontal');
      }
    }
    
    // Ctrl+Shift+\ - Split Terminal Vertically  
    if (e.ctrlKey && e.shiftKey && e.key === '\\') {
      e.preventDefault();
      if (typeof splitTerminal === 'function') {
        splitTerminal('vertical');
      }
    }
    
    // Cmd+\ - Split horizontally
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      if (e.shiftKey) {
        splitPane('vertical');
      } else {
        splitPane('horizontal');
      }
    }
    
    // Cmd+W - Close Tab in active pane
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
      e.preventDefault();
      const pane = getActivePane();
      if (pane && pane.activeFile) {
        closeFileInPane(pane.activeFile, pane.id);
      }
    }
    
    // Cmd+B - Toggle Sidebar
    if ((e.metaKey || e.ctrlKey) && e.key === 'b' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('sidebar').classList.toggle('hidden');
    }
    
    // Cmd+Shift+B - Open Browser Panel
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'b') {
      e.preventDefault();
      openBrowserInPane();
    }
    
    // Cmd+Shift+F - Global Search
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
      e.preventDefault();
      openGlobalSearch();
    }
    
    // Cmd+Shift+G - Agent Mode
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'g') {
      e.preventDefault();
      switchPanel('agent');
    }
    
    // Cmd+1/2/3/4 - Switch panes
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '4') {
      const paneIndex = parseInt(e.key) - 1;
      if (state.panes[paneIndex]) {
        e.preventDefault();
        setActivePane(paneIndex);
        state.panes[paneIndex].editor?.focus();
      }
    }
    
    // Cmd+M - Memory Panel
    if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
      e.preventDefault();
      if (typeof toggleMemoryPanel === 'function') toggleMemoryPanel();
    }
    
    // Cmd+J - Toggle Terminal
    if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
      e.preventDefault();
      if (typeof toggleTerminal === 'function') toggleTerminal();
    }
    
    // Cmd+Shift+N - New Terminal
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'n') {
      e.preventDefault();
      if (typeof createTerminal === 'function') createTerminal();
    }
    
    // Cmd+, - Settings
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    
    // Cmd+? or Cmd+/ - Keyboard shortcuts cheatsheet
    if ((e.metaKey || e.ctrlKey) && (e.key === '?' || e.key === '/')) {
      e.preventDefault();
      showKeyboardShortcuts();
    }
    
    // Escape - Close dialogs
    if (e.key === 'Escape') {
      closeAllModals();
      closeFindWidget();
      closeKeyboardShortcuts();
      // Also close memory panel if open
      const memoryPanel = document.getElementById('memoryPanel');
      if (memoryPanel?.classList.contains('visible')) {
        toggleMemoryPanel();
      }
    }
  });
}

// ============================================
// KEYBOARD SHORTCUTS CHEATSHEET
// ============================================
const keyboardShortcuts = [
  { category: 'General', shortcuts: [
    { keys: 'Cmd+K', desc: 'Inline AI Edit / Command Palette' },
    { keys: 'Cmd+P', desc: 'Quick Open File' },
    { keys: 'Cmd+,', desc: 'Settings' },
    { keys: 'Cmd+?', desc: 'Keyboard Shortcuts' },
  ]},
  { category: 'Editor', shortcuts: [
    { keys: 'Cmd+S', desc: 'Save File' },
    { keys: 'Cmd+W', desc: 'Close Tab' },
    { keys: 'Cmd+\\', desc: 'Split Pane Horizontal' },
    { keys: 'Cmd+Shift+\\', desc: 'Split Pane Vertical' },
    { keys: 'Cmd+1/2/3/4', desc: 'Focus Pane' },
  ]},
  { category: 'Navigation', shortcuts: [
    { keys: 'Cmd+B', desc: 'Toggle Sidebar' },
    { keys: 'Cmd+J', desc: 'Toggle Terminal' },
    { keys: 'Cmd+`', desc: 'Toggle Terminal (alt)' },
    { keys: 'Cmd+Shift+E', desc: 'Explorer' },
    { keys: 'Cmd+Shift+F', desc: 'Search' },
    { keys: 'Cmd+Shift+G', desc: 'Agent Mode' },
  ]},
  { category: 'Terminal', shortcuts: [
    { keys: 'Cmd+Shift+N', desc: 'New Terminal' },
    { keys: 'Cmd+J', desc: 'Toggle Terminal' },
  ]},
  { category: 'AI & Memory', shortcuts: [
    { keys: 'Cmd+M', desc: 'Memory Panel' },
    { keys: 'Cmd+Shift+V', desc: 'Voice Input' },
    { keys: 'Cmd+Shift+B', desc: 'Browser Panel' },
  ]},
];

function showKeyboardShortcuts() {
  // Use new keybindings editor if available, fall back to static modal
  if (typeof showKeybindingsEditor === 'function') {
    showKeybindingsEditor();
    return;
  }
  
  // Fallback: static modal
  closeKeyboardShortcuts();
  
  const modal = document.createElement('div');
  modal.id = 'keyboardShortcutsModal';
  modal.className = 'keyboard-shortcuts-modal';
  modal.innerHTML = `
    <div class="shortcuts-content">
      <div class="shortcuts-header">
        <h2>⌨️ Keyboard Shortcuts</h2>
        <button onclick="closeKeyboardShortcuts()" class="shortcuts-close">×</button>
      </div>
      <div class="shortcuts-grid">
        ${keyboardShortcuts.map(cat => `
          <div class="shortcuts-category">
            <h3>${cat.category}</h3>
            ${cat.shortcuts.map(s => `
              <div class="shortcut-row">
                <kbd>${s.keys}</kbd>
                <span>${s.desc}</span>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
      <div class="shortcuts-footer">
        <span class="hint">Press <kbd>Esc</kbd> to close | Click to customize</span>
      </div>
    </div>
  `;
  
  modal.onclick = (e) => {
    if (e.target === modal) closeKeyboardShortcuts();
  };
  
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('visible'), 10);
}

function closeKeyboardShortcuts() {
  const modal = document.getElementById('keyboardShortcutsModal');
  if (modal) {
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 200);
  }
  // Also close keybindings editor if open
  if (typeof closeKeybindingsEditor === 'function') {
    closeKeybindingsEditor();
  }
}

// ============================================
// RESIZE HANDLERS
// ============================================
function setupResizeHandlers() {
  const sidebar = document.getElementById('sidebar');
  const resizeHandle = document.getElementById('sidebarResize');
  let isResizing = false;
  
  resizeHandle.addEventListener('mousedown', () => {
    isResizing = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const width = e.clientX - 48;
    if (width >= 200 && width <= 500) {
      sidebar.style.width = `${width}px`;
    }
  });
  
  document.addEventListener('mouseup', () => {
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ============================================
// SESSION STATE
// ============================================
function saveSessionState() {
  const state_data = {
    openFiles: Array.from(state.openFiles.keys()),
    activeFile: state.currentFile,
    recentFiles: state.recentFiles
  };
  localStorage.setItem('clawd-ide-state', JSON.stringify(state_data));
}

function loadSessionState() {
  try {
    const saved = localStorage.getItem('clawd-ide-state');
    if (!saved) return;
    
    const data = JSON.parse(saved);
    state.recentFiles = data.recentFiles || [];
    
    // Restore open files
    if (data.openFiles?.length > 0) {
      data.openFiles.forEach(path => {
        openFile(path, false);
      });
      
      // Switch to previously active file
      if (data.activeFile && state.openFiles.has(data.activeFile)) {
        switchToTab(data.activeFile);
      }
    }
  } catch (e) {
    console.error('Failed to restore session:', e);
  }
}

// ============================================
// NOTIFICATIONS
// ============================================
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    bottom: 40px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'success' ? '#4ade80' : type === 'error' ? '#f44747' : '#3794ff'};
    color: ${type === 'success' ? '#000' : '#fff'};
    border-radius: 8px;
    font-size: 13px;
    z-index: 10000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
}

// ============================================
// SETTINGS
// ============================================
const defaultSettings = {
  editor: {
    fontSize: 14,
    tabSize: 2,
    wordWrap: 'on',
    minimap: true,
    lineNumbers: 'on',
    bracketPairs: true,
    fontFamily: "'SF Mono', 'Fira Code', Menlo, Monaco, monospace"
  },
  ai: {
    inlineCompletions: true,
    completionDelay: 500
  },
  appearance: {
    theme: 'clawd-dark'
  },
  terminal: {
    fontSize: 13
  },
  memory: {
    enabled: true,
    includeInChat: true
  }
};

let currentSettings = JSON.parse(JSON.stringify(defaultSettings));

function loadSettings() {
  try {
    const saved = localStorage.getItem('clawd-ide-settings');
    if (saved) {
      currentSettings = { ...defaultSettings, ...JSON.parse(saved) };
    }
    applySettings();
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

function openSettings() {
  const modal = document.getElementById('settingsModal');
  const overlay = document.getElementById('overlay');
  
  modal.classList.remove('hidden');
  overlay.classList.remove('hidden');
  
  // Populate form with current settings
  document.getElementById('settingFontSize').value = currentSettings.editor.fontSize;
  document.getElementById('settingTabSize').value = currentSettings.editor.tabSize;
  document.getElementById('settingWordWrap').value = currentSettings.editor.wordWrap;
  document.getElementById('settingMinimap').checked = currentSettings.editor.minimap;
  document.getElementById('settingLineNumbers').value = currentSettings.editor.lineNumbers;
  document.getElementById('settingBracketPairs').checked = currentSettings.editor.bracketPairs;
  document.getElementById('settingInlineCompletions').checked = currentSettings.ai.inlineCompletions;
  document.getElementById('settingCompletionDelay').value = currentSettings.ai.completionDelay;
  document.getElementById('settingTheme').value = currentSettings.appearance.theme;
  document.getElementById('settingFontFamily').value = currentSettings.editor.fontFamily;
  document.getElementById('settingTerminalFontSize').value = currentSettings.terminal.fontSize;
  
  // Memory settings
  if (currentSettings.memory) {
    document.getElementById('settingMemoryEnabled').checked = currentSettings.memory.enabled;
    document.getElementById('settingMemoryInChat').checked = currentSettings.memory.includeInChat;
  }
  
  // Sound settings
  if (typeof SoundManager !== 'undefined') {
    document.getElementById('settingSoundsEnabled').checked = SoundManager.enabled;
    document.getElementById('settingSoundsVolume').value = SoundManager.volume;
  }
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
}

// ============================================
// DIAGNOSTICS
// ============================================

function openDiagnostics() {
  window.open('/tests/', '_blank');
}

async function runQuickDiagnostics() {
  closeSettings();
  
  // Show toast that we're running
  if (window.showToast) {
    showToast('Running quick diagnostics...', 'info');
  }
  
  // Load diagnostic script if not already loaded
  if (!window.DiagnosticTests) {
    const script = document.createElement('script');
    script.src = '/tests/diagnostic-tests.js';
    script.onload = async () => {
      const report = await DiagnosticTests.runQuick();
      showDiagnosticResults(report);
    };
    document.head.appendChild(script);
  } else {
    const report = await DiagnosticTests.runQuick();
    showDiagnosticResults(report);
  }
}

function showDiagnosticResults(report) {
  const passed = report.summary.passed;
  const failed = report.summary.failed;
  const warnings = report.summary.warnings;
  
  let message = `✅ ${passed} passed`;
  if (failed > 0) message += ` | ❌ ${failed} failed`;
  if (warnings > 0) message += ` | ⚠️ ${warnings} warnings`;
  
  const type = failed > 0 ? 'error' : (warnings > 0 ? 'warning' : 'success');
  
  if (window.showToast) {
    showToast(message, type, 5000);
  } else {
    alert(`Diagnostics Complete\n\n${message}`);
  }
  
  // Also log to console for details
  console.log('📋 Diagnostic Report:', report);
}

function openDevTools() {
  // Can't programmatically open DevTools, but we can show instructions
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const shortcut = isMac ? '⌘+Option+I' : 'Ctrl+Shift+I';
  
  if (window.showToast) {
    showToast(`Press ${shortcut} to open DevTools`, 'info', 3000);
  } else {
    alert(`Press ${shortcut} to open Developer Tools`);
  }
}

function saveSettings() {
  // Read from form
  currentSettings.editor.fontSize = parseInt(document.getElementById('settingFontSize').value);
  currentSettings.editor.tabSize = parseInt(document.getElementById('settingTabSize').value);
  currentSettings.editor.wordWrap = document.getElementById('settingWordWrap').value;
  currentSettings.editor.minimap = document.getElementById('settingMinimap').checked;
  currentSettings.editor.lineNumbers = document.getElementById('settingLineNumbers').value;
  currentSettings.editor.bracketPairs = document.getElementById('settingBracketPairs').checked;
  currentSettings.editor.fontFamily = document.getElementById('settingFontFamily').value;
  currentSettings.ai.inlineCompletions = document.getElementById('settingInlineCompletions').checked;
  currentSettings.ai.completionDelay = parseInt(document.getElementById('settingCompletionDelay').value);
  currentSettings.appearance.theme = document.getElementById('settingTheme').value;
  currentSettings.terminal.fontSize = parseInt(document.getElementById('settingTerminalFontSize').value);
  
  // Memory settings
  currentSettings.memory = currentSettings.memory || {};
  currentSettings.memory.enabled = document.getElementById('settingMemoryEnabled').checked;
  currentSettings.memory.includeInChat = document.getElementById('settingMemoryInChat').checked;
  
  // Save to localStorage
  localStorage.setItem('clawd-ide-settings', JSON.stringify(currentSettings));
  
  // Apply settings
  applySettings();
  
  // Update memory indicator
  updateMemoryIndicator();
  
  closeSettings();
  showNotification('Settings saved!', 'success');
}

function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  
  currentSettings = JSON.parse(JSON.stringify(defaultSettings));
  localStorage.removeItem('clawd-ide-settings');
  
  // Update form
  openSettings();
  applySettings();
  
  showNotification('Settings reset to defaults', 'info');
}

// Apply theme to Monaco editor and CSS
function applyTheme(themeName) {
  const isLight = themeName === 'clawd-light' || themeName === 'vs';
  
  // Apply Monaco theme
  if (typeof monaco !== 'undefined') {
    monaco.editor.setTheme(themeName);
  }
  
  // Apply CSS theme class
  if (isLight) {
    document.documentElement.classList.add('theme-light');
  } else {
    document.documentElement.classList.remove('theme-light');
  }
  
  // Update meta theme-color for browser chrome
  let metaTheme = document.querySelector('meta[name="theme-color"]');
  if (!metaTheme) {
    metaTheme = document.createElement('meta');
    metaTheme.name = 'theme-color';
    document.head.appendChild(metaTheme);
  }
  metaTheme.content = isLight ? '#ffffff' : '#1e1e1e';
  
  // Save to settings
  currentSettings.appearance.theme = themeName;
}

// Toggle between dark and light themes
function toggleTheme() {
  const current = currentSettings.appearance.theme;
  const newTheme = (current === 'clawd-dark') ? 'clawd-light' : 'clawd-dark';
  applyTheme(newTheme);
  saveSettings();
  showNotification(`Theme: ${newTheme === 'clawd-light' ? 'Light' : 'Dark'}`, 'info');
}

function applySettings() {
  // Apply to all pane editors
  state.panes.forEach(pane => {
    if (pane.editor) {
      pane.editor.updateOptions({
        fontSize: currentSettings.editor.fontSize,
        tabSize: currentSettings.editor.tabSize,
        wordWrap: currentSettings.editor.wordWrap,
        minimap: { enabled: currentSettings.editor.minimap },
        lineNumbers: currentSettings.editor.lineNumbers,
        bracketPairColorization: { enabled: currentSettings.editor.bracketPairs },
        fontFamily: currentSettings.editor.fontFamily
      });
    }
  });
  
  // Apply theme (Monaco + CSS)
  applyTheme(currentSettings.appearance.theme);
  
  // Apply terminal settings
  if (state.terminal) {
    state.terminal.options.fontSize = currentSettings.terminal.fontSize;
    if (state.terminalFitAddon) {
      state.terminalFitAddon.fit();
    }
  }
  
  // Apply AI settings
  if (typeof completionState !== 'undefined') {
    completionState.enabled = currentSettings.ai.inlineCompletions;
  }
}

function closeAllModals() {
  closeCommandPalette();
  closeSettings();
  closeInlineEdit();
}

// toggleProblemsPanel is defined in problems.js

// ============================================
// DYNAMIC STYLES
// ============================================
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  .git-change:hover { background: var(--bg-hover); }
  code { 
    background: var(--bg-tertiary); 
    padding: 2px 6px; 
    border-radius: 3px; 
    font-family: 'SF Mono', monospace; 
    font-size: 12px; 
  }
  .code-block {
    background: var(--bg-primary);
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    font-family: 'SF Mono', monospace;
    font-size: 12px;
    line-height: 1.5;
    position: relative;
    margin: 10px 0;
  }
  .code-block code {
    background: transparent;
    padding: 0;
  }
  .code-block-actions {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
  }
  .code-action {
    background: var(--bg-tertiary);
    border: none;
    color: var(--text-secondary);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }
  .code-action:hover { 
    background: var(--bg-hover); 
    color: var(--text-primary); 
  }
  .message-content { 
    white-space: pre-wrap; 
    word-break: break-word; 
  }
  .sidebar.hidden { display: none; }
`;
document.head.appendChild(style);

// ============================================
// INLINE COMPLETIONS (Ghost Text / Copilot-style)
// ============================================
const completionState = {
  enabled: true,
  pending: null,
  currentSuggestion: null,
  decorations: [],
  debounceTimer: null,
  lastRequest: null
};

function initInlineCompletions() {
  if (!state.editor) return;
  
  // Listen for content changes
  state.editor.onDidChangeModelContent((e) => {
    if (!completionState.enabled) return;
    
    // Clear existing suggestion
    clearInlineSuggestion();
    
    // Debounce - wait for user to stop typing
    if (completionState.debounceTimer) {
      clearTimeout(completionState.debounceTimer);
    }
    
    completionState.debounceTimer = setTimeout(() => {
      requestInlineCompletion();
    }, currentSettings.ai.completionDelay || 500);
  });
  
  // Handle Tab to accept
  state.editor.addCommand(monaco.KeyCode.Tab, () => {
    if (completionState.currentSuggestion) {
      acceptInlineSuggestion();
    } else {
      // Default tab behavior
      state.editor.trigger('keyboard', 'tab', {});
    }
  }, 'editorTextFocus && !suggestWidgetVisible && !inSnippetMode');
  
  // Handle Escape to dismiss
  state.editor.addCommand(monaco.KeyCode.Escape, () => {
    if (completionState.currentSuggestion) {
      clearInlineSuggestion();
    }
  }, 'editorTextFocus');
  
  // Handle Cmd+Right to accept word by word
  state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow, () => {
    if (completionState.currentSuggestion) {
      acceptInlineSuggestionWord();
    } else {
      // Default behavior
      state.editor.trigger('keyboard', 'cursorWordEndRight', {});
    }
  }, 'editorTextFocus');
}

async function requestInlineCompletion() {
  if (!state.editor || !state.gatewayConnected || !completionState.enabled) return;
  
  const model = state.editor.getModel();
  const position = state.editor.getPosition();
  
  if (!model || !position) return;
  
  // Don't suggest in comments or strings (basic check)
  const lineContent = model.getLineContent(position.lineNumber);
  const beforeCursor = lineContent.substring(0, position.column - 1);
  
  // Skip if line is empty or just whitespace
  if (beforeCursor.trim().length === 0) return;
  
  // Skip if in a comment
  if (beforeCursor.trim().startsWith('//') || beforeCursor.trim().startsWith('#')) return;
  
  // Build context
  const fullContent = model.getValue();
  const offset = model.getOffsetAt(position);
  const prefix = fullContent.substring(Math.max(0, offset - 2000), offset); // 2000 chars before
  const suffix = fullContent.substring(offset, Math.min(fullContent.length, offset + 500)); // 500 chars after
  
  const language = model.getLanguageId();
  const filename = state.currentFile ? state.currentFile.split('/').pop() : 'untitled';
  
  // Create request ID
  const requestId = Date.now().toString();
  completionState.lastRequest = requestId;
  
  try {
    // Send completion request to server
    const response = await fetch('/api/completion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix,
        suffix,
        language,
        filename,
        line: position.lineNumber,
        column: position.column
      })
    });
    
    // Check if this is still the latest request
    if (completionState.lastRequest !== requestId) return;
    
    const data = await response.json();
    
    if (data.completion && data.completion.trim()) {
      showInlineSuggestion(data.completion, position);
    }
  } catch (err) {
    // Silently fail - completions are optional
    console.debug('Completion request failed:', err);
  }
}

function showInlineSuggestion(suggestion, position) {
  if (!state.editor) return;
  
  completionState.currentSuggestion = {
    text: suggestion,
    position: { ...position }
  };
  
  // Create ghost text decoration
  const ghostTextDecoration = {
    range: new monaco.Range(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column
    ),
    options: {
      after: {
        content: suggestion,
        inlineClassName: 'ghost-text-suggestion'
      }
    }
  };
  
  completionState.decorations = state.editor.deltaDecorations(
    completionState.decorations,
    [ghostTextDecoration]
  );
}

function clearInlineSuggestion() {
  if (!state.editor) return;
  
  completionState.currentSuggestion = null;
  completionState.decorations = state.editor.deltaDecorations(
    completionState.decorations,
    []
  );
}

function acceptInlineSuggestion() {
  if (!state.editor || !completionState.currentSuggestion) return;
  
  const { text, position } = completionState.currentSuggestion;
  
  // Insert the suggestion
  state.editor.executeEdits('inline-completion', [{
    range: new monaco.Range(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column
    ),
    text: text,
    forceMoveMarkers: true
  }]);
  
  // Move cursor to end of inserted text
  const lines = text.split('\n');
  const lastLine = lines[lines.length - 1];
  const newLine = position.lineNumber + lines.length - 1;
  const newColumn = lines.length === 1 
    ? position.column + text.length 
    : lastLine.length + 1;
  
  state.editor.setPosition({ lineNumber: newLine, column: newColumn });
  
  clearInlineSuggestion();
}

function acceptInlineSuggestionWord() {
  if (!state.editor || !completionState.currentSuggestion) return;
  
  const { text, position } = completionState.currentSuggestion;
  
  // Find the first word boundary
  const wordMatch = text.match(/^(\S+\s?)/);
  if (!wordMatch) {
    acceptInlineSuggestion();
    return;
  }
  
  const word = wordMatch[1];
  
  // Insert just the word
  state.editor.executeEdits('inline-completion-word', [{
    range: new monaco.Range(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column
    ),
    text: word,
    forceMoveMarkers: true
  }]);
  
  // Update suggestion to remaining text
  const remaining = text.substring(word.length);
  if (remaining.trim()) {
    const newPosition = state.editor.getPosition();
    completionState.currentSuggestion = {
      text: remaining,
      position: newPosition
    };
    showInlineSuggestion(remaining, newPosition);
  } else {
    clearInlineSuggestion();
  }
}

function toggleInlineCompletions() {
  completionState.enabled = !completionState.enabled;
  if (!completionState.enabled) {
    clearInlineSuggestion();
  }
  showNotification(
    completionState.enabled ? 'Inline completions enabled' : 'Inline completions disabled',
    'info'
  );
}

// ============================================
// RIGHT PANEL MANAGEMENT
// ============================================
const rightPanelState = {
  visible: false,
  activePanel: 'terminal', // 'terminal' or 'ai'
  terminalInstance: null,
  terminalFitAddon: null
};

function showRightPanel() {
  const container = document.getElementById('rightPanelContainer');
  const resize = document.getElementById('rightPanelResize');
  const editorArea = document.querySelector('.editor-area');
  
  container.classList.remove('hidden');
  resize.classList.remove('hidden');
  editorArea.classList.add('has-right-panel');
  rightPanelState.visible = true;
  
  // Initialize terminal in right panel if needed
  if (rightPanelState.activePanel === 'terminal' && !rightPanelState.terminalInstance) {
    initRightTerminal();
  }
  
  // Refit terminals
  setTimeout(() => {
    if (state.terminalFitAddon) state.terminalFitAddon.fit();
    if (rightPanelState.terminalFitAddon) rightPanelState.terminalFitAddon.fit();
  }, 100);
}

function closeRightPanel() {
  const container = document.getElementById('rightPanelContainer');
  const resize = document.getElementById('rightPanelResize');
  const editorArea = document.querySelector('.editor-area');
  
  container.classList.add('hidden');
  resize.classList.add('hidden');
  editorArea.classList.remove('has-right-panel');
  rightPanelState.visible = false;
  
  // Refit main terminal
  setTimeout(() => {
    if (state.terminalFitAddon) state.terminalFitAddon.fit();
  }, 100);
}

function switchRightPanel(panel) {
  rightPanelState.activePanel = panel;
  
  // Update tabs
  document.querySelectorAll('.right-panel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.panel === panel);
  });
  
  // Update content
  document.getElementById('rightTerminal').classList.toggle('hidden', panel !== 'terminal');
  document.getElementById('rightAiChat').classList.toggle('hidden', panel !== 'ai');
  
  // Init terminal if switching to it
  if (panel === 'terminal' && !rightPanelState.terminalInstance) {
    initRightTerminal();
  }
  
  // Refit terminal
  if (panel === 'terminal' && rightPanelState.terminalFitAddon) {
    setTimeout(() => rightPanelState.terminalFitAddon.fit(), 100);
  }
}

function moveTerminalToRight() {
  // Hide bottom terminal
  document.getElementById('terminalContainer').style.display = 'none';
  
  // Show right panel with terminal
  showRightPanel();
  switchRightPanel('terminal');
  
  showNotification('Terminal moved to right panel', 'info');
}

function moveAiChatToRight() {
  showRightPanel();
  switchRightPanel('ai');
  showNotification('AI Chat moved to right panel', 'info');
}

function initRightTerminal() {
  if (rightPanelState.terminalInstance) return;
  
  rightPanelState.terminalInstance = new Terminal({
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#4ade80',
      selection: '#264f78',
    },
    fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
  });
  
  rightPanelState.terminalFitAddon = new FitAddon.FitAddon();
  rightPanelState.terminalInstance.loadAddon(rightPanelState.terminalFitAddon);
  rightPanelState.terminalInstance.loadAddon(new WebLinksAddon.WebLinksAddon());
  
  const container = document.getElementById('terminalRight');
  rightPanelState.terminalInstance.open(container);
  rightPanelState.terminalFitAddon.fit();
  
  // Connect to same PTY as main terminal (share session)
  rightPanelState.terminalInstance.onData((data) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'terminal:input', data }));
    }
  });
  
  // Fit on resize
  new ResizeObserver(() => {
    if (rightPanelState.terminalFitAddon) {
      rightPanelState.terminalFitAddon.fit();
    }
  }).observe(container);
}

// Handle right AI chat input
function handleRightAiInput(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendRightAiMessage();
  }
}

function sendRightAiMessage() {
  const input = document.getElementById('rightAiInput');
  const message = input.value.trim();
  if (!message) return;
  
  addRightAiMessage('user', message);
  input.value = '';
  
  // Check for slash commands - handle locally or pass to gateway
  if (message.startsWith('/')) {
    const handled = handleSlashCommandRight(message);
    if (handled) return;
    // If not handled locally, fall through to send to gateway
  }
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'clawd:message',
      message,
      currentFile: state.currentFile,
      selectedCode: getSelectedCode()
    }));
  }
}

function handleSlashCommandRight(message) {
  const parts = message.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  
  if (command === '/clear') {
    document.getElementById('rightAiMessages').innerHTML = `
      <div class="ai-message assistant">
        <strong>Clawd 🐾</strong>
        <p>Chat cleared!</p>
      </div>
    `;
    return true;
  }
  
  // For IDE commands, use the main handler but output to right panel
  if (slashCommands[command]) {
    // Redirect output to right panel
    const originalAdd = addAiMessage;
    addAiMessage = addRightAiMessage;
    slashCommands[command].handler();
    addAiMessage = originalAdd;
    return true;
  }
  
  // Pass through other slash commands to gateway (like /new, /compact, etc.)
  return false;
}

function addRightAiMessage(role, content) {
  const messages = document.getElementById('rightAiMessages');
  const div = document.createElement('div');
  div.className = `ai-message ${role}`;
  
  const formatted = role === 'assistant' ? formatAiResponse(content) : escapeHtml(content);
  
  div.innerHTML = `
    <strong>${role === 'user' ? 'You' : 'Clawd 🐾'}</strong>
    <div class="message-content">${formatted}</div>
  `;
  
  if (role === 'assistant') {
    addCodeBlockActions(div);
  }
  
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// ============================================
// THINKING / TOOL CALL DISPLAY
// ============================================
const toolCallState = {
  activeTools: new Map(),
  thinkingStartTime: null
};

function showToolCall(toolName, params, status = 'pending') {
  const toolId = `tool-${Date.now()}`;
  
  const toolHtml = `
    <div class="tool-call" id="${toolId}" data-status="${status}">
      <div class="tool-call-header" onclick="toggleToolCallExpand('${toolId}')">
        <span class="tool-call-icon ${status}">
          ${status === 'pending' ? '⟳' : status === 'success' ? '✓' : '✗'}
        </span>
        <span class="tool-call-name">${toolName}</span>
        <span class="tool-call-status">${status === 'pending' ? 'Running...' : status}</span>
      </div>
      <div class="tool-call-body">
        <div class="tool-call-params">${JSON.stringify(params, null, 2)}</div>
        <div class="tool-call-result"></div>
      </div>
    </div>
  `;
  
  // Add to current streaming message or create new
  const container = state.currentStreamingMessage || document.querySelector('#aiMessages .ai-message:last-child');
  if (container) {
    const content = container.querySelector('.message-content') || container;
    content.insertAdjacentHTML('beforeend', toolHtml);
  }
  
  toolCallState.activeTools.set(toolId, { name: toolName, params, status });
  return toolId;
}

function updateToolCall(toolId, status, result = null) {
  const toolEl = document.getElementById(toolId);
  if (!toolEl) return;
  
  toolEl.dataset.status = status;
  
  const icon = toolEl.querySelector('.tool-call-icon');
  icon.className = `tool-call-icon ${status}`;
  icon.textContent = status === 'success' ? '✓' : status === 'error' ? '✗' : '⟳';
  
  const statusEl = toolEl.querySelector('.tool-call-status');
  statusEl.textContent = status === 'success' ? 'Done' : status === 'error' ? 'Failed' : 'Running...';
  
  if (result) {
    const resultEl = toolEl.querySelector('.tool-call-result');
    resultEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
  
  toolCallState.activeTools.get(toolId).status = status;
}

function toggleToolCallExpand(toolId) {
  const toolEl = document.getElementById(toolId);
  if (toolEl) {
    toolEl.classList.toggle('expanded');
  }
}

function showThinkingWithTimer() {
  toolCallState.thinkingStartTime = Date.now();
  
  const indicator = document.createElement('div');
  indicator.id = 'thinkingTimer';
  indicator.className = 'thinking-indicator';
  indicator.innerHTML = `
    <div class="spinner"></div>
    <span class="thinking-text">Thinking...</span>
    <span class="thinking-duration">0s</span>
  `;
  
  const messages = document.getElementById('aiMessages');
  messages.appendChild(indicator);
  messages.scrollTop = messages.scrollHeight;
  
  // Update timer
  const updateTimer = () => {
    const el = document.getElementById('thinkingTimer');
    if (el && toolCallState.thinkingStartTime) {
      const elapsed = Math.floor((Date.now() - toolCallState.thinkingStartTime) / 1000);
      el.querySelector('.thinking-duration').textContent = `${elapsed}s`;
      requestAnimationFrame(updateTimer);
    }
  };
  updateTimer();
}

function hideThinkingTimer() {
  const indicator = document.getElementById('thinkingTimer');
  if (indicator) indicator.remove();
  toolCallState.thinkingStartTime = null;
}

function updateThinkingText(text) {
  const indicator = document.getElementById('thinkingTimer');
  if (indicator) {
    indicator.querySelector('.thinking-text').textContent = text;
  }
}

// Expose functions globally
window.switchPanel = switchPanel;
window.handleSearch = handleSearch;
window.toggleSearchFileGroup = toggleSearchFileGroup;
window.openFileAtLine = openFileAtLine;
window.handleAiInput = handleAiInput;
window.sendAiMessage = sendAiMessage;
// toggleTerminal is defined in modules/terminal.js - defer assignment
setTimeout(() => { if (typeof toggleTerminal === 'function') window.toggleTerminal = toggleTerminal; }, 100);
window.clearTerminal = clearTerminal;
window.startTerminal = startTerminal;
window.toggleCommandPalette = toggleCommandPalette;
window.closeCommandPalette = closeCommandPalette;
window.handleCommandInput = handleCommandInput;
window.openFile = openFile;
window.closeTab = closeTab;
// ============================================
// BROWSER PANEL (Phase 3)
// ============================================
const VIEWPORT_PRESETS = [
  { name: 'iPhone 14 Pro', width: 393, height: 852, icon: '📱' },
  { name: 'iPhone SE', width: 375, height: 667, icon: '📱' },
  { name: 'iPad', width: 768, height: 1024, icon: '📱' },
  { name: 'iPad Pro', width: 1024, height: 1366, icon: '📱' },
  { name: 'Laptop', width: 1366, height: 768, icon: '💻' },
  { name: 'Desktop HD', width: 1920, height: 1080, icon: '💻' },
  { name: 'Desktop 4K', width: 3840, height: 2160, icon: '💻' },
  { name: 'Responsive', width: null, height: null, icon: '📐' }
];

function createBrowser(url = 'http://localhost:3000', paneId = null) {
  const id = `browser-${state.browserNextId++}`;
  
  const browser = {
    id,
    url,
    title: 'New Tab',
    history: [url],
    historyIndex: 0,
    viewport: { width: null, height: null, name: 'Responsive' },
    console: [],
    network: [],
    loading: false
  };
  
  state.browsers.set(id, browser);
  state.activeBrowser = id;
  
  // Add browser tab to the active pane or specified pane
  const targetPaneId = paneId !== null ? paneId : state.activePane;
  addBrowserTabToPane(id, targetPaneId);
  renderBrowserPanel(id, targetPaneId);
  
  return id;
}

function addBrowserTabToPane(browserId, paneId) {
  const browser = state.browsers.get(browserId);
  if (!browser) return;
  
  const tabsContainer = document.getElementById(`paneTabs${paneId}`);
  if (!tabsContainer) return;
  
  const tab = document.createElement('div');
  tab.className = 'tab browser-tab';
  tab.dataset.browserId = browserId;
  tab.dataset.type = 'browser';
  
  tab.innerHTML = `
    <span class="file-icon browser">🌐</span>
    <span class="name" id="browserTabTitle-${browserId}">${browser.title}</span>
    <span class="close" onclick="event.stopPropagation(); closeBrowserTab('${browserId}')">×</span>
  `;
  
  tab.onclick = () => switchToBrowserTab(browserId, paneId);
  tabsContainer.appendChild(tab);
  
  // Activate this tab
  switchToBrowserTab(browserId, paneId);
}

function switchToBrowserTab(browserId, paneId) {
  const pane = state.panes[paneId];
  if (!pane) return;
  
  state.activeBrowser = browserId;
  
  // Hide editor, show browser
  const editorContainer = document.querySelector(`#editorPane${paneId} .pane-editor-container`);
  const browserContainer = document.getElementById(`browserPanel-${browserId}`);
  
  if (editorContainer) editorContainer.style.display = 'none';
  
  // Hide all browsers in this pane, show the active one
  document.querySelectorAll(`#editorPane${paneId} .browser-panel`).forEach(bp => {
    bp.style.display = 'none';
  });
  if (browserContainer) browserContainer.style.display = 'flex';
  
  // Update tab states
  document.querySelectorAll(`#paneTabs${paneId} .tab`).forEach(t => {
    t.classList.remove('active');
    if (t.dataset.browserId === browserId) t.classList.add('active');
  });
  
  // Update breadcrumbs to show URL
  const browser = state.browsers.get(browserId);
  if (browser) {
    updateBreadcrumbs(null); // Hide file breadcrumbs
    document.getElementById('breadcrumbs').style.display = 'none';
  }
}

function closeBrowserTab(browserId) {
  const browser = state.browsers.get(browserId);
  if (!browser) return;
  
  // Remove browser panel
  const panel = document.getElementById(`browserPanel-${browserId}`);
  if (panel) panel.remove();
  
  // Remove tab
  const tab = document.querySelector(`.tab[data-browser-id="${browserId}"]`);
  if (tab) tab.remove();
  
  state.browsers.delete(browserId);
  
  if (state.activeBrowser === browserId) {
    state.activeBrowser = null;
    // Switch to another tab if available
    const remainingBrowser = state.browsers.keys().next().value;
    if (remainingBrowser) {
      switchToBrowserTab(remainingBrowser, state.activePane);
    } else {
      // Show editor again
      const editorContainer = document.querySelector(`#editorPane${state.activePane} .pane-editor-container`);
      if (editorContainer) editorContainer.style.display = 'flex';
    }
  }
}

function renderBrowserPanel(browserId, paneId) {
  const browser = state.browsers.get(browserId);
  if (!browser) return;
  
  const paneEl = document.getElementById(`editorPane${paneId}`);
  if (!paneEl) return;
  
  // Create browser panel
  const panel = document.createElement('div');
  panel.className = 'browser-panel';
  panel.id = `browserPanel-${browserId}`;
  
  panel.innerHTML = `
    <div class="browser-toolbar">
      <div class="browser-nav">
        <button class="browser-btn" onclick="browserBack('${browserId}')" title="Back">◀</button>
        <button class="browser-btn" onclick="browserForward('${browserId}')" title="Forward">▶</button>
        <button class="browser-btn" onclick="browserRefresh('${browserId}')" title="Refresh">🔄</button>
        <button class="browser-btn" onclick="browserHome('${browserId}')" title="Home">🏠</button>
      </div>
      <div class="browser-url-container">
        <span class="browser-security">🔒</span>
        <input type="text" class="browser-url" id="browserUrl-${browserId}" 
               value="${browser.url}" 
               onkeydown="handleBrowserUrlKeydown(event, '${browserId}')"
               placeholder="Enter URL or localhost port...">
      </div>
      <div class="browser-actions">
        <button class="browser-btn" onclick="toggleBrowserDevTools('${browserId}')" title="DevTools">🔧</button>
        <button class="browser-btn" onclick="browserScreenshot('${browserId}')" title="Screenshot">📸</button>
        <select class="browser-viewport-select" id="browserViewport-${browserId}" onchange="setBrowserViewport('${browserId}', this.value)">
          ${VIEWPORT_PRESETS.map(v => `<option value="${v.name}">${v.icon} ${v.name}${v.width ? ` (${v.width}×${v.height})` : ''}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="browser-content">
      <div class="browser-frame-container" id="browserFrameContainer-${browserId}">
        <div class="browser-loading" id="browserLoading-${browserId}" style="display: none;">
          <div class="spinner"></div>
          <span>Loading...</span>
        </div>
        <iframe class="browser-frame" id="browserFrame-${browserId}" 
                src="${browser.url}"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                onload="handleBrowserLoad('${browserId}')"
                onerror="handleBrowserError('${browserId}')"></iframe>
      </div>
      <div class="browser-devtools hidden" id="browserDevTools-${browserId}">
        <div class="devtools-tabs">
          <button class="devtools-tab active" onclick="switchDevToolsTab('${browserId}', 'console')">Console</button>
          <button class="devtools-tab" onclick="switchDevToolsTab('${browserId}', 'network')">Network</button>
          <button class="devtools-tab" onclick="switchDevToolsTab('${browserId}', 'elements')">Elements</button>
        </div>
        <div class="devtools-content">
          <div class="devtools-panel" id="devToolsConsole-${browserId}">
            <div class="console-messages" id="consoleMessages-${browserId}"></div>
            <div class="console-input-container">
              <span class="console-prompt">></span>
              <input type="text" class="console-input" id="consoleInput-${browserId}" 
                     placeholder="Evaluate JavaScript..." 
                     onkeydown="handleConsoleInput(event, '${browserId}')">
            </div>
          </div>
          <div class="devtools-panel hidden" id="devToolsNetwork-${browserId}">
            <div class="network-list" id="networkList-${browserId}">
              <div class="network-header">
                <span>Method</span>
                <span>URL</span>
                <span>Status</span>
                <span>Time</span>
              </div>
            </div>
          </div>
          <div class="devtools-panel hidden" id="devToolsElements-${browserId}">
            <div class="elements-placeholder">
              <p>Click "Inspect" on an element in the preview to view its styles.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Hide editor container, insert browser panel
  const editorContainer = paneEl.querySelector('.pane-editor-container');
  if (editorContainer) editorContainer.style.display = 'none';
  paneEl.appendChild(panel);
}

function browserNavigate(browserId, url) {
  const browser = state.browsers.get(browserId);
  if (!browser) return;
  
  // Normalize URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // Check if it's just a port number
    if (/^\d+$/.test(url)) {
      url = `http://localhost:${url}`;
    } else if (!url.includes('://')) {
      url = 'https://' + url;
    }
  }
  
  browser.url = url;
  browser.loading = true;
  
  // Update history
  browser.history = browser.history.slice(0, browser.historyIndex + 1);
  browser.history.push(url);
  browser.historyIndex = browser.history.length - 1;
  
  // Update UI
  const urlInput = document.getElementById(`browserUrl-${browserId}`);
  if (urlInput) urlInput.value = url;
  
  const loading = document.getElementById(`browserLoading-${browserId}`);
  if (loading) loading.style.display = 'flex';
  
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (frame) frame.src = url;
}

function browserBack(browserId) {
  const browser = state.browsers.get(browserId);
  if (!browser || browser.historyIndex <= 0) return;
  
  browser.historyIndex--;
  const url = browser.history[browser.historyIndex];
  browser.url = url;
  
  const urlInput = document.getElementById(`browserUrl-${browserId}`);
  if (urlInput) urlInput.value = url;
  
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (frame) frame.src = url;
}

function browserForward(browserId) {
  const browser = state.browsers.get(browserId);
  if (!browser || browser.historyIndex >= browser.history.length - 1) return;
  
  browser.historyIndex++;
  const url = browser.history[browser.historyIndex];
  browser.url = url;
  
  const urlInput = document.getElementById(`browserUrl-${browserId}`);
  if (urlInput) urlInput.value = url;
  
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (frame) frame.src = url;
}

function browserRefresh(browserId) {
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (frame) {
    const loading = document.getElementById(`browserLoading-${browserId}`);
    if (loading) loading.style.display = 'flex';
    frame.src = frame.src;
  }
}

function browserHome(browserId) {
  browserNavigate(browserId, 'http://localhost:3000');
}

function handleBrowserUrlKeydown(event, browserId) {
  if (event.key === 'Enter') {
    browserNavigate(browserId, event.target.value);
  }
}

function handleBrowserLoad(browserId) {
  const browser = state.browsers.get(browserId);
  if (!browser) return;
  
  browser.loading = false;
  
  const loading = document.getElementById(`browserLoading-${browserId}`);
  if (loading) loading.style.display = 'none';
  
  // Try to get page title
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (frame) {
    try {
      const title = frame.contentDocument?.title || new URL(browser.url).hostname;
      browser.title = title;
      const tabTitle = document.getElementById(`browserTabTitle-${browserId}`);
      if (tabTitle) tabTitle.textContent = title.substring(0, 20) + (title.length > 20 ? '...' : '');
    } catch (e) {
      // Cross-origin, use URL hostname
      browser.title = new URL(browser.url).hostname;
    }
  }
  
  // Inject console capture script for same-origin frames
  injectDevToolsScript(browserId);
}

function handleBrowserError(browserId) {
  const browser = state.browsers.get(browserId);
  if (!browser) return;
  
  browser.loading = false;
  
  const loading = document.getElementById(`browserLoading-${browserId}`);
  if (loading) loading.style.display = 'none';
  
  addConsoleMessage(browserId, 'error', `Failed to load: ${browser.url}`);
}

function setBrowserViewport(browserId, presetName) {
  const preset = VIEWPORT_PRESETS.find(p => p.name === presetName);
  if (!preset) return;
  
  const browser = state.browsers.get(browserId);
  if (browser) {
    browser.viewport = { width: preset.width, height: preset.height, name: preset.name };
  }
  
  const frameContainer = document.getElementById(`browserFrameContainer-${browserId}`);
  if (frameContainer) {
    if (preset.width && preset.height) {
      frameContainer.style.width = preset.width + 'px';
      frameContainer.style.height = preset.height + 'px';
      frameContainer.classList.add('viewport-constrained');
    } else {
      frameContainer.style.width = '';
      frameContainer.style.height = '';
      frameContainer.classList.remove('viewport-constrained');
    }
  }
}

function toggleBrowserDevTools(browserId) {
  const devtools = document.getElementById(`browserDevTools-${browserId}`);
  if (devtools) {
    devtools.classList.toggle('hidden');
  }
}

function switchDevToolsTab(browserId, tabName) {
  // Update tab buttons
  document.querySelectorAll(`#browserDevTools-${browserId} .devtools-tab`).forEach(tab => {
    tab.classList.toggle('active', tab.textContent.toLowerCase() === tabName);
  });
  
  // Show/hide panels
  const panels = ['console', 'network', 'elements'];
  panels.forEach(panel => {
    const el = document.getElementById(`devTools${panel.charAt(0).toUpperCase() + panel.slice(1)}-${browserId}`);
    if (el) el.classList.toggle('hidden', panel !== tabName);
  });
}

function addConsoleMessage(browserId, level, message, source = '') {
  const browser = state.browsers.get(browserId);
  if (browser) {
    browser.console.push({ level, message, source, timestamp: Date.now() });
  }
  
  const container = document.getElementById(`consoleMessages-${browserId}`);
  if (!container) return;
  
  const levelIcons = { log: '▶', warn: '⚠️', error: '✕', info: 'ℹ️' };
  const msg = document.createElement('div');
  msg.className = `console-message ${level}`;
  msg.innerHTML = `
    <span class="console-icon">${levelIcons[level] || '▶'}</span>
    <span class="console-text">${escapeHtml(message)}</span>
    ${source ? `<span class="console-source">${source}</span>` : ''}
  `;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function handleConsoleInput(event, browserId) {
  if (event.key !== 'Enter') return;
  
  const input = event.target;
  const code = input.value.trim();
  if (!code) return;
  
  addConsoleMessage(browserId, 'log', `> ${code}`);
  
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (frame) {
    try {
      const result = frame.contentWindow.eval(code);
      addConsoleMessage(browserId, 'log', String(result));
    } catch (e) {
      addConsoleMessage(browserId, 'error', e.message);
    }
  }
  
  input.value = '';
}

function injectDevToolsScript(browserId) {
  const frame = document.getElementById(`browserFrame-${browserId}`);
  if (!frame) return;
  
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    
    // Inject console capture
    const script = doc.createElement('script');
    script.textContent = `
      (function() {
        const originalConsole = { ...console };
        ['log', 'warn', 'error', 'info'].forEach(method => {
          console[method] = (...args) => {
            window.parent.postMessage({
              type: 'console',
              browserId: '${browserId}',
              method,
              args: args.map(a => {
                try { return JSON.stringify(a); }
                catch { return String(a); }
              })
            }, '*');
            originalConsole[method](...args);
          };
        });
        
        // Capture network requests
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const start = performance.now();
          const [url, options] = args;
          try {
            const response = await originalFetch(...args);
            window.parent.postMessage({
              type: 'network',
              browserId: '${browserId}',
              method: options?.method || 'GET',
              url: url.toString(),
              status: response.status,
              duration: Math.round(performance.now() - start)
            }, '*');
            return response;
          } catch (e) {
            window.parent.postMessage({
              type: 'network',
              browserId: '${browserId}',
              method: options?.method || 'GET',
              url: url.toString(),
              status: 'ERR',
              duration: Math.round(performance.now() - start),
              error: e.message
            }, '*');
            throw e;
          }
        };
      })();
    `;
    doc.head.appendChild(script);
  } catch (e) {
    // Cross-origin, can't inject
    console.log('Cannot inject DevTools script (cross-origin)');
  }
}

function browserScreenshot(browserId) {
  showNotification('Screenshot feature coming soon!', 'info');
}

// Listen for messages from browser frames
window.addEventListener('message', (event) => {
  if (event.data?.type === 'console' && event.data?.browserId) {
    const { browserId, method, args } = event.data;
    addConsoleMessage(browserId, method, args.join(' '));
  }
  
  if (event.data?.type === 'network' && event.data?.browserId) {
    const { browserId, method, url, status, duration, error } = event.data;
    addNetworkRequest(browserId, { method, url, status, duration, error });
  }
});

function addNetworkRequest(browserId, request) {
  const browser = state.browsers.get(browserId);
  if (browser) {
    browser.network.push({ ...request, timestamp: Date.now() });
  }
  
  const list = document.getElementById(`networkList-${browserId}`);
  if (!list) return;
  
  const row = document.createElement('div');
  row.className = `network-row ${request.error ? 'error' : request.status >= 400 ? 'error' : 'success'}`;
  row.innerHTML = `
    <span class="network-method">${request.method}</span>
    <span class="network-url" title="${escapeHtml(request.url)}">${request.url.substring(0, 50)}${request.url.length > 50 ? '...' : ''}</span>
    <span class="network-status">${request.status}</span>
    <span class="network-time">${request.duration}ms</span>
  `;
  list.appendChild(row);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Keyboard shortcut to open browser
function openBrowserInPane() {
  // Prompt for URL
  const url = prompt('Enter URL or localhost port:', 'http://localhost:3000');
  if (url) {
    createBrowser(url);
  }
}

window.createNewFile = createNewFile;
window.createNewFolder = createNewFolder;
window.refreshFiles = refreshFiles;
window.gitCommit = gitCommit;
window.generateCommitMessage = generateCommitMessage;
window.openSettings = openSettings;
window.saveCurrentFile = saveCurrentFile;
window.breadcrumbClick = breadcrumbClick;
window.showBreadcrumbDropdown = showBreadcrumbDropdown;
window.showSymbolDropdown = showSymbolDropdown;
window.goToSymbol = goToSymbol;
window.breadcrumbDropdownSelect = breadcrumbDropdownSelect;
window.toggleFindWidget = toggleFindWidget;
window.showInlineEdit = showInlineEdit;
window.explainSelectedCode = explainSelectedCode;
window.improveSelectedCode = improveSelectedCode;
window.writeTestsForCode = writeTestsForCode;
window.fixSelectedCode = fixSelectedCode;
window.addDocumentation = addDocumentation;
window.copyCodeBlock = copyCodeBlock;
window.insertCodeAtCursor = insertCodeAtCursor;
window.replaceSelection = replaceSelection;
// toggleProblemsPanel is exported from problems.js
window.toggleInlineCompletions = toggleInlineCompletions;
window.showContextDetail = showContextDetail;
window.fetchContextUsage = fetchContextUsage;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.saveSettings = saveSettings;
window.resetSettings = resetSettings;
window.closeAllModals = closeAllModals;
window.splitPane = splitPane;
window.closePane = closePane;
window.showInlineEditWidget = showInlineEditWidget;
window.closeInlineEdit = closeInlineEdit;
window.generateInlineEdit = generateInlineEdit;
window.regenerateInlineEdit = regenerateInlineEdit;
window.acceptInlineEdit = acceptInlineEdit;
window.setActivePane = setActivePane;
window.state = state;
window.completionState = completionState;
window.rightPanelState = rightPanelState;
window.showRightPanel = showRightPanel;
window.closeRightPanel = closeRightPanel;
window.switchRightPanel = switchRightPanel;
window.moveTerminalToRight = moveTerminalToRight;
window.moveAiChatToRight = moveAiChatToRight;
window.handleRightAiInput = handleRightAiInput;
window.sendRightAiMessage = sendRightAiMessage;
window.toggleToolCallExpand = toggleToolCallExpand;
window.showToolCall = showToolCall;
window.updateToolCall = updateToolCall;

// Browser functions
window.createBrowser = createBrowser;
window.closeBrowserTab = closeBrowserTab;
window.browserBack = browserBack;
window.browserForward = browserForward;
window.browserRefresh = browserRefresh;
window.browserHome = browserHome;
window.browserNavigate = browserNavigate;
window.handleBrowserUrlKeydown = handleBrowserUrlKeydown;
window.handleBrowserLoad = handleBrowserLoad;
window.handleBrowserError = handleBrowserError;
window.setBrowserViewport = setBrowserViewport;
window.toggleBrowserDevTools = toggleBrowserDevTools;
window.switchDevToolsTab = switchDevToolsTab;
window.handleConsoleInput = handleConsoleInput;
window.browserScreenshot = browserScreenshot;
window.openBrowserInPane = openBrowserInPane;

// ============================================
// AGENT MODE - See modules/agent.js
// ============================================

// @ Mention functions
window.showAtAutocomplete = showAtAutocomplete;
window.hideAtAutocomplete = hideAtAutocomplete;
window.selectAtAutocomplete = selectAtAutocomplete;
window.addContextPill = addContextPill;
window.removeContextPill = removeContextPill;
window.mentionContext = mentionContext;

// Agent mode functions exported in modules/agent.js

// Theme functions
window.applyTheme = applyTheme;
window.toggleTheme = toggleTheme;

// Keyboard shortcuts
window.showKeyboardShortcuts = showKeyboardShortcuts;
window.closeKeyboardShortcuts = closeKeyboardShortcuts;

// Tab context menu
window.showTabContextMenu = showTabContextMenu;
window.closeTabContextMenu = closeTabContextMenu;
window.closeOtherTabs = closeOtherTabs;
window.closeTabsToRight = closeTabsToRight;
window.closeAllTabs = closeAllTabs;
window.copyPath = copyPath;
window.revealInExplorer = revealInExplorer;

// Recent files
window.toggleRecentFiles = toggleRecentFiles;
window.renderRecentFiles = renderRecentFiles;

// ============================================
// THEMES MODULE - Custom Theme Import & Management
// ============================================
// Supports VS Code theme format (.json)

const ThemeManager = {
  // Built-in themes
  builtIn: ['clawd-dark', 'clawd-light'],
  
  // Custom themes stored in localStorage
  custom: {},
  
  // Currently active theme
  current: 'clawd-dark',
  
  /**
   * Initialize theme manager
   */
  init() {
    this.loadCustomThemes();
    this.current = localStorage.getItem('clawd-ide-theme') || 'clawd-dark';
    console.log('[Themes] Initialized with', Object.keys(this.custom).length, 'custom themes');
  },
  
  /**
   * Get all available themes
   */
  getAll() {
    return [
      ...this.builtIn.map(id => ({ id, name: this.getDisplayName(id), isBuiltIn: true })),
      ...Object.keys(this.custom).map(id => ({ id, name: this.custom[id].name, isBuiltIn: false }))
    ];
  },
  
  /**
   * Get display name for built-in themes
   */
  getDisplayName(id) {
    const names = {
      'clawd-dark': 'Clawd Dark',
      'clawd-light': 'Clawd Light'
    };
    return names[id] || id;
  },
  
  /**
   * Apply a theme
   */
  apply(themeId) {
    // Built-in theme
    if (this.builtIn.includes(themeId)) {
      if (typeof applyTheme === 'function') {
        applyTheme(themeId);
      } else {
        monaco.editor.setTheme(themeId);
      }
      this.current = themeId;
      localStorage.setItem('clawd-ide-theme', themeId);
      return;
    }
    
    // Custom theme
    const theme = this.custom[themeId];
    if (!theme) {
      console.error('[Themes] Theme not found:', themeId);
      return;
    }
    
    // Register with Monaco if not already
    try {
      monaco.editor.defineTheme(themeId, theme.monacoTheme);
      monaco.editor.setTheme(themeId);
      
      // Apply CSS variables
      this.applyCSSVariables(theme);
      
      this.current = themeId;
      localStorage.setItem('clawd-ide-theme', themeId);
      
      showNotification(`Theme: ${theme.name}`, 'success');
    } catch (err) {
      console.error('[Themes] Failed to apply theme:', err);
      showNotification('Failed to apply theme', 'error');
    }
  },
  
  /**
   * Apply CSS variables from theme
   */
  applyCSSVariables(theme) {
    const root = document.documentElement;
    const colors = theme.colors || {};
    
    // Map VS Code colors to CSS variables
    const mappings = {
      '--bg-primary': colors['editor.background'],
      '--bg-secondary': colors['sideBar.background'] || colors['editor.background'],
      '--bg-hover': colors['list.hoverBackground'],
      '--text-primary': colors['editor.foreground'],
      '--text-secondary': colors['descriptionForeground'] || colors['editor.foreground'],
      '--border': colors['panel.border'] || colors['editorGroup.border'],
      '--accent': colors['focusBorder'] || colors['button.background'],
      '--accent-bg': colors['editor.selectionBackground'],
      '--input-bg': colors['input.background'],
    };
    
    for (const [cssVar, color] of Object.entries(mappings)) {
      if (color) {
        root.style.setProperty(cssVar, color);
      }
    }
    
    // Determine if light or dark
    const bg = colors['editor.background'] || '#1e1e1e';
    const isLight = this.isLightColor(bg);
    
    if (isLight) {
      root.classList.add('theme-light');
    } else {
      root.classList.remove('theme-light');
    }
  },
  
  /**
   * Check if a color is light
   */
  isLightColor(hex) {
    const c = hex.replace('#', '');
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 128;
  },
  
  /**
   * Import a VS Code theme from JSON
   */
  async importTheme(jsonContent, fileName) {
    try {
      const vscodeTheme = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      
      // Validate basic structure
      if (!vscodeTheme.colors && !vscodeTheme.tokenColors) {
        throw new Error('Invalid theme format: missing colors or tokenColors');
      }
      
      // Generate unique ID
      const baseName = vscodeTheme.name || fileName.replace(/\.json$/i, '') || 'Custom Theme';
      let themeId = 'custom-' + baseName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      
      // Avoid duplicates
      let counter = 1;
      while (this.custom[themeId]) {
        themeId = `custom-${baseName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${counter++}`;
      }
      
      // Convert to Monaco format
      const monacoTheme = this.convertToMonaco(vscodeTheme);
      
      // Store theme
      this.custom[themeId] = {
        id: themeId,
        name: baseName,
        colors: vscodeTheme.colors || {},
        monacoTheme: monacoTheme,
        source: fileName
      };
      
      this.saveCustomThemes();
      
      return { id: themeId, name: baseName };
    } catch (err) {
      console.error('[Themes] Import failed:', err);
      throw err;
    }
  },
  
  /**
   * Convert VS Code theme to Monaco theme format
   */
  convertToMonaco(vscodeTheme) {
    const colors = vscodeTheme.colors || {};
    const tokenColors = vscodeTheme.tokenColors || [];
    
    // Determine base theme
    const bg = colors['editor.background'] || '#1e1e1e';
    const base = this.isLightColor(bg) ? 'vs' : 'vs-dark';
    
    // Build Monaco rules from tokenColors
    const rules = [];
    
    for (const tc of tokenColors) {
      if (!tc.settings) continue;
      
      const scopes = Array.isArray(tc.scope) ? tc.scope : (tc.scope ? [tc.scope] : ['']);
      
      for (const scope of scopes) {
        const rule = { token: scope };
        
        if (tc.settings.foreground) {
          rule.foreground = tc.settings.foreground.replace('#', '');
        }
        if (tc.settings.fontStyle) {
          const style = tc.settings.fontStyle;
          if (style.includes('bold')) rule.fontStyle = 'bold';
          if (style.includes('italic')) rule.fontStyle = (rule.fontStyle || '') + ' italic';
          if (style.includes('underline')) rule.fontStyle = (rule.fontStyle || '') + ' underline';
        }
        
        if (rule.foreground || rule.fontStyle) {
          rules.push(rule);
        }
      }
    }
    
    // Build Monaco colors
    const monacoColors = {};
    
    // Map common VS Code colors to Monaco
    const colorMappings = {
      'editor.background': 'editor.background',
      'editor.foreground': 'editor.foreground',
      'editor.lineHighlightBackground': 'editor.lineHighlightBackground',
      'editor.selectionBackground': 'editor.selectionBackground',
      'editor.inactiveSelectionBackground': 'editor.inactiveSelectionBackground',
      'editorCursor.foreground': 'editorCursor.foreground',
      'editorWhitespace.foreground': 'editorWhitespace.foreground',
      'editorIndentGuide.background': 'editorIndentGuide.background',
      'editorLineNumber.foreground': 'editorLineNumber.foreground',
      'editorLineNumber.activeForeground': 'editorLineNumber.activeForeground',
      'editorGutter.background': 'editorGutter.background',
      'editorError.foreground': 'editorError.foreground',
      'editorWarning.foreground': 'editorWarning.foreground',
      'editorWidget.background': 'editorWidget.background',
      'editorWidget.border': 'editorWidget.border',
      'editorSuggestWidget.background': 'editorSuggestWidget.background',
      'editorSuggestWidget.border': 'editorSuggestWidget.border',
      'editorSuggestWidget.foreground': 'editorSuggestWidget.foreground',
      'editorSuggestWidget.selectedBackground': 'editorSuggestWidget.selectedBackground',
      'editorHoverWidget.background': 'editorHoverWidget.background',
      'editorHoverWidget.border': 'editorHoverWidget.border',
      'minimap.background': 'minimap.background',
      'scrollbar.shadow': 'scrollbar.shadow',
      'scrollbarSlider.background': 'scrollbarSlider.background',
      'scrollbarSlider.hoverBackground': 'scrollbarSlider.hoverBackground',
      'scrollbarSlider.activeBackground': 'scrollbarSlider.activeBackground',
    };
    
    for (const [vscode, monaco] of Object.entries(colorMappings)) {
      if (colors[vscode]) {
        monacoColors[monaco] = colors[vscode];
      }
    }
    
    return {
      base: base,
      inherit: true,
      rules: rules,
      colors: monacoColors
    };
  },
  
  /**
   * Delete a custom theme
   */
  deleteTheme(themeId) {
    if (this.builtIn.includes(themeId)) {
      showNotification('Cannot delete built-in themes', 'error');
      return false;
    }
    
    if (!this.custom[themeId]) {
      return false;
    }
    
    delete this.custom[themeId];
    this.saveCustomThemes();
    
    // Switch to default if this was active
    if (this.current === themeId) {
      this.apply('clawd-dark');
    }
    
    return true;
  },
  
  /**
   * Save custom themes to localStorage
   */
  saveCustomThemes() {
    localStorage.setItem('clawd-ide-custom-themes', JSON.stringify(this.custom));
  },
  
  /**
   * Load custom themes from localStorage
   */
  loadCustomThemes() {
    try {
      this.custom = JSON.parse(localStorage.getItem('clawd-ide-custom-themes') || '{}');
      
      // Re-register custom themes with Monaco
      for (const [id, theme] of Object.entries(this.custom)) {
        try {
          monaco.editor.defineTheme(id, theme.monacoTheme);
        } catch (e) {
          console.warn('[Themes] Failed to register theme:', id, e);
        }
      }
    } catch (e) {
      this.custom = {};
    }
  },
  
  /**
   * Export a theme as JSON
   */
  exportTheme(themeId) {
    const theme = this.custom[themeId];
    if (!theme) return null;
    
    return JSON.stringify({
      name: theme.name,
      colors: theme.colors,
      tokenColors: [] // Would need to reverse-engineer from monacoTheme.rules
    }, null, 2);
  }
};

// ============================================
// THEME IMPORT UI
// ============================================

function showThemeImporter() {
  const existing = document.querySelector('.theme-importer-modal');
  if (existing) existing.remove();
  
  const themes = ThemeManager.getAll();
  
  const modal = document.createElement('div');
  modal.className = 'theme-importer-modal';
  modal.innerHTML = `
    <div class="theme-importer-content">
      <div class="theme-importer-header">
        <h2>🎨 Theme Manager</h2>
        <button class="btn-close" onclick="closeThemeImporter()">×</button>
      </div>
      
      <div class="theme-importer-body">
        <!-- Import Section -->
        <div class="theme-section">
          <h3>Import VS Code Theme</h3>
          <div class="theme-import-zone" id="themeDropZone">
            <input type="file" id="themeFileInput" accept=".json" style="display:none" onchange="handleThemeFileSelect(event)">
            <p>📁 Drop a VS Code theme JSON file here</p>
            <p class="hint">or <a href="#" onclick="document.getElementById('themeFileInput').click(); return false;">browse files</a></p>
          </div>
          <div class="theme-url-import">
            <input type="text" id="themeUrlInput" placeholder="Or paste theme JSON URL...">
            <button onclick="importThemeFromUrl()">Import</button>
          </div>
        </div>
        
        <!-- Installed Themes -->
        <div class="theme-section">
          <h3>Installed Themes</h3>
          <div class="theme-list" id="themeList">
            ${themes.map(t => `
              <div class="theme-item ${t.id === ThemeManager.current ? 'active' : ''}" data-id="${t.id}">
                <span class="theme-name">${escapeHtml(t.name)}</span>
                ${t.isBuiltIn ? '<span class="theme-badge">Built-in</span>' : ''}
                <div class="theme-actions">
                  <button onclick="ThemeManager.apply('${t.id}')" title="Apply">✓</button>
                  ${!t.isBuiltIn ? `<button onclick="deleteCustomTheme('${t.id}')" title="Delete">🗑</button>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        
        <!-- Popular Themes -->
        <div class="theme-section">
          <h3>Popular Themes</h3>
          <div class="popular-themes">
            <button class="popular-theme" onclick="importPopularTheme('dracula')">🧛 Dracula</button>
            <button class="popular-theme" onclick="importPopularTheme('nord')">❄️ Nord</button>
            <button class="popular-theme" onclick="importPopularTheme('monokai')">🎨 Monokai</button>
            <button class="popular-theme" onclick="importPopularTheme('solarized-dark')">☀️ Solarized Dark</button>
            <button class="popular-theme" onclick="importPopularTheme('github-dark')">🐙 GitHub Dark</button>
            <button class="popular-theme" onclick="importPopularTheme('one-dark')">🌙 One Dark Pro</button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Setup drag & drop
  const dropZone = document.getElementById('themeDropZone');
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) {
      importThemeFromFile(file);
    } else {
      showNotification('Please drop a .json theme file', 'error');
    }
  });
}

function closeThemeImporter() {
  document.querySelector('.theme-importer-modal')?.remove();
}

function handleThemeFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    importThemeFromFile(file);
  }
}

async function importThemeFromFile(file) {
  try {
    const content = await file.text();
    const result = await ThemeManager.importTheme(content, file.name);
    
    showNotification(`Imported theme: ${result.name}`, 'success');
    ThemeManager.apply(result.id);
    
    // Refresh the theme list
    showThemeImporter();
  } catch (err) {
    showNotification(`Import failed: ${err.message}`, 'error');
  }
}

async function importThemeFromUrl() {
  const url = document.getElementById('themeUrlInput')?.value?.trim();
  if (!url) {
    showNotification('Please enter a URL', 'error');
    return;
  }
  
  try {
    showNotification('Fetching theme...', 'info');
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const content = await res.text();
    const fileName = url.split('/').pop() || 'imported-theme.json';
    
    const result = await ThemeManager.importTheme(content, fileName);
    
    showNotification(`Imported theme: ${result.name}`, 'success');
    ThemeManager.apply(result.id);
    
    showThemeImporter();
  } catch (err) {
    showNotification(`Import failed: ${err.message}`, 'error');
  }
}

// Popular theme definitions (simplified versions)
const popularThemes = {
  'dracula': {
    name: 'Dracula',
    colors: {
      'editor.background': '#282a36',
      'editor.foreground': '#f8f8f2',
      'editor.selectionBackground': '#44475a',
      'editor.lineHighlightBackground': '#44475a',
      'editorCursor.foreground': '#f8f8f2',
      'editorLineNumber.foreground': '#6272a4',
      'sideBar.background': '#21222c',
      'panel.border': '#44475a',
      'focusBorder': '#bd93f9',
      'button.background': '#bd93f9',
      'input.background': '#21222c'
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#6272a4' } },
      { scope: 'string', settings: { foreground: '#f1fa8c' } },
      { scope: 'keyword', settings: { foreground: '#ff79c6' } },
      { scope: 'variable', settings: { foreground: '#f8f8f2' } },
      { scope: 'entity.name.function', settings: { foreground: '#50fa7b' } },
      { scope: 'constant.numeric', settings: { foreground: '#bd93f9' } },
      { scope: 'entity.name.type', settings: { foreground: '#8be9fd', fontStyle: 'italic' } },
      { scope: 'storage.type', settings: { foreground: '#ff79c6' } },
      { scope: 'support.function', settings: { foreground: '#8be9fd' } }
    ]
  },
  'nord': {
    name: 'Nord',
    colors: {
      'editor.background': '#2e3440',
      'editor.foreground': '#d8dee9',
      'editor.selectionBackground': '#434c5e',
      'editor.lineHighlightBackground': '#3b4252',
      'editorCursor.foreground': '#d8dee9',
      'editorLineNumber.foreground': '#4c566a',
      'sideBar.background': '#2e3440',
      'panel.border': '#3b4252',
      'focusBorder': '#88c0d0',
      'button.background': '#5e81ac',
      'input.background': '#3b4252'
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#616e88' } },
      { scope: 'string', settings: { foreground: '#a3be8c' } },
      { scope: 'keyword', settings: { foreground: '#81a1c1' } },
      { scope: 'variable', settings: { foreground: '#d8dee9' } },
      { scope: 'entity.name.function', settings: { foreground: '#88c0d0' } },
      { scope: 'constant.numeric', settings: { foreground: '#b48ead' } },
      { scope: 'entity.name.type', settings: { foreground: '#8fbcbb' } },
      { scope: 'storage.type', settings: { foreground: '#81a1c1' } }
    ]
  },
  'monokai': {
    name: 'Monokai',
    colors: {
      'editor.background': '#272822',
      'editor.foreground': '#f8f8f2',
      'editor.selectionBackground': '#49483e',
      'editor.lineHighlightBackground': '#3e3d32',
      'editorCursor.foreground': '#f8f8f0',
      'editorLineNumber.foreground': '#90908a',
      'sideBar.background': '#1e1f1c',
      'panel.border': '#3e3d32',
      'focusBorder': '#a6e22e',
      'button.background': '#a6e22e',
      'input.background': '#1e1f1c'
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#75715e' } },
      { scope: 'string', settings: { foreground: '#e6db74' } },
      { scope: 'keyword', settings: { foreground: '#f92672' } },
      { scope: 'variable', settings: { foreground: '#f8f8f2' } },
      { scope: 'entity.name.function', settings: { foreground: '#a6e22e' } },
      { scope: 'constant.numeric', settings: { foreground: '#ae81ff' } },
      { scope: 'entity.name.type', settings: { foreground: '#66d9ef', fontStyle: 'italic' } },
      { scope: 'storage.type', settings: { foreground: '#66d9ef' } }
    ]
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    colors: {
      'editor.background': '#002b36',
      'editor.foreground': '#839496',
      'editor.selectionBackground': '#073642',
      'editor.lineHighlightBackground': '#073642',
      'editorCursor.foreground': '#839496',
      'editorLineNumber.foreground': '#586e75',
      'sideBar.background': '#00212b',
      'panel.border': '#073642',
      'focusBorder': '#268bd2',
      'button.background': '#268bd2',
      'input.background': '#073642'
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#586e75' } },
      { scope: 'string', settings: { foreground: '#2aa198' } },
      { scope: 'keyword', settings: { foreground: '#859900' } },
      { scope: 'variable', settings: { foreground: '#839496' } },
      { scope: 'entity.name.function', settings: { foreground: '#268bd2' } },
      { scope: 'constant.numeric', settings: { foreground: '#d33682' } },
      { scope: 'entity.name.type', settings: { foreground: '#b58900' } },
      { scope: 'storage.type', settings: { foreground: '#859900' } }
    ]
  },
  'github-dark': {
    name: 'GitHub Dark',
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#c9d1d9',
      'editor.selectionBackground': '#264f78',
      'editor.lineHighlightBackground': '#161b22',
      'editorCursor.foreground': '#c9d1d9',
      'editorLineNumber.foreground': '#6e7681',
      'sideBar.background': '#010409',
      'panel.border': '#30363d',
      'focusBorder': '#58a6ff',
      'button.background': '#238636',
      'input.background': '#0d1117'
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#8b949e' } },
      { scope: 'string', settings: { foreground: '#a5d6ff' } },
      { scope: 'keyword', settings: { foreground: '#ff7b72' } },
      { scope: 'variable', settings: { foreground: '#c9d1d9' } },
      { scope: 'entity.name.function', settings: { foreground: '#d2a8ff' } },
      { scope: 'constant.numeric', settings: { foreground: '#79c0ff' } },
      { scope: 'entity.name.type', settings: { foreground: '#ffa657' } },
      { scope: 'storage.type', settings: { foreground: '#ff7b72' } }
    ]
  },
  'one-dark': {
    name: 'One Dark Pro',
    colors: {
      'editor.background': '#282c34',
      'editor.foreground': '#abb2bf',
      'editor.selectionBackground': '#3e4451',
      'editor.lineHighlightBackground': '#2c313a',
      'editorCursor.foreground': '#528bff',
      'editorLineNumber.foreground': '#495162',
      'sideBar.background': '#21252b',
      'panel.border': '#181a1f',
      'focusBorder': '#528bff',
      'button.background': '#404754',
      'input.background': '#1d1f23'
    },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#5c6370', fontStyle: 'italic' } },
      { scope: 'string', settings: { foreground: '#98c379' } },
      { scope: 'keyword', settings: { foreground: '#c678dd' } },
      { scope: 'variable', settings: { foreground: '#e06c75' } },
      { scope: 'entity.name.function', settings: { foreground: '#61afef' } },
      { scope: 'constant.numeric', settings: { foreground: '#d19a66' } },
      { scope: 'entity.name.type', settings: { foreground: '#e5c07b' } },
      { scope: 'storage.type', settings: { foreground: '#c678dd' } }
    ]
  }
};

async function importPopularTheme(themeKey) {
  const theme = popularThemes[themeKey];
  if (!theme) {
    showNotification('Theme not found', 'error');
    return;
  }
  
  try {
    const result = await ThemeManager.importTheme(theme, themeKey + '.json');
    showNotification(`Imported theme: ${result.name}`, 'success');
    ThemeManager.apply(result.id);
    showThemeImporter();
  } catch (err) {
    showNotification(`Import failed: ${err.message}`, 'error');
  }
}

function deleteCustomTheme(themeId) {
  if (confirm('Delete this theme?')) {
    ThemeManager.deleteTheme(themeId);
    showNotification('Theme deleted', 'info');
    showThemeImporter();
  }
}

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================
// EXPORTS
// ============================================

window.ThemeManager = ThemeManager;
window.showThemeImporter = showThemeImporter;
window.closeThemeImporter = closeThemeImporter;
window.handleThemeFileSelect = handleThemeFileSelect;
window.importThemeFromUrl = importThemeFromUrl;
window.importPopularTheme = importPopularTheme;
window.deleteCustomTheme = deleteCustomTheme;

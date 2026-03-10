// HMI Customization Engine
//
// Runtime engine that listens for customization events (from chatbot,
// scene buttons, theme switches) and applies actual visual changes
// to the HMI dashboard by modifying CSS custom properties, classes,
// and DOM attributes.
//
// Usage: Inline this script in the generated HTML after chatbot-widget.js,
// then call HMIEngine.init();
(function (root) {
  'use strict';

  var STORAGE_KEY = 'openclaw-hmi-preferences';

  // -------------------------------------------------------------------------
  // Style Direction Presets
  // -------------------------------------------------------------------------
  // Each style direction maps to CSS custom property overrides that affect
  // spacing rhythm, typography emphasis, card visual weight, icon prominence.

  var STYLE_PRESETS = {
    minimal: {
      '--style-card-shadow': '0 1px 3px rgba(0,0,0,0.06)',
      '--style-card-border': '1px solid rgba(0,0,0,0.06)',
      '--style-font-weight-heading': '400',
      '--style-icon-size': '20px',
      '--style-card-bg-opacity': '0.02',
      '--style-accent-intensity': '0.6',
      '--style-border-width': '0px',
    },
    premium: {
      '--style-card-shadow': '0 4px 16px rgba(0,0,0,0.12)',
      '--style-card-border': '1px solid rgba(255,255,255,0.08)',
      '--style-font-weight-heading': '600',
      '--style-icon-size': '22px',
      '--style-card-bg-opacity': '0.05',
      '--style-accent-intensity': '0.8',
      '--style-border-width': '0px',
    },
    sporty: {
      '--style-card-shadow': '0 4px 20px rgba(255,109,0,0.15)',
      '--style-card-border': '2px solid var(--color-accent, #FF6D00)',
      '--style-font-weight-heading': '700',
      '--style-icon-size': '26px',
      '--style-card-bg-opacity': '0.08',
      '--style-accent-intensity': '1.0',
      '--style-border-width': '2px',
    },
    tech: {
      '--style-card-shadow': '0 2px 8px rgba(26,115,232,0.1)',
      '--style-card-border': '1px solid rgba(26,115,232,0.2)',
      '--style-font-weight-heading': '500',
      '--style-icon-size': '22px',
      '--style-card-bg-opacity': '0.04',
      '--style-accent-intensity': '0.9',
      '--style-border-width': '1px',
    },
    calm: {
      '--style-card-shadow': '0 2px 12px rgba(0,0,0,0.06)',
      '--style-card-border': '1px solid rgba(0,0,0,0.04)',
      '--style-font-weight-heading': '400',
      '--style-icon-size': '20px',
      '--style-card-bg-opacity': '0.02',
      '--style-accent-intensity': '0.5',
      '--style-border-width': '0px',
    },
    elegant: {
      '--style-card-shadow': '0 6px 24px rgba(0,0,0,0.1)',
      '--style-card-border': '1px solid rgba(0,0,0,0.08)',
      '--style-font-weight-heading': '500',
      '--style-icon-size': '22px',
      '--style-card-bg-opacity': '0.03',
      '--style-accent-intensity': '0.7',
      '--style-border-width': '0px',
    },
  };

  // -------------------------------------------------------------------------
  // Layout Density Presets
  // -------------------------------------------------------------------------

  var DENSITY_PRESETS = {
    compact: {
      '--density-grid-gap': '8px',
      '--density-card-padding': '10px',
      '--density-section-gap': '8px',
      '--density-widget-scale': '0.95',
    },
    balanced: {
      '--density-grid-gap': '16px',
      '--density-card-padding': '16px',
      '--density-section-gap': '16px',
      '--density-widget-scale': '1.0',
    },
    spacious: {
      '--density-grid-gap': '24px',
      '--density-card-padding': '24px',
      '--density-section-gap': '24px',
      '--density-widget-scale': '1.0',
    },
  };

  // -------------------------------------------------------------------------
  // Motion Intensity Presets
  // -------------------------------------------------------------------------

  var MOTION_PRESETS = {
    low: {
      '--motion-duration': '150ms',
      '--motion-easing': 'ease-out',
      '--motion-hover-scale': '1.01',
    },
    medium: {
      '--motion-duration': '300ms',
      '--motion-easing': 'cubic-bezier(0.4, 0, 0.2, 1)',
      '--motion-hover-scale': '1.03',
    },
  };

  // -------------------------------------------------------------------------
  // Scene Mode Presets (affects widget priority and style hints)
  // -------------------------------------------------------------------------

  var SCENE_PRESETS = {
    commute: {
      priority: ['navigation', 'music', 'notification', 'weather'],
      themeHint: null,
      styleHint: null,
    },
    relax: {
      priority: ['music', 'weather', 'suggestions', 'calendar'],
      themeHint: null,
      styleHint: 'calm',
    },
    sport: {
      priority: ['vehicle-status', 'energy', 'navigation', 'trip'],
      themeHint: null,
      styleHint: 'sporty',
    },
    rest: {
      priority: ['clock', 'weather', 'notification', 'calendar'],
      themeHint: 'night',
      styleHint: 'calm',
    },
    workout: {
      priority: ['music', 'clock', 'energy', 'trip'],
      themeHint: null,
      styleHint: 'sporty',
    },
    'night-driving': {
      priority: ['navigation', 'vehicle-status', 'music', 'toggle'],
      themeHint: 'night',
      styleHint: 'tech',
    },
  };

  // -------------------------------------------------------------------------
  // Current state
  // -------------------------------------------------------------------------

  var currentState = {
    styleDirection: 'minimal',
    layoutDensity: 'balanced',
    infoEmphasis: 'icon-first',
    themeMode: 'day',
    motionIntensity: 'medium',
    sceneMode: null,
    screenMode: 'normal',
  };

  // -------------------------------------------------------------------------
  // Apply Functions
  // -------------------------------------------------------------------------

  function _applyStyleDirection(direction) {
    var preset = STYLE_PRESETS[direction];
    if (!preset) return;
    currentState.styleDirection = direction;

    var root = document.documentElement;
    Object.keys(preset).forEach(function (prop) {
      root.style.setProperty(prop, preset[prop]);
    });

    // Apply data attribute for CSS selector targeting
    root.setAttribute('data-style', direction);

    // Update widget cards visual weight
    var widgets = document.querySelectorAll('.hmi-widget');
    widgets.forEach(function (w) {
      w.style.boxShadow = 'var(--style-card-shadow)';
      w.style.border = 'var(--style-card-border)';
      w.style.fontWeight = 'var(--style-font-weight-heading)';
    });

    // Update icons size
    var icons = document.querySelectorAll('.hmi-widget svg, .hmi-widget .widget-icon');
    icons.forEach(function (icon) {
      icon.style.width = 'var(--style-icon-size)';
      icon.style.height = 'var(--style-icon-size)';
    });
  }

  function _applyLayoutDensity(density) {
    var preset = DENSITY_PRESETS[density];
    if (!preset) return;
    currentState.layoutDensity = density;

    var root = document.documentElement;
    Object.keys(preset).forEach(function (prop) {
      root.style.setProperty(prop, preset[prop]);
    });
    root.setAttribute('data-density', density);

    // Apply to grid
    var grid = document.querySelector('.hmi-grid, .hmi-widget-grid, [class*="grid"]');
    if (grid) {
      grid.style.gap = 'var(--density-grid-gap)';
    }

    // Apply to widget cards
    var widgets = document.querySelectorAll('.hmi-widget');
    widgets.forEach(function (w) {
      w.style.padding = 'var(--density-card-padding)';
    });
  }

  function _applyInfoEmphasis(emphasis) {
    currentState.infoEmphasis = emphasis;
    document.documentElement.setAttribute('data-emphasis', emphasis);

    // Adjust visual hierarchy within widgets
    var widgets = document.querySelectorAll('.hmi-widget');
    widgets.forEach(function (w) {
      // Reset emphasis classes
      w.classList.remove('emphasis-icon', 'emphasis-label', 'emphasis-control', 'emphasis-status');
      w.classList.add('emphasis-' + emphasis.replace('-first', ''));
    });
  }

  function _applyThemeMode(mode) {
    currentState.themeMode = mode;

    if (mode === 'auto') {
      var hour = new Date().getHours();
      mode = (hour >= 18 || hour < 6) ? 'night' : 'day';
    }

    document.documentElement.setAttribute('data-theme', mode);

    // Update scene bar active states for theme awareness
    var sceneButtons = document.querySelectorAll('.hmi-scene-btn');
    sceneButtons.forEach(function (btn) {
      // Night driving button gets highlighted in night mode
      if (btn.getAttribute('data-scene') === 'night-driving' && mode === 'night') {
        btn.style.opacity = '1';
      }
    });
  }

  function _applyMotionIntensity(intensity) {
    var preset = MOTION_PRESETS[intensity];
    if (!preset) return;
    currentState.motionIntensity = intensity;

    var root = document.documentElement;
    Object.keys(preset).forEach(function (prop) {
      root.style.setProperty(prop, preset[prop]);
    });

    // Override the base animation duration
    root.style.setProperty('--animation-duration', preset['--motion-duration']);
    root.style.setProperty('--animation-easing', preset['--motion-easing']);

    // Apply hover scale to widgets
    var style = document.getElementById('hmi-motion-overrides');
    if (!style) {
      style = document.createElement('style');
      style.id = 'hmi-motion-overrides';
      document.head.appendChild(style);
    }
    style.textContent =
      '.hmi-widget { transition: transform ' + preset['--motion-duration'] + ' ' + preset['--motion-easing'] + ', box-shadow ' + preset['--motion-duration'] + ' ' + preset['--motion-easing'] + '; }' +
      '.hmi-widget:hover { transform: scale(' + preset['--motion-hover-scale'] + '); }';
  }

  function _applySceneMode(sceneMode) {
    var preset = SCENE_PRESETS[sceneMode];
    if (!preset) return;
    currentState.sceneMode = sceneMode;

    document.documentElement.setAttribute('data-scene', sceneMode);

    // Update scene buttons
    var buttons = document.querySelectorAll('.hmi-scene-btn');
    buttons.forEach(function (btn) {
      btn.classList.remove('hmi-scene-btn--active');
      if (btn.getAttribute('data-scene') === sceneMode) {
        btn.classList.add('hmi-scene-btn--active');
      }
    });

    // Apply scene's style hint (if any)
    if (preset.styleHint && STYLE_PRESETS[preset.styleHint]) {
      _applyStyleDirection(preset.styleHint);
    }

    // Apply scene's theme hint (if any)
    if (preset.themeHint) {
      _applyThemeMode(preset.themeHint);
    }

    // Reorder widgets based on priority
    var grid = document.querySelector('.hmi-grid, .hmi-widget-grid, [class*="grid"]');
    if (grid && preset.priority) {
      var widgets = Array.prototype.slice.call(grid.querySelectorAll('.hmi-widget'));
      var ordered = [];
      var remaining = [];

      // Sort: priority widgets first, then others
      preset.priority.forEach(function (type) {
        widgets.forEach(function (w) {
          if (w.getAttribute('data-widget-type') === type && ordered.indexOf(w) === -1) {
            ordered.push(w);
          }
        });
      });
      widgets.forEach(function (w) {
        if (ordered.indexOf(w) === -1) remaining.push(w);
      });

      // Re-append in order (preserves all event listeners)
      ordered.concat(remaining).forEach(function (w) {
        grid.appendChild(w);
      });
    }

    _saveState();
  }

  function _applyScreenMode(screenMode) {
    currentState.screenMode = screenMode;

    var grid = document.querySelector('.hmi-grid, .hmi-widget-grid, [class*="grid"]');
    var editOverlay = document.querySelector('.hmi-edit-overlay, .hmi-grid-overlay');
    var editToolbar = document.querySelector('.hmi-edit-toolbar');

    if (screenMode === 'edit') {
      document.documentElement.setAttribute('data-screen-mode', 'edit');
      if (grid) {
        grid.classList.add('hmi-grid--edit-mode');
        grid.style.transform = 'scale(0.85)';
        grid.style.transformOrigin = 'top center';
      }
      if (editOverlay) editOverlay.style.display = 'block';
      if (editToolbar) editToolbar.style.display = 'flex';
      // Show drag handles
      document.querySelectorAll('.hmi-edit-drag-handle').forEach(function (h) {
        h.style.display = 'flex';
      });
    } else {
      document.documentElement.setAttribute('data-screen-mode', 'normal');
      if (grid) {
        grid.classList.remove('hmi-grid--edit-mode');
        grid.style.transform = '';
      }
      if (editOverlay) editOverlay.style.display = 'none';
      if (editToolbar) editToolbar.style.display = 'none';
      document.querySelectorAll('.hmi-edit-drag-handle').forEach(function (h) {
        h.style.display = 'none';
      });
    }
  }

  // -------------------------------------------------------------------------
  // Master Apply — handles any customization params object
  // -------------------------------------------------------------------------

  function _applyCustomization(params) {
    if (!params) return;

    if (params.styleDirection) _applyStyleDirection(params.styleDirection);
    if (params.layoutDensity) _applyLayoutDensity(params.layoutDensity);
    if (params.infoEmphasis) _applyInfoEmphasis(params.infoEmphasis);
    if (params.themeMode) _applyThemeMode(params.themeMode);
    if (params.motionIntensity) _applyMotionIntensity(params.motionIntensity);
    if (params.sceneMode) _applySceneMode(params.sceneMode);
    if (params.screenMode) _applyScreenMode(params.screenMode);

    _saveState();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function _saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
    } catch (e) {}
  }

  function _loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(saved).forEach(function (k) {
          if (currentState.hasOwnProperty(k) && saved[k] != null) {
            currentState[k] = saved[k];
          }
        });
      }
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // Event Binding
  // -------------------------------------------------------------------------

  function _bindEvents() {
    // Listen for chatbot customization events
    document.addEventListener('hmi-customization', function (e) {
      _applyCustomization(e.detail);
    });

    // Listen for design scheme updates
    document.addEventListener('hmi-scheme-update', function (e) {
      if (e.detail && e.detail.scheme) {
        _applyDesignScheme(e.detail.scheme);
      }
    });

    // Bind scene mode buttons
    document.querySelectorAll('.hmi-scene-btn, [data-scene]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var scene = this.getAttribute('data-scene');
        if (scene) _applySceneMode(scene);
      });
    });

    // Bind theme toggle if present
    document.querySelectorAll('[data-theme-toggle], .hmi-theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = currentState.themeMode === 'day' ? 'night' : 'day';
        _applyThemeMode(next);
        _saveState();
      });
    });

    // Bind edit mode toggle if present
    document.querySelectorAll('[data-edit-toggle], .hmi-edit-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = currentState.screenMode === 'normal' ? 'edit' : 'normal';
        _applyScreenMode(next);
        _saveState();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Design Scheme Application
  // -------------------------------------------------------------------------

  function _applyDesignScheme(scheme) {
    if (!scheme || !scheme.tokens) return;
    var root = document.documentElement;

    // Map tokens to CSS custom properties
    var colors = scheme.tokens.colors || {};
    if (colors.primary) root.style.setProperty('--color-primary', colors.primary);
    if (colors.secondary) root.style.setProperty('--color-secondary', colors.secondary);
    if (colors.surface) root.style.setProperty('--color-surface', colors.surface);
    if (colors.surfaceDark) root.style.setProperty('--color-surface-dark', colors.surfaceDark);
    if (colors.accent) root.style.setProperty('--color-accent', colors.accent);
    if (colors.text) {
      if (colors.text.primary) root.style.setProperty('--color-text-primary', colors.text.primary);
      if (colors.text.secondary) root.style.setProperty('--color-text-secondary', colors.text.secondary);
      if (colors.text.disabled) root.style.setProperty('--color-text-disabled', colors.text.disabled);
    }
    if (colors.status) {
      if (colors.status.success) root.style.setProperty('--color-status-success', colors.status.success);
      if (colors.status.warning) root.style.setProperty('--color-status-warning', colors.status.warning);
      if (colors.status.error) root.style.setProperty('--color-status-error', colors.status.error);
    }

    var typo = scheme.tokens.typography || {};
    if (typo.fontFamily) root.style.setProperty('--font-family', typo.fontFamily);
    if (typo.scale) {
      Object.keys(typo.scale).forEach(function (k) {
        root.style.setProperty('--font-' + k, typo.scale[k]);
      });
    }
    if (typo.weight) {
      Object.keys(typo.weight).forEach(function (k) {
        root.style.setProperty('--font-weight-' + k, typo.weight[k]);
      });
    }

    var spacing = scheme.tokens.spacing || {};
    Object.keys(spacing).forEach(function (k) {
      root.style.setProperty('--spacing-' + k, spacing[k]);
    });

    var radius = scheme.tokens.radius || {};
    Object.keys(radius).forEach(function (k) {
      root.style.setProperty('--radius-' + k, radius[k]);
    });

    var elevation = scheme.tokens.elevation || {};
    Object.keys(elevation).forEach(function (k) {
      root.style.setProperty('--elevation-' + k, elevation[k]);
    });

    // Apply theme overrides
    if (scheme.themes) {
      if (scheme.themes.light) {
        root.style.setProperty('--theme-light-bg', scheme.themes.light.background || '');
        root.style.setProperty('--theme-light-text', scheme.themes.light.text || '');
      }
      if (scheme.themes.dark) {
        root.style.setProperty('--theme-dark-bg', scheme.themes.dark.background || '');
        root.style.setProperty('--theme-dark-text', scheme.themes.dark.text || '');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Inline CSS for engine-specific styles
  // -------------------------------------------------------------------------

  function _injectEngineStyles() {
    var css = [
      // Style direction effects on widgets
      '[data-style="sporty"] .hmi-widget { border-color: var(--color-accent, #FF6D00); }',
      '[data-style="sporty"] .hmi-widget .widget-title, [data-style="sporty"] .hmi-widget h3 { color: var(--color-accent, #FF6D00); }',
      '[data-style="minimal"] .hmi-widget { border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }',
      '[data-style="premium"] .hmi-widget { box-shadow: 0 4px 16px rgba(0,0,0,0.12); }',
      '[data-style="tech"] .hmi-widget { border-color: var(--color-primary, #1A73E8); }',

      // Info emphasis
      '[data-emphasis="icon"] .hmi-widget svg, [data-emphasis="icon"] .widget-icon { transform: scale(1.3); }',
      '[data-emphasis="icon"] .hmi-widget .widget-label { font-size: var(--font-caption, 12px); }',
      '[data-emphasis="label"] .hmi-widget .widget-label, [data-emphasis="label"] .hmi-widget h3 { font-size: var(--font-h2, 22px); font-weight: var(--font-weight-bold, 700); }',
      '[data-emphasis="label"] .hmi-widget svg { transform: scale(0.8); }',
      '[data-emphasis="control"] .hmi-widget button, [data-emphasis="control"] .hmi-widget .widget-control { transform: scale(1.15); }',
      '[data-emphasis="status"] .hmi-widget .widget-status, [data-emphasis="status"] .hmi-widget .widget-value { font-size: var(--font-h2, 22px); font-weight: var(--font-weight-bold, 700); }',

      // Scene mode visual hints
      '[data-scene="sport"] .hmi-widget { transition: transform 150ms ease-out; }',
      '[data-scene="sport"] .hmi-widget:hover { transform: scale(1.04); }',
      '[data-scene="rest"] .hmi-widget { opacity: 0.9; }',
      '[data-scene="night-driving"] .hmi-widget { filter: brightness(0.85); }',

      // Density overrides
      '[data-density="compact"] .hmi-widget { padding: 10px; }',
      '[data-density="spacious"] .hmi-widget { padding: 24px; }',

      // Screen mode
      '[data-screen-mode="edit"] .hmi-widget { cursor: move; outline: 2px dashed rgba(26,115,232,0.3); }',
      '[data-screen-mode="edit"] .hmi-widget:hover { outline-color: var(--color-primary, #1A73E8); }',
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'hmi-engine-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  var HMIEngine = {
    /**
     * Initialize the customization engine.
     * Loads saved state, binds events, applies current customization.
     */
    init: function () {
      _injectEngineStyles();
      _loadState();
      _bindEvents();
      // Apply all saved state on load
      _applyCustomization(currentState);
    },

    /** Apply customization params programmatically. */
    apply: function (params) {
      _applyCustomization(params);
    },

    /** Apply a design scheme. */
    applyScheme: function (scheme) {
      _applyDesignScheme(scheme);
    },

    /** Get current state. */
    getState: function () {
      return JSON.parse(JSON.stringify(currentState));
    },
  };

  root.HMIEngine = HMIEngine;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

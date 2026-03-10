/**
 * HMI Chatbot Widget
 *
 * Self-contained JavaScript module providing chatbot functionality for the
 * generated HMI HTML page. Supports two communication modes:
 *
 * 1. Canvas mode (primary): Uses OpenClaw Canvas native bridge
 *    (openclawSendUserAction) when HTML is served via Canvas host.
 * 2. Browser mode (fallback): Uses WebSocket to OpenClaw Gateway
 *    when opened directly in a browser.
 *
 * Usage:
 *   HMIChatbot.init({ sessionId, onCustomization, onSchemeUpdate, onMessage });
 *   HMIChatbot.sendMessage('make it sporty');
 *   HMIChatbot.destroy();
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var STORAGE_KEY = 'openclaw-hmi-preferences';
  var SKILL_NAME = 'generative-hmi-custom-ui';

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  var ws = null;
  var config = {};
  var isOpen = false;
  var styleInjected = false;
  var mode = 'unknown'; // 'canvas' | 'browser' | 'unknown'
  var pendingCallbacks = {}; // action-id -> callback
  var callbackIdCounter = 0;

  // DOM references (populated in _buildUI)
  var els = {
    bubble: null,
    panel: null,
    header: null,
    messages: null,
    inputWrap: null,
    input: null,
    sendBtn: null,
    closeBtn: null,
    schemeInput: null,
  };

  // ---------------------------------------------------------------------------
  // CSS (injected once)
  // ---------------------------------------------------------------------------

  var CSS = [
    // Container reset
    '.hmi-chatbot-bubble, .hmi-chatbot-panel, .hmi-chatbot-panel * {',
    '  box-sizing: border-box;',
    '  margin: 0;',
    '  padding: 0;',
    '}',

    // Bubble button
    '.hmi-chatbot-bubble {',
    '  position: fixed;',
    '  bottom: 24px;',
    '  right: 24px;',
    '  width: 56px;',
    '  height: 56px;',
    '  border-radius: 50%;',
    '  background: var(--color-primary, #1A73E8);',
    '  color: var(--color-surface, #FFFFFF);',
    '  border: none;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  box-shadow: var(--elevation-modal, 0 8px 32px rgba(0,0,0,0.2));',
    '  transition: transform var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1)),',
    '              opacity var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1));',
    '  z-index: 10000;',
    '  font-family: var(--font-family, system-ui, sans-serif);',
    '}',
    '.hmi-chatbot-bubble:hover { transform: scale(1.08); }',
    '.hmi-chatbot-bubble:active { transform: scale(0.95); }',
    '.hmi-chatbot-bubble--hidden { transform: scale(0); opacity: 0; pointer-events: none; }',
    '.hmi-chatbot-bubble svg { width: 24px; height: 24px; fill: currentColor; }',

    // Panel
    '.hmi-chatbot-panel {',
    '  position: fixed;',
    '  bottom: 24px;',
    '  right: 24px;',
    '  width: 360px;',
    '  max-height: 480px;',
    '  height: 480px;',
    '  border-radius: var(--radius-lg, 16px);',
    '  background: var(--color-surface, #FFFFFF);',
    '  color: var(--color-text-primary, #202124);',
    '  box-shadow: var(--elevation-modal, 0 8px 32px rgba(0,0,0,0.2));',
    '  display: flex;',
    '  flex-direction: column;',
    '  overflow: hidden;',
    '  z-index: 10001;',
    '  font-family: var(--font-family, system-ui, sans-serif);',
    '  transition: transform var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1)),',
    '              opacity var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1));',
    '  transform-origin: bottom right;',
    '}',
    '.hmi-chatbot-panel--hidden { transform: scale(0.3); opacity: 0; pointer-events: none; }',

    // Dark/night theme
    '[data-theme="night"] .hmi-chatbot-panel { background: var(--color-surface-dark, #1E1E1E); color: var(--theme-text, #E8EAED); }',
    '[data-theme="night"] .hmi-chatbot-header { background: var(--color-surface-dark, #1E1E1E); border-bottom-color: rgba(255,255,255,0.1); }',
    '[data-theme="night"] .hmi-chatbot-messages { background: var(--color-surface-dark, #1E1E1E); }',
    '[data-theme="night"] .hmi-chatbot-input-wrap { background: var(--color-surface-dark, #1E1E1E); border-top-color: rgba(255,255,255,0.1); }',
    '[data-theme="night"] .hmi-chatbot-input { background: rgba(255,255,255,0.08); color: var(--theme-text, #E8EAED); }',
    '[data-theme="night"] .hmi-chatbot-msg--bot { background: rgba(255,255,255,0.08); color: var(--theme-text, #E8EAED); }',
    '[data-theme="night"] .hmi-chatbot-msg--system { color: var(--color-text-secondary, #9AA0A6); }',

    // Header
    '.hmi-chatbot-header {',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);',
    '  background: var(--color-primary, #1A73E8); color: var(--color-surface, #FFFFFF);',
    '  flex-shrink: 0;',
    '}',
    '.hmi-chatbot-header-title { font-size: var(--font-h3, 18px); font-weight: var(--font-weight-medium, 500); }',
    '.hmi-chatbot-header-actions { display: flex; align-items: center; gap: var(--spacing-xs, 4px); }',
    '.hmi-chatbot-header-btn {',
    '  background: none; border: none; color: inherit; cursor: pointer;',
    '  width: 32px; height: 32px; border-radius: 50%;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: background var(--animation-duration, 300ms); font-size: 18px; line-height: 1;',
    '}',
    '.hmi-chatbot-header-btn:hover { background: rgba(255,255,255,0.2); }',

    // Messages
    '.hmi-chatbot-messages {',
    '  flex: 1; overflow-y: auto; padding: var(--spacing-sm, 8px);',
    '  display: flex; flex-direction: column; gap: var(--spacing-sm, 8px);',
    '  background: var(--color-surface, #FFFFFF);',
    '}',
    '.hmi-chatbot-msg {',
    '  max-width: 85%; padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);',
    '  border-radius: var(--radius-md, 12px); font-size: var(--font-body, 14px);',
    '  line-height: 1.5; word-wrap: break-word; white-space: pre-wrap;',
    '}',
    '.hmi-chatbot-msg--user { align-self: flex-end; background: var(--color-primary, #1A73E8); color: var(--color-surface, #FFFFFF); border-bottom-right-radius: var(--spacing-xs, 4px); }',
    '.hmi-chatbot-msg--bot { align-self: flex-start; background: rgba(0,0,0,0.06); color: var(--color-text-primary, #202124); border-bottom-left-radius: var(--spacing-xs, 4px); }',
    '.hmi-chatbot-msg--system { align-self: center; background: none; color: var(--color-text-secondary, #5F6368); font-size: var(--font-caption, 12px); text-align: center; padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px); }',

    // Typing indicator
    '.hmi-chatbot-typing { align-self: flex-start; display: flex; gap: 4px; padding: var(--spacing-sm, 8px) var(--spacing-md, 16px); background: rgba(0,0,0,0.06); border-radius: var(--radius-md, 12px); border-bottom-left-radius: var(--spacing-xs, 4px); }',
    '.hmi-chatbot-typing-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-text-secondary, #5F6368); animation: hmi-chatbot-bounce 1.4s ease-in-out infinite; }',
    '.hmi-chatbot-typing-dot:nth-child(2) { animation-delay: 0.2s; }',
    '.hmi-chatbot-typing-dot:nth-child(3) { animation-delay: 0.4s; }',
    '@keyframes hmi-chatbot-bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }',

    // Input
    '.hmi-chatbot-input-wrap { display: flex; align-items: center; gap: var(--spacing-sm, 8px); padding: var(--spacing-sm, 8px); border-top: 1px solid rgba(0,0,0,0.08); flex-shrink: 0; background: var(--color-surface, #FFFFFF); }',
    '.hmi-chatbot-input { flex: 1; border: 1px solid rgba(0,0,0,0.12); border-radius: var(--radius-pill, 999px); padding: var(--spacing-sm, 8px) var(--spacing-md, 16px); font-size: var(--font-body, 14px); font-family: var(--font-family, system-ui, sans-serif); outline: none; background: rgba(0,0,0,0.03); color: var(--color-text-primary, #202124); transition: border-color var(--animation-duration, 300ms); }',
    '.hmi-chatbot-input:focus { border-color: var(--color-primary, #1A73E8); }',
    '.hmi-chatbot-input::placeholder { color: var(--color-text-disabled, #9AA0A6); }',
    '.hmi-chatbot-send-btn { width: 36px; height: 36px; border-radius: 50%; border: none; background: var(--color-primary, #1A73E8); color: var(--color-surface, #FFFFFF); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: opacity var(--animation-duration, 300ms); }',
    '.hmi-chatbot-send-btn:hover { opacity: 0.85; }',
    '.hmi-chatbot-send-btn:disabled { opacity: 0.4; cursor: default; }',
    '.hmi-chatbot-send-btn svg { width: 18px; height: 18px; fill: currentColor; }',

    // Upload
    '.hmi-chatbot-upload-label { cursor: pointer; display: flex; align-items: center; justify-content: center; }',
    '.hmi-chatbot-upload-label svg { width: 18px; height: 18px; fill: currentColor; }',
    '.hmi-chatbot-file-input { display: none; }',

    // Connection status
    '.hmi-chatbot-status { font-size: 10px; opacity: 0.7; margin-left: 8px; }',
    '.hmi-chatbot-status--canvas { color: #34A853; }',
    '.hmi-chatbot-status--ws { color: #FBBC04; }',
    '.hmi-chatbot-status--offline { color: #EA4335; }',
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function _injectStyles() {
    if (styleInjected) return;
    var style = document.createElement('style');
    style.setAttribute('data-hmi-chatbot', '');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  function _el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    }
    return node;
  }

  function _svgIcon(pathD, viewBox) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox || '0 0 24 24');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  function _scrollToBottom() {
    if (els.messages) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function _generateId() {
    return 'hmi-' + Date.now().toString(36) + '-' + (++callbackIdCounter).toString(36);
  }

  // ---------------------------------------------------------------------------
  // Environment Detection
  // ---------------------------------------------------------------------------

  function _detectMode() {
    // Canvas mode: openclawSendUserAction is injected by Canvas host
    if (typeof root.openclawSendUserAction === 'function') {
      return 'canvas';
    }
    // Browser mode: try WebSocket to Gateway
    return 'browser';
  }

  function _deriveGatewayWsUrl() {
    // If explicitly configured, use that
    if (config.gatewayUrl) return config.gatewayUrl;
    // Derive from current page URL (Gateway is on port 18789)
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var host = location.hostname || 'localhost';
    return proto + '//' + host + ':18789/ws';
  }

  // ---------------------------------------------------------------------------
  // Canvas Bridge Communication
  // ---------------------------------------------------------------------------

  /**
   * Send a message via the Canvas native bridge (openclawSendUserAction).
   * The bridge sends user actions to the OpenClaw agent, which processes
   * them and can respond via canvas eval or dataModelUpdate.
   */
  function _sendViaCanvasBridge(content, action) {
    var actionId = _generateId();
    var sent = root.openclawSendUserAction({
      name: 'hmi-chatbot-' + (action || 'customize'),
      surfaceId: 'hmi-dashboard',
      sourceComponentId: 'hmi-chatbot',
      context: {
        content: content,
        action: action || 'customize',
        skill: SKILL_NAME,
        sessionId: config.sessionId,
        callbackId: actionId,
      },
    });
    return sent !== false;
  }

  /**
   * Send a file via Canvas bridge using base64 encoding.
   */
  function _sendFileViaCanvasBridge(fileName, fileContent, fileType) {
    var actionId = _generateId();
    // For text-based files, send content directly
    // For binary files, base64 encode
    var payload = {
      name: 'hmi-chatbot-parse-scheme',
      surfaceId: 'hmi-dashboard',
      sourceComponentId: 'hmi-chatbot-upload',
      context: {
        action: 'parse-scheme',
        skill: SKILL_NAME,
        sessionId: config.sessionId,
        fileName: fileName,
        fileType: fileType,
        content: fileContent,
        callbackId: actionId,
      },
    };
    return root.openclawSendUserAction(payload) !== false;
  }

  /**
   * Global callback for receiving responses from OpenClaw agent.
   * The agent calls: canvas action:eval "openclawHMIResponse({...})"
   */
  root.openclawHMIResponse = function (data) {
    _handleIncomingMessage(data);
  };

  // ---------------------------------------------------------------------------
  // WebSocket Communication (browser mode fallback)
  // ---------------------------------------------------------------------------

  var reconnectAttempts = 0;
  var maxReconnectAttempts = 5;
  var reconnectTimer = null;

  function _connectWebSocket() {
    if (mode !== 'browser') return;
    var url = _deriveGatewayWsUrl();
    try {
      ws = new WebSocket(url);
    } catch (err) {
      _appendMessage('system', 'Failed to connect to Gateway.');
      return;
    }

    ws.onopen = function () {
      reconnectAttempts = 0;
    };

    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { data = { content: event.data }; }
      _handleIncomingMessage(data);
    };

    ws.onerror = function () {};

    ws.onclose = function () {
      ws = null;
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        var delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16000);
        reconnectTimer = setTimeout(_connectWebSocket, delay);
      }
    };
  }

  function _disconnectWebSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = maxReconnectAttempts;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  function _sendViaWebSocket(content, action) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      _appendMessage('system', 'Not connected to Gateway. Retrying...');
      _connectWebSocket();
      return false;
    }
    ws.send(JSON.stringify({
      type: 'message',
      content: content,
      metadata: {
        skill: SKILL_NAME,
        action: action || 'customize',
        sessionId: config.sessionId,
      },
    }));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Unified Send (auto-selects Canvas bridge or WebSocket)
  // ---------------------------------------------------------------------------

  function _send(content, action) {
    if (mode === 'canvas') {
      return _sendViaCanvasBridge(content, action);
    }
    return _sendViaWebSocket(content, action);
  }

  // ---------------------------------------------------------------------------
  // Incoming Message Handler
  // ---------------------------------------------------------------------------

  var typingIndicator = null;

  function _handleIncomingMessage(data) {
    if (typingIndicator) {
      _removeTyping(typingIndicator);
      typingIndicator = null;
    }

    // Normalize: accept string or object
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { data = { content: data }; }
    }

    // Display response text
    if (data.content) {
      _appendMessage('bot', data.content);
    }

    // Handle customization parameters
    if (data.customization) {
      _dispatchCustomization(data.customization);
    }

    // Handle design scheme updates
    if (data.scheme) {
      _dispatchSchemeUpdate(data.scheme);
    }

    if (typeof config.onMessage === 'function') {
      config.onMessage(data);
    }
  }

  // ---------------------------------------------------------------------------
  // UI Construction
  // ---------------------------------------------------------------------------

  function _buildUI() {
    // Chat bubble button
    els.bubble = _el('button', 'hmi-chatbot-bubble');
    els.bubble.setAttribute('aria-label', 'Open HMI Assistant');
    els.bubble.setAttribute('title', 'HMI Assistant');
    els.bubble.appendChild(
      _svgIcon('M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z')
    );
    els.bubble.addEventListener('click', _togglePanel);

    // Panel container
    els.panel = _el('div', 'hmi-chatbot-panel hmi-chatbot-panel--hidden');

    // Header
    els.header = _el('div', 'hmi-chatbot-header');
    var titleEl = _el('span', 'hmi-chatbot-header-title');
    titleEl.textContent = 'HMI Assistant';

    // Connection mode indicator
    var statusEl = _el('span', 'hmi-chatbot-status');
    if (mode === 'canvas') {
      statusEl.classList.add('hmi-chatbot-status--canvas');
      statusEl.textContent = 'Canvas';
    } else {
      statusEl.classList.add('hmi-chatbot-status--ws');
      statusEl.textContent = 'Browser';
    }
    titleEl.appendChild(statusEl);

    var actionsEl = _el('div', 'hmi-chatbot-header-actions');

    // Upload button
    var uploadLabel = _el('label', 'hmi-chatbot-header-btn hmi-chatbot-upload-label');
    uploadLabel.setAttribute('title', 'Upload design scheme');
    uploadLabel.appendChild(_svgIcon('M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z'));
    els.schemeInput = _el('input', 'hmi-chatbot-file-input', {
      type: 'file',
      accept: '.json,.pdf,.docx,.xlsx,.fig',
    });
    uploadLabel.appendChild(els.schemeInput);
    els.schemeInput.addEventListener('change', _handleSchemeFileChange);

    // Close button
    els.closeBtn = _el('button', 'hmi-chatbot-header-btn');
    els.closeBtn.setAttribute('aria-label', 'Close');
    els.closeBtn.innerHTML = '&#x2715;';
    els.closeBtn.addEventListener('click', _togglePanel);

    actionsEl.appendChild(uploadLabel);
    actionsEl.appendChild(els.closeBtn);
    els.header.appendChild(titleEl);
    els.header.appendChild(actionsEl);

    // Messages area
    els.messages = _el('div', 'hmi-chatbot-messages');

    // Input area
    els.inputWrap = _el('div', 'hmi-chatbot-input-wrap');
    els.input = _el('input', 'hmi-chatbot-input', {
      type: 'text',
      placeholder: 'Describe your customization...',
    });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _handleSend();
      }
    });

    els.sendBtn = _el('button', 'hmi-chatbot-send-btn');
    els.sendBtn.setAttribute('aria-label', 'Send');
    els.sendBtn.appendChild(_svgIcon('M2.01 21L23 12 2.01 3 2 10l15 2-15 2z'));
    els.sendBtn.addEventListener('click', _handleSend);

    els.inputWrap.appendChild(els.input);
    els.inputWrap.appendChild(els.sendBtn);

    // Assemble
    els.panel.appendChild(els.header);
    els.panel.appendChild(els.messages);
    els.panel.appendChild(els.inputWrap);

    document.body.appendChild(els.bubble);
    document.body.appendChild(els.panel);
  }

  // ---------------------------------------------------------------------------
  // UI Interactions
  // ---------------------------------------------------------------------------

  function _togglePanel() {
    isOpen = !isOpen;
    if (isOpen) {
      els.panel.classList.remove('hmi-chatbot-panel--hidden');
      els.bubble.classList.add('hmi-chatbot-bubble--hidden');
      els.input.focus();
    } else {
      els.panel.classList.add('hmi-chatbot-panel--hidden');
      els.bubble.classList.remove('hmi-chatbot-bubble--hidden');
    }
  }

  function _handleSend() {
    var text = (els.input.value || '').trim();
    if (!text) return;
    els.input.value = '';
    HMIChatbot.sendMessage(text);
  }

  function _handleSchemeFileChange(e) {
    var file = e.target.files && e.target.files[0];
    if (file) HMIChatbot.uploadScheme(file);
    e.target.value = '';
  }

  // ---------------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------------

  function _appendMessage(type, text) {
    var msg = _el('div', 'hmi-chatbot-msg hmi-chatbot-msg--' + type);
    msg.textContent = text;
    els.messages.appendChild(msg);
    _scrollToBottom();
  }

  function _showTyping() {
    var typing = _el('div', 'hmi-chatbot-typing');
    for (var i = 0; i < 3; i++) typing.appendChild(_el('div', 'hmi-chatbot-typing-dot'));
    els.messages.appendChild(typing);
    _scrollToBottom();
    return typing;
  }

  function _removeTyping(typingEl) {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
  }

  // ---------------------------------------------------------------------------
  // CustomEvent dispatching
  // ---------------------------------------------------------------------------

  function _dispatchCustomization(params) {
    document.dispatchEvent(new CustomEvent('hmi-customization', { detail: params }));
    if (typeof config.onCustomization === 'function') config.onCustomization(params);
    // Auto-save
    var prefs = HMIChatbot.loadPreferences() || {};
    Object.keys(params).forEach(function (key) { prefs[key] = params[key]; });
    HMIChatbot.savePreferences(prefs);
  }

  function _dispatchSchemeUpdate(scheme) {
    document.dispatchEvent(new CustomEvent('hmi-scheme-update', { detail: { scheme: scheme } }));
    if (typeof config.onSchemeUpdate === 'function') config.onSchemeUpdate(scheme);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var HMIChatbot = {
    /**
     * Initialize the chatbot widget.
     * Automatically detects Canvas vs Browser mode.
     */
    init: function (cfg) {
      config = cfg || {};
      config.sessionId = config.sessionId || _generateId();

      // Detect communication mode
      mode = _detectMode();

      _injectStyles();
      _buildUI();

      // Connect based on mode
      if (mode === 'browser') {
        _connectWebSocket();
      }

      // Welcome message
      _appendMessage('bot',
        'Hi! I\'m your HMI Assistant. Tell me how you\'d like to customize your dashboard.\n\n' +
        'Examples:\n' +
        '- "make it sporty"\n' +
        '- "switch to dark mode"\n' +
        '- "add energy stats widget"\n' +
        '- "more compact layout"\n\n' +
        'You can also upload a design scheme using the upload button above.'
      );
    },

    /**
     * Send a user message for LLM processing.
     */
    sendMessage: function (text) {
      if (!text || !text.trim()) return;
      text = text.trim();

      _appendMessage('user', text);
      typingIndicator = _showTyping();

      var sent = _send(text, 'customize');
      if (!sent) {
        _removeTyping(typingIndicator);
        typingIndicator = null;
      }
    },

    /**
     * Upload a design scheme file for LLM parsing.
     */
    uploadScheme: function (file) {
      if (!file) return;

      _appendMessage('system', 'Uploading: ' + file.name + '...');
      typingIndicator = _showTyping();

      var reader = new FileReader();
      reader.onload = function (e) {
        var content = e.target.result;

        // JSON files: validate and send structured
        if (file.name.endsWith('.json')) {
          try {
            var parsed = JSON.parse(content);
            content = JSON.stringify(parsed);
          } catch (err) {
            // Send raw if parse fails
          }
        }

        var sent;
        if (mode === 'canvas') {
          sent = _sendFileViaCanvasBridge(file.name, content, file.type);
        } else {
          sent = _sendViaWebSocket(content, 'parse-scheme');
        }

        if (!sent) {
          _removeTyping(typingIndicator);
          typingIndicator = null;
          _appendMessage('system', 'Failed to upload. Please try again.');
        }
      };

      reader.onerror = function () {
        _removeTyping(typingIndicator);
        typingIndicator = null;
        _appendMessage('system', 'Failed to read file: ' + file.name);
      };

      reader.readAsText(file);
    },

    /**
     * Load stored preferences.
     */
    loadPreferences: function () {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },

    /**
     * Save preferences.
     */
    savePreferences: function (prefs) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
    },

    /**
     * Clean up.
     */
    destroy: function () {
      _disconnectWebSocket();
      if (els.bubble && els.bubble.parentNode) els.bubble.parentNode.removeChild(els.bubble);
      if (els.panel && els.panel.parentNode) els.panel.parentNode.removeChild(els.panel);
      var styleEl = document.querySelector('style[data-hmi-chatbot]');
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      els = { bubble: null, panel: null, header: null, messages: null, inputWrap: null, input: null, sendBtn: null, closeBtn: null, schemeInput: null };
      ws = null; config = {}; isOpen = false; styleInjected = false; typingIndicator = null; reconnectAttempts = 0; mode = 'unknown';
    },

    /** Current communication mode. */
    getMode: function () { return mode; },
  };

  // Expose globally
  root.HMIChatbot = HMIChatbot;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

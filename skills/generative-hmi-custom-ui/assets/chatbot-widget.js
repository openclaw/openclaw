/**
 * HMI Chatbot Widget
 *
 * Self-contained JavaScript module providing chatbot functionality for the
 * generated HMI HTML page. Communicates with the OpenClaw Gateway via
 * WebSocket and exposes UI customization through CustomEvents.
 *
 * Usage:
 *   HMIChatbot.init({ gatewayUrl, sessionId, onCustomization, onSchemeUpdate, onMessage });
 *   HMIChatbot.sendMessage('make it sporty');
 *   HMIChatbot.destroy();
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var STORAGE_KEY = 'openclaw-hmi-preferences';
  var DEFAULT_GATEWAY_URL = 'ws://localhost:18789/ws';
  var SKILL_NAME = 'generative-hmi-custom-ui';

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  var ws = null;
  var config = {};
  var isOpen = false;
  var styleInjected = false;

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
    '.hmi-chatbot-bubble:hover {',
    '  transform: scale(1.08);',
    '}',
    '.hmi-chatbot-bubble:active {',
    '  transform: scale(0.95);',
    '}',
    '.hmi-chatbot-bubble--hidden {',
    '  transform: scale(0);',
    '  opacity: 0;',
    '  pointer-events: none;',
    '}',
    '.hmi-chatbot-bubble svg {',
    '  width: 24px;',
    '  height: 24px;',
    '  fill: currentColor;',
    '}',

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
    '.hmi-chatbot-panel--hidden {',
    '  transform: scale(0.3);',
    '  opacity: 0;',
    '  pointer-events: none;',
    '}',

    // Dark theme support
    '[data-theme="night"] .hmi-chatbot-panel {',
    '  background: var(--color-surface-dark, #1E1E1E);',
    '  color: var(--theme-text, #E8EAED);',
    '}',
    '[data-theme="night"] .hmi-chatbot-header {',
    '  background: var(--color-surface-dark, #1E1E1E);',
    '  border-bottom-color: rgba(255,255,255,0.1);',
    '}',
    '[data-theme="night"] .hmi-chatbot-messages {',
    '  background: var(--color-surface-dark, #1E1E1E);',
    '}',
    '[data-theme="night"] .hmi-chatbot-input-wrap {',
    '  background: var(--color-surface-dark, #1E1E1E);',
    '  border-top-color: rgba(255,255,255,0.1);',
    '}',
    '[data-theme="night"] .hmi-chatbot-input {',
    '  background: rgba(255,255,255,0.08);',
    '  color: var(--theme-text, #E8EAED);',
    '}',
    '[data-theme="night"] .hmi-chatbot-msg--bot {',
    '  background: rgba(255,255,255,0.08);',
    '  color: var(--theme-text, #E8EAED);',
    '}',
    '[data-theme="night"] .hmi-chatbot-msg--system {',
    '  color: var(--color-text-secondary, #9AA0A6);',
    '}',

    // Header
    '.hmi-chatbot-header {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);',
    '  background: var(--color-primary, #1A73E8);',
    '  color: var(--color-surface, #FFFFFF);',
    '  flex-shrink: 0;',
    '}',
    '.hmi-chatbot-header-title {',
    '  font-size: var(--font-h3, 18px);',
    '  font-weight: var(--font-weight-medium, 500);',
    '}',
    '.hmi-chatbot-header-actions {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: var(--spacing-xs, 4px);',
    '}',
    '.hmi-chatbot-header-btn {',
    '  background: none;',
    '  border: none;',
    '  color: inherit;',
    '  cursor: pointer;',
    '  width: 32px;',
    '  height: 32px;',
    '  border-radius: 50%;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  transition: background var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1));',
    '  font-size: 18px;',
    '  line-height: 1;',
    '}',
    '.hmi-chatbot-header-btn:hover {',
    '  background: rgba(255,255,255,0.2);',
    '}',

    // Messages area
    '.hmi-chatbot-messages {',
    '  flex: 1;',
    '  overflow-y: auto;',
    '  padding: var(--spacing-sm, 8px);',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: var(--spacing-sm, 8px);',
    '  background: var(--color-surface, #FFFFFF);',
    '}',

    // Message bubbles
    '.hmi-chatbot-msg {',
    '  max-width: 85%;',
    '  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);',
    '  border-radius: var(--radius-md, 12px);',
    '  font-size: var(--font-body, 14px);',
    '  line-height: 1.5;',
    '  word-wrap: break-word;',
    '  white-space: pre-wrap;',
    '}',
    '.hmi-chatbot-msg--user {',
    '  align-self: flex-end;',
    '  background: var(--color-primary, #1A73E8);',
    '  color: var(--color-surface, #FFFFFF);',
    '  border-bottom-right-radius: var(--spacing-xs, 4px);',
    '}',
    '.hmi-chatbot-msg--bot {',
    '  align-self: flex-start;',
    '  background: rgba(0,0,0,0.06);',
    '  color: var(--color-text-primary, #202124);',
    '  border-bottom-left-radius: var(--spacing-xs, 4px);',
    '}',
    '.hmi-chatbot-msg--system {',
    '  align-self: center;',
    '  background: none;',
    '  color: var(--color-text-secondary, #5F6368);',
    '  font-size: var(--font-caption, 12px);',
    '  text-align: center;',
    '  padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px);',
    '}',

    // Typing indicator
    '.hmi-chatbot-typing {',
    '  align-self: flex-start;',
    '  display: flex;',
    '  gap: 4px;',
    '  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);',
    '  background: rgba(0,0,0,0.06);',
    '  border-radius: var(--radius-md, 12px);',
    '  border-bottom-left-radius: var(--spacing-xs, 4px);',
    '}',
    '.hmi-chatbot-typing-dot {',
    '  width: 6px;',
    '  height: 6px;',
    '  border-radius: 50%;',
    '  background: var(--color-text-secondary, #5F6368);',
    '  animation: hmi-chatbot-bounce 1.4s ease-in-out infinite;',
    '}',
    '.hmi-chatbot-typing-dot:nth-child(2) { animation-delay: 0.2s; }',
    '.hmi-chatbot-typing-dot:nth-child(3) { animation-delay: 0.4s; }',
    '@keyframes hmi-chatbot-bounce {',
    '  0%, 60%, 100% { transform: translateY(0); }',
    '  30% { transform: translateY(-4px); }',
    '}',

    // Input area
    '.hmi-chatbot-input-wrap {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: var(--spacing-sm, 8px);',
    '  padding: var(--spacing-sm, 8px);',
    '  border-top: 1px solid rgba(0,0,0,0.08);',
    '  flex-shrink: 0;',
    '  background: var(--color-surface, #FFFFFF);',
    '}',
    '.hmi-chatbot-input {',
    '  flex: 1;',
    '  border: 1px solid rgba(0,0,0,0.12);',
    '  border-radius: var(--radius-pill, 999px);',
    '  padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);',
    '  font-size: var(--font-body, 14px);',
    '  font-family: var(--font-family, system-ui, sans-serif);',
    '  outline: none;',
    '  background: rgba(0,0,0,0.03);',
    '  color: var(--color-text-primary, #202124);',
    '  transition: border-color var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1));',
    '}',
    '.hmi-chatbot-input:focus {',
    '  border-color: var(--color-primary, #1A73E8);',
    '}',
    '.hmi-chatbot-input::placeholder {',
    '  color: var(--color-text-disabled, #9AA0A6);',
    '}',
    '.hmi-chatbot-send-btn {',
    '  width: 36px;',
    '  height: 36px;',
    '  border-radius: 50%;',
    '  border: none;',
    '  background: var(--color-primary, #1A73E8);',
    '  color: var(--color-surface, #FFFFFF);',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  flex-shrink: 0;',
    '  transition: opacity var(--animation-duration, 300ms) var(--animation-easing, cubic-bezier(0.4,0,0.2,1));',
    '}',
    '.hmi-chatbot-send-btn:hover {',
    '  opacity: 0.85;',
    '}',
    '.hmi-chatbot-send-btn:disabled {',
    '  opacity: 0.4;',
    '  cursor: default;',
    '}',
    '.hmi-chatbot-send-btn svg {',
    '  width: 18px;',
    '  height: 18px;',
    '  fill: currentColor;',
    '}',

    // Scheme upload button (inline in header)
    '.hmi-chatbot-upload-label {',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '}',
    '.hmi-chatbot-upload-label svg {',
    '  width: 18px;',
    '  height: 18px;',
    '  fill: currentColor;',
    '}',
    '.hmi-chatbot-file-input {',
    '  display: none;',
    '}',
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Inject the widget stylesheet into the document head (once).
   */
  function _injectStyles() {
    if (styleInjected) return;
    var style = document.createElement('style');
    style.setAttribute('data-hmi-chatbot', '');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  /**
   * Shorthand: create an element with a class list.
   */
  function _el(tag, className, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        node.setAttribute(k, attrs[k]);
      });
    }
    return node;
  }

  /**
   * Create an SVG icon element from a path string.
   */
  function _svgIcon(pathD, viewBox) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox || '0 0 24 24');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  /**
   * Scroll the messages area to the bottom.
   */
  function _scrollToBottom() {
    if (els.messages) {
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }

  /**
   * Generate a simple session ID when none is provided.
   */
  function _generateSessionId() {
    return 'hmi-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------------
  // UI Construction
  // ---------------------------------------------------------------------------

  function _buildUI() {
    // Chat bubble button (chat icon)
    els.bubble = _el('button', 'hmi-chatbot-bubble');
    els.bubble.setAttribute('aria-label', 'Open HMI Assistant');
    els.bubble.setAttribute('title', 'HMI Assistant');
    els.bubble.appendChild(
      _svgIcon(
        // Chat bubble icon
        'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z'
      )
    );
    els.bubble.addEventListener('click', _togglePanel);

    // Panel container
    els.panel = _el('div', 'hmi-chatbot-panel hmi-chatbot-panel--hidden');

    // Header
    els.header = _el('div', 'hmi-chatbot-header');
    var titleEl = _el('span', 'hmi-chatbot-header-title');
    titleEl.textContent = 'HMI Assistant';

    var actionsEl = _el('div', 'hmi-chatbot-header-actions');

    // Scheme upload button in header
    var uploadLabel = _el('label', 'hmi-chatbot-header-btn hmi-chatbot-upload-label');
    uploadLabel.setAttribute('title', 'Upload design scheme');
    uploadLabel.appendChild(
      _svgIcon(
        // Upload icon
        'M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z'
      )
    );
    els.schemeInput = _el('input', 'hmi-chatbot-file-input', {
      type: 'file',
      accept: '.json,.pdf,.docx,.xlsx,.fig',
    });
    uploadLabel.appendChild(els.schemeInput);
    els.schemeInput.addEventListener('change', _handleSchemeFileChange);

    // Close button
    els.closeBtn = _el('button', 'hmi-chatbot-header-btn');
    els.closeBtn.setAttribute('aria-label', 'Close');
    els.closeBtn.setAttribute('title', 'Close');
    els.closeBtn.innerHTML = '&#x2715;'; // X mark
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
    els.sendBtn.appendChild(
      _svgIcon(
        // Send / arrow icon
        'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z'
      )
    );
    els.sendBtn.addEventListener('click', _handleSend);

    els.inputWrap.appendChild(els.input);
    els.inputWrap.appendChild(els.sendBtn);

    // Assemble panel
    els.panel.appendChild(els.header);
    els.panel.appendChild(els.messages);
    els.panel.appendChild(els.inputWrap);

    // Append to body
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
    if (file) {
      HMIChatbot.uploadScheme(file);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  }

  // ---------------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------------

  /**
   * Add a message to the chat UI.
   * @param {'user'|'bot'|'system'} type
   * @param {string} text
   */
  function _appendMessage(type, text) {
    var msg = _el('div', 'hmi-chatbot-msg hmi-chatbot-msg--' + type);
    msg.textContent = text;
    els.messages.appendChild(msg);
    _scrollToBottom();
  }

  /**
   * Show a typing indicator.
   * @returns {HTMLElement} The typing element (for later removal).
   */
  function _showTyping() {
    var typing = _el('div', 'hmi-chatbot-typing');
    for (var i = 0; i < 3; i++) {
      typing.appendChild(_el('div', 'hmi-chatbot-typing-dot'));
    }
    els.messages.appendChild(typing);
    _scrollToBottom();
    return typing;
  }

  /**
   * Remove the typing indicator.
   */
  function _removeTyping(typingEl) {
    if (typingEl && typingEl.parentNode) {
      typingEl.parentNode.removeChild(typingEl);
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  var reconnectAttempts = 0;
  var maxReconnectAttempts = 5;
  var reconnectTimer = null;

  function _connectWebSocket() {
    var url = (config.gatewayUrl || DEFAULT_GATEWAY_URL);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      _appendMessage('system', 'Failed to connect to Gateway.');
      return;
    }

    ws.onopen = function () {
      reconnectAttempts = 0;
      _appendMessage('system', 'Connected to HMI Gateway.');
    };

    ws.onmessage = function (event) {
      _handleIncomingMessage(event.data);
    };

    ws.onerror = function () {
      // Errors are followed by onclose; handled there.
    };

    ws.onclose = function () {
      ws = null;
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        var delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16000);
        _appendMessage('system', 'Disconnected. Reconnecting in ' + Math.round(delay / 1000) + 's...');
        reconnectTimer = setTimeout(_connectWebSocket, delay);
      } else {
        _appendMessage('system', 'Unable to reconnect to Gateway.');
      }
    };
  }

  function _disconnectWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = maxReconnectAttempts; // prevent auto-reconnect
    if (ws) {
      ws.onclose = null; // prevent reconnect handler
      ws.close();
      ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message protocol
  // ---------------------------------------------------------------------------

  var typingIndicator = null;

  /**
   * Send a structured message to the Gateway WebSocket.
   */
  function _sendToGateway(content, action) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      _appendMessage('system', 'Not connected to Gateway. Please wait...');
      return false;
    }

    var payload = {
      type: 'message',
      content: content,
      metadata: {
        skill: SKILL_NAME,
        action: action || 'customize',
        sessionId: config.sessionId,
      },
    };

    ws.send(JSON.stringify(payload));
    return true;
  }

  /**
   * Handle an incoming WebSocket message from the Gateway.
   */
  function _handleIncomingMessage(raw) {
    // Remove typing indicator if present
    if (typingIndicator) {
      _removeTyping(typingIndicator);
      typingIndicator = null;
    }

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // Non-JSON messages are displayed as plain text
      _appendMessage('bot', raw);
      return;
    }

    // Display the response text
    if (data.type === 'response' && data.content) {
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

    // Invoke user callbacks
    if (typeof config.onMessage === 'function') {
      config.onMessage(data);
    }
  }

  // ---------------------------------------------------------------------------
  // CustomEvent dispatching
  // ---------------------------------------------------------------------------

  /**
   * Dispatch an hmi-customization event with the structured parameters.
   */
  function _dispatchCustomization(params) {
    document.dispatchEvent(
      new CustomEvent('hmi-customization', {
        detail: params,
      })
    );
    if (typeof config.onCustomization === 'function') {
      config.onCustomization(params);
    }

    // Auto-save preferences when customization changes
    var prefs = HMIChatbot.loadPreferences() || {};
    Object.keys(params).forEach(function (key) {
      prefs[key] = params[key];
    });
    HMIChatbot.savePreferences(prefs);
  }

  /**
   * Dispatch an hmi-scheme-update event with the parsed scheme.
   */
  function _dispatchSchemeUpdate(scheme) {
    document.dispatchEvent(
      new CustomEvent('hmi-scheme-update', {
        detail: { scheme: scheme },
      })
    );
    if (typeof config.onSchemeUpdate === 'function') {
      config.onSchemeUpdate(scheme);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var HMIChatbot = {
    /**
     * Initialize the chatbot widget.
     *
     * @param {Object} cfg
     * @param {string} [cfg.gatewayUrl] - WebSocket URL (default: ws://localhost:18789/ws)
     * @param {string} [cfg.sessionId] - Session identifier
     * @param {Function} [cfg.onCustomization] - Callback when customization params arrive
     * @param {Function} [cfg.onSchemeUpdate] - Callback when a design scheme is parsed
     * @param {Function} [cfg.onMessage] - Callback for every incoming message
     */
    init: function (cfg) {
      config = cfg || {};
      config.sessionId = config.sessionId || _generateSessionId();

      _injectStyles();
      _buildUI();
      _connectWebSocket();

      // Welcome message
      _appendMessage('bot', 'Hi! I\'m your HMI Assistant. Tell me how you\'d like to customize your dashboard -- for example, "make it sporty" or "switch to dark mode".');
    },

    /**
     * Send a user message to the Gateway for LLM processing.
     * @param {string} text
     */
    sendMessage: function (text) {
      if (!text || !text.trim()) return;
      text = text.trim();

      // Display the user message
      _appendMessage('user', text);

      // Show typing indicator
      typingIndicator = _showTyping();

      // Send to Gateway
      var sent = _sendToGateway(text, 'customize');

      if (!sent) {
        _removeTyping(typingIndicator);
        typingIndicator = null;
      }
    },

    /**
     * Upload a design scheme file for LLM parsing.
     * @param {File} file - A File object (JSON, PDF, DOCX, XLSX)
     */
    uploadScheme: function (file) {
      if (!file) return;

      _appendMessage('system', 'Uploading scheme: ' + file.name + '...');
      typingIndicator = _showTyping();

      var reader = new FileReader();
      reader.onload = function (e) {
        var content = e.target.result;

        // For JSON files, try to parse and send structured content
        var payload;
        if (file.name.endsWith('.json')) {
          try {
            payload = JSON.parse(content);
            content = JSON.stringify(payload);
          } catch (parseErr) {
            // If JSON parse fails, send raw text
          }
        }

        var sent = _sendToGateway(content, 'parse-scheme');
        if (!sent) {
          _removeTyping(typingIndicator);
          typingIndicator = null;
          _appendMessage('system', 'Failed to send scheme. Not connected to Gateway.');
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
     * Load stored preferences from localStorage.
     * @returns {Object|null} The stored preferences, or null if none exist.
     */
    loadPreferences: function () {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },

    /**
     * Save preferences to localStorage.
     * @param {Object} prefs - The preferences to store.
     */
    savePreferences: function (prefs) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch (e) {
        // localStorage may be unavailable or full; fail silently
      }
    },

    /**
     * Clean up the chatbot widget: disconnect WebSocket, remove DOM elements.
     */
    destroy: function () {
      _disconnectWebSocket();

      // Remove DOM elements
      if (els.bubble && els.bubble.parentNode) {
        els.bubble.parentNode.removeChild(els.bubble);
      }
      if (els.panel && els.panel.parentNode) {
        els.panel.parentNode.removeChild(els.panel);
      }

      // Remove injected styles
      var styleEl = document.querySelector('style[data-hmi-chatbot]');
      if (styleEl && styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }

      // Reset state
      els = {
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
      ws = null;
      config = {};
      isOpen = false;
      styleInjected = false;
      typingIndicator = null;
      reconnectAttempts = 0;
    },
  };

  // Expose globally
  root.HMIChatbot = HMIChatbot;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

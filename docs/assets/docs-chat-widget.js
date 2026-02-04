(() => {
  if (document.getElementById("docs-chat-root")) return;

  // Determine if we're on the docs site or embedded elsewhere
  const hostname = window.location.hostname;
  const isDocsSite = hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname.includes("docs.openclaw") || hostname.endsWith(".mintlify.app");
  const assetsBase = isDocsSite ? "" : "https://docs.openclaw.ai";
  const apiBase = "https://claw-api.openknot.ai/api";

  // Load marked for markdown rendering (via CDN)
  let markedReady = false;
  const loadMarkdownLib = () => {
    if (window.marked) {
      markedReady = true;
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/marked@15.0.6/marked.min.js";
    script.onload = () => {
      if (window.marked) {
        markedReady = true;
      }
    };
    script.onerror = () => console.warn("Failed to load marked library");
    document.head.appendChild(script);
  };
  loadMarkdownLib();

  // Markdown renderer with fallback before module loads
  const renderMarkdown = (text) => {
    if (markedReady && window.marked) {
      // Configure marked for security: disable HTML pass-through
      const html = window.marked.parse(text, { async: false, gfm: true, breaks: true });
      // Open links in new tab by rewriting <a> tags
      return html.replace(/<a href="/g, '<a target="_blank" rel="noopener" href="');
    }
    // Fallback: escape HTML and preserve newlines
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  };

  const style = document.createElement("style");
  style.textContent = `
#docs-chat-root { position: fixed; right: 20px; bottom: 20px; z-index: 9999; font-family: var(--font-body, system-ui, -apple-system, sans-serif); }
#docs-chat-root.docs-chat-expanded { right: 0; bottom: 0; top: 0; }
/* Thin scrollbar styling */
#docs-chat-root ::-webkit-scrollbar { width: 6px; height: 6px; }
#docs-chat-root ::-webkit-scrollbar-track { background: transparent; }
#docs-chat-root ::-webkit-scrollbar-thumb { background: var(--docs-chat-panel-border); border-radius: 3px; }
#docs-chat-root ::-webkit-scrollbar-thumb:hover { background: var(--docs-chat-muted); }
#docs-chat-root * { scrollbar-width: thin; scrollbar-color: var(--docs-chat-panel-border) transparent; }
:root {
  --docs-chat-accent: var(--accent, #ff7d60);
  --docs-chat-text: #1a1a1a;
  --docs-chat-muted: #555;
  --docs-chat-panel: rgba(255, 255, 255, 0.92);
  --docs-chat-panel-border: rgba(0, 0, 0, 0.1);
  --docs-chat-surface: rgba(250, 250, 250, 0.95);
  --docs-chat-shadow: 0 18px 50px rgba(0,0,0,0.15);
  --docs-chat-code-bg: rgba(0, 0, 0, 0.05);
  --docs-chat-assistant-bg: #f5f5f5;
}
html[data-theme="dark"] {
  --docs-chat-text: #e8e8e8;
  --docs-chat-muted: #aaa;
  --docs-chat-panel: rgba(28, 28, 30, 0.95);
  --docs-chat-panel-border: rgba(255, 255, 255, 0.12);
  --docs-chat-surface: rgba(38, 38, 40, 0.95);
  --docs-chat-shadow: 0 18px 50px rgba(0,0,0,0.5);
  --docs-chat-code-bg: rgba(255, 255, 255, 0.08);
  --docs-chat-assistant-bg: #2a2a2c;
}
#docs-chat-button {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: linear-gradient(140deg, rgba(255,90,54,0.25), rgba(255,90,54,0.06));
  color: var(--docs-chat-text);
  border: 1px solid rgba(255,90,54,0.4);
  border-radius: 999px;
  padding: 10px 14px;
  cursor: pointer;
  box-shadow: 0 8px 30px rgba(255,90,54, 0.08);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  font-family: var(--font-pixel, var(--font-body, system-ui, sans-serif));
}
#docs-chat-button span { font-weight: 600; letter-spacing: 0.04em; font-size: 14px; }
.docs-chat-logo { width: 20px; height: 20px; }
#docs-chat-panel {
  width: min(440px, calc(100vw - 40px));
  height: min(696px, calc(100vh - 80px));
  background: var(--docs-chat-panel);
  color: var(--docs-chat-text);
  border-radius: 16px;
  border: 1px solid var(--docs-chat-panel-border);
  box-shadow: var(--docs-chat-shadow);
  display: none;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
#docs-chat-root.docs-chat-expanded #docs-chat-panel {
  width: min(512px, 100vw);
  height: 100vh;
  height: 100dvh;
  border-radius: 18px 0 0 18px;
  padding-top: env(safe-area-inset-top, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
}
@media (max-width: 520px) {
  #docs-chat-root.docs-chat-expanded #docs-chat-panel {
    width: 100vw;
    border-radius: 0;
  }
  #docs-chat-root.docs-chat-expanded { right: 0; left: 0; bottom: 0; top: 0; }
}
#docs-chat-header {
  padding: 12px 14px;
  font-weight: 600;
  font-family: var(--font-pixel, var(--font-body, system-ui, sans-serif));
  letter-spacing: 0.03em;
  border-bottom: 1px solid var(--docs-chat-panel-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
#docs-chat-header-title { display: inline-flex; align-items: center; gap: 8px; }
#docs-chat-header-title span { color: var(--docs-chat-text); font-size: 15px; }
#docs-chat-header-actions { display: inline-flex; align-items: center; gap: 6px; }
.docs-chat-icon-button {
  border: 1px solid var(--docs-chat-panel-border);
  background: transparent;
  color: inherit;
  border-radius: 8px;
  width: 30px;
  height: 30px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
#docs-chat-messages { flex: 1; padding: 12px 14px; overflow: auto; background: transparent; }
#docs-chat-input {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--docs-chat-panel-border);
  background: var(--docs-chat-surface);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
#docs-chat-input textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--docs-chat-panel-border);
  border-radius: 10px;
  padding: 9px 10px;
  font-size: 14px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--docs-chat-text);
  background: var(--docs-chat-surface);
  min-height: 42px;
  max-height: 120px;
  overflow-y: auto;
}
#docs-chat-input textarea::placeholder { color: var(--docs-chat-muted); }
#docs-chat-send {
  background: var(--docs-chat-accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 8px 14px;
  cursor: pointer;
  font-weight: 600;
  font-family: inherit;
  font-size: 14px;
  transition: opacity 0.15s ease;
}
#docs-chat-send:hover { opacity: 0.9; }
#docs-chat-send:active { opacity: 0.8; }
.docs-chat-bubble {
  margin-bottom: 10px;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  max-width: 92%;
}
.docs-chat-user {
  background: rgba(255, 125, 96, 0.15);
  color: var(--docs-chat-text);
  border: 1px solid rgba(255, 125, 96, 0.3);
  align-self: flex-end;
  white-space: pre-wrap;
  margin-left: auto;
}
html[data-theme="dark"] .docs-chat-user {
  background: rgba(255, 125, 96, 0.18);
  border-color: rgba(255, 125, 96, 0.35);
}
.docs-chat-assistant {
  background: var(--docs-chat-assistant-bg);
  color: var(--docs-chat-text);
  border: 1px solid var(--docs-chat-panel-border);
}
/* Markdown content styling for chat bubbles */
.docs-chat-assistant p { margin: 0 0 10px 0; }
.docs-chat-assistant p:last-child { margin-bottom: 0; }
.docs-chat-assistant code {
  background: var(--docs-chat-code-bg);
  padding: 2px 6px;
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}
.docs-chat-assistant pre {
  background: var(--docs-chat-code-bg);
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 6px 0;
  font-size: 0.9em;
  max-width: 100%;
  white-space: pre;
  word-wrap: normal;
}
.docs-chat-assistant pre::-webkit-scrollbar-thumb { background: transparent; }
.docs-chat-assistant pre:hover::-webkit-scrollbar-thumb { background: var(--docs-chat-panel-border); }
@media (hover: none) {
  .docs-chat-assistant pre { -webkit-overflow-scrolling: touch; }
  .docs-chat-assistant pre::-webkit-scrollbar-thumb { background: var(--docs-chat-panel-border); }
}
.docs-chat-assistant pre code {
  background: transparent;
  padding: 0;
  font-size: inherit;
  white-space: pre;
  word-wrap: normal;
  display: block;
}
/* Compact single-line code blocks */
.docs-chat-assistant pre.compact {
  margin: 4px 0;
  padding: 6px 10px;
}
/* Longer code blocks with copy button need extra top padding */
.docs-chat-assistant pre:not(.compact) {
  padding-top: 28px;
}
.docs-chat-assistant a {
  color: var(--docs-chat-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.docs-chat-assistant a:hover { opacity: 0.8; }
.docs-chat-assistant ul, .docs-chat-assistant ol {
  margin: 8px 0;
  padding-left: 18px;
  list-style: none;
}
.docs-chat-assistant li {
  margin: 4px 0;
  position: relative;
  padding-left: 14px;
}
.docs-chat-assistant li::before {
  content: "•";
  position: absolute;
  left: 0;
  color: var(--docs-chat-muted);
}
.docs-chat-assistant strong { font-weight: 600; }
.docs-chat-assistant em { font-style: italic; }
.docs-chat-assistant h1, .docs-chat-assistant h2, .docs-chat-assistant h3 {
  font-weight: 600;
  margin: 12px 0 6px 0;
  line-height: 1.3;
}
.docs-chat-assistant h1 { font-size: 1.2em; }
.docs-chat-assistant h2 { font-size: 1.1em; }
.docs-chat-assistant h3 { font-size: 1.05em; }
.docs-chat-assistant blockquote {
  border-left: 3px solid var(--docs-chat-accent);
  margin: 10px 0;
  padding: 4px 12px;
  color: var(--docs-chat-muted);
  background: var(--docs-chat-code-bg);
  border-radius: 0 6px 6px 0;
}
.docs-chat-assistant hr {
  border: none;
  height: 1px;
  background: var(--docs-chat-panel-border);
  margin: 12px 0;
}
/* Copy buttons */
.docs-chat-assistant { position: relative; padding-top: 28px; }
.docs-chat-copy-response {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--docs-chat-surface);
  border: 1px solid var(--docs-chat-panel-border);
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  color: var(--docs-chat-muted);
  transition: color 0.15s ease, background 0.15s ease;
}
.docs-chat-copy-response:hover {
  color: var(--docs-chat-text);
  background: var(--docs-chat-code-bg);
}
.docs-chat-assistant pre {
  position: relative;
}
.docs-chat-copy-code {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--docs-chat-surface);
  border: 1px solid var(--docs-chat-panel-border);
  border-radius: 4px;
  padding: 3px 7px;
  font-size: 10px;
  cursor: pointer;
  color: var(--docs-chat-muted);
  transition: color 0.15s ease, background 0.15s ease;
  z-index: 1;
}
.docs-chat-copy-code:hover {
  color: var(--docs-chat-text);
  background: var(--docs-chat-code-bg);
}
/* Resize handle - left edge of expanded panel */
#docs-chat-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 10;
  display: none;
}
#docs-chat-root.docs-chat-expanded #docs-chat-resize-handle { display: block; }
#docs-chat-resize-handle::after {
  content: "";
  position: absolute;
  left: 1px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 40px;
  border-radius: 2px;
  background: var(--docs-chat-panel-border);
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
}
#docs-chat-resize-handle:hover::after,
#docs-chat-resize-handle.docs-chat-dragging::after {
  opacity: 1;
  background: var(--docs-chat-accent);
}
@media (max-width: 520px) {
  #docs-chat-resize-handle { display: none !important; }
}
`;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "docs-chat-root";

  const button = document.createElement("button");
  button.id = "docs-chat-button";
  button.type = "button";
  button.innerHTML =
    `<img class="docs-chat-logo" src="${assetsBase}/assets/pixel-lobster.svg" alt="OpenClaw">` +
    `<span>Ask Molty</span>`;

  const panel = document.createElement("div");
  panel.id = "docs-chat-panel";
  panel.style.display = "none";

  // Resize handle for expandable sidebar width (desktop only)
  const resizeHandle = document.createElement("div");
  resizeHandle.id = "docs-chat-resize-handle";

  const header = document.createElement("div");
  header.id = "docs-chat-header";
  header.innerHTML =
    `<div id="docs-chat-header-title">` +
    `<img class="docs-chat-logo" src="${assetsBase}/assets/pixel-lobster.svg" alt="OpenClaw">` +
    `<span>OpenClaw Docs</span>` +
    `</div>` +
    `<div id="docs-chat-header-actions"></div>`;
  const headerActions = header.querySelector("#docs-chat-header-actions");
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "docs-chat-icon-button";
  expand.setAttribute("aria-label", "Expand");
  expand.textContent = "⤢";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "docs-chat-icon-button";
  clear.setAttribute("aria-label", "Clear chat");
  clear.textContent = "⌫";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "docs-chat-icon-button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  headerActions.appendChild(expand);
  headerActions.appendChild(clear);
  headerActions.appendChild(close);

  const messages = document.createElement("div");
  messages.id = "docs-chat-messages";

  const inputWrap = document.createElement("div");
  inputWrap.id = "docs-chat-input";
  const textarea = document.createElement("textarea");
  textarea.rows = 1;
  textarea.placeholder = "Ask about OpenClaw Docs...";

  // Auto-expand textarea as user types (up to max-height set in CSS)
  const autoExpand = () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 224) + "px";
  };
  textarea.addEventListener("input", autoExpand);

  const send = document.createElement("button");
  send.id = "docs-chat-send";
  send.type = "button";
  send.textContent = "Send";

  inputWrap.appendChild(textarea);
  inputWrap.appendChild(send);

  panel.appendChild(resizeHandle);
  panel.appendChild(header);
  panel.appendChild(messages);
  panel.appendChild(inputWrap);

  root.appendChild(button);
  root.appendChild(panel);
  document.body.appendChild(root);

  // Add copy buttons to assistant bubble
  const addCopyButtons = (bubble, rawText) => {
    // Add copy response button
    const copyResponse = document.createElement("button");
    copyResponse.className = "docs-chat-copy-response";
    copyResponse.textContent = "Copy";
    copyResponse.type = "button";
    copyResponse.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(rawText);
        copyResponse.textContent = "Copied!";
        setTimeout(() => (copyResponse.textContent = "Copy"), 1500);
      } catch (e) {
        copyResponse.textContent = "Failed";
      }
    });
    bubble.appendChild(copyResponse);

    // Add copy buttons to code blocks (skip short/single-line blocks)
    bubble.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code") || pre;
      const text = code.textContent || "";
      const lineCount = text.split("\n").length;
      const isShort = lineCount <= 2 && text.length < 100;

      if (isShort) {
        pre.classList.add("compact");
        return; // Skip copy button for compact blocks
      }

      const copyCode = document.createElement("button");
      copyCode.className = "docs-chat-copy-code";
      copyCode.textContent = "Copy";
      copyCode.type = "button";
      copyCode.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          copyCode.textContent = "Copied!";
          setTimeout(() => (copyCode.textContent = "Copy"), 1500);
        } catch (err) {
          copyCode.textContent = "Failed";
        }
      });
      pre.appendChild(copyCode);
    });
  };

  const addBubble = (text, role, isMarkdown = false) => {
    const bubble = document.createElement("div");
    bubble.className =
      "docs-chat-bubble " +
      (role === "user" ? "docs-chat-user" : "docs-chat-assistant");
    if (isMarkdown && role === "assistant") {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  };

  let isExpanded = false;
  let customWidth = null; // User-set width via drag
  const MIN_WIDTH = 320;
  const MAX_WIDTH = 800;

  // Drag-to-resize logic
  let isDragging = false;
  let startX, startWidth;

  resizeHandle.addEventListener("mousedown", (e) => {
    if (!isExpanded) return;
    isDragging = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    resizeHandle.classList.add("docs-chat-dragging");
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    // Panel is on right, so dragging left increases width
    const delta = startX - e.clientX;
    const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    customWidth = newWidth;
    panel.style.width = newWidth + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    resizeHandle.classList.remove("docs-chat-dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  const setOpen = (isOpen) => {
    panel.style.display = isOpen ? "flex" : "none";
    button.style.display = isOpen ? "none" : "inline-flex";
    root.classList.toggle("docs-chat-expanded", isOpen && isExpanded);
    if (!isOpen) {
      panel.style.width = ""; // Reset to CSS default when closed
    } else if (isExpanded && customWidth) {
      panel.style.width = customWidth + "px";
    }
    if (isOpen) textarea.focus();
  };

  const setExpanded = (next) => {
    isExpanded = next;
    expand.textContent = isExpanded ? "⤡" : "⤢";
    expand.setAttribute("aria-label", isExpanded ? "Collapse" : "Expand");
    if (panel.style.display !== "none") {
      root.classList.toggle("docs-chat-expanded", isExpanded);
      if (isExpanded && customWidth) {
        panel.style.width = customWidth + "px";
      } else if (!isExpanded) {
        panel.style.width = ""; // Reset to CSS default
      }
    }
  };

  button.addEventListener("click", () => setOpen(true));
  expand.addEventListener("click", () => setExpanded(!isExpanded));
  clear.addEventListener("click", () => {
    messages.innerHTML = "";
  });
  close.addEventListener("click", () => {
    setOpen(false);
    root.classList.remove("docs-chat-expanded");
  });

  const sendMessage = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    textarea.style.height = "auto"; // Reset height after sending
    addBubble(text, "user");
    const assistantBubble = addBubble("...", "assistant");
    assistantBubble.innerHTML = "";

    let fullText = "";
    try {
      const response = await fetch(`${apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After") || "60";
        fullText = `You're asking questions too quickly. Please wait ${retryAfter} seconds before trying again.`;
        assistantBubble.innerHTML = renderMarkdown(fullText);
        addCopyButtons(assistantBubble, fullText);
        return;
      }

      // Handle other errors
      if (!response.ok) {
        try {
          const errorData = await response.json();
          fullText = errorData.error || "Something went wrong. Please try again.";
        } catch {
          fullText = "Something went wrong. Please try again.";
        }
        assistantBubble.innerHTML = renderMarkdown(fullText);
        addCopyButtons(assistantBubble, fullText);
        return;
      }

      if (!response.body) {
        fullText = await response.text();
        assistantBubble.innerHTML = renderMarkdown(fullText);
        addCopyButtons(assistantBubble, fullText);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        // Re-render markdown on each chunk for live preview
        assistantBubble.innerHTML = renderMarkdown(fullText);
        messages.scrollTop = messages.scrollHeight;
      }
      // Flush any remaining buffered bytes (partial UTF-8 sequences)
      fullText += decoder.decode();
      assistantBubble.innerHTML = renderMarkdown(fullText);
      // Add copy buttons after streaming completes
      addCopyButtons(assistantBubble, fullText);
    } catch (err) {
      fullText = "Failed to reach docs chat API.";
      assistantBubble.innerHTML = renderMarkdown(fullText);
      addCopyButtons(assistantBubble, fullText);
    }
  };

  send.addEventListener("click", sendMessage);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
})();

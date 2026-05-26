(function attachCommentOverlay(global) {
  "use strict";

  const PIN_EDGE_GAP = 22;
  const PIN_TOP_OFFSET = 4;
  const PIN_RIGHT_OFFSET = 9;
  const VIEWPORT_MARGIN = 6;
  const POPOVER_WIDTH = 320;
  const POPOVER_GAP = 10;
  const COMMENT_ICON_SVG = [
    `<svg class="comment-fab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`,
    `<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z"/>`,
    `</svg>`
  ].join("");

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  function pinPositionFromRect(rect, viewportWidth) {
    const width = Number(viewportWidth) || 0;
    return {
      top: Math.round(Math.max(VIEWPORT_MARGIN, Number(rect.top || 0) - PIN_TOP_OFFSET)),
      left: Math.round(clamp(Number(rect.right || 0) - PIN_RIGHT_OFFSET, VIEWPORT_MARGIN, width - PIN_EDGE_GAP))
    };
  }

  function isRectVisibleInViewport(rect, viewportWidth, viewportHeight) {
    const width = Number(viewportWidth) || 0;
    const height = Number(viewportHeight) || 0;
    return !(rect.right <= 0 || rect.left >= width || rect.bottom <= 0 || rect.top >= height);
  }

  function isVisible(element) {
    if (!element) return false;
    if (element.hidden) return false;
    if (typeof element.hasAttribute === "function" && element.hasAttribute("hidden")) return false;
    if (typeof element.getAttribute === "function" && element.getAttribute("aria-hidden") === "true") return false;
    if (element.style && (element.style.display === "none" || element.style.visibility === "hidden")) return false;
    if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
    return true;
  }

  function resolveVisibleTarget(input) {
    input = input || {};
    if (!input.exact) return null;
    if (isVisible(input.exact)) return input.exact;
    if (isVisible(input.parent)) return input.parent;
    return null;
  }

  function shouldIgnoreCommentClick(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest(".tg") && target.closest(".grid-row.has-children"));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function cssEscape(value) {
    const text = String(value == null ? "" : value);
    if (global.CSS && typeof global.CSS.escape === "function") {
      return global.CSS.escape(text);
    }
    return text.replace(/["\\]/g, "\\$&");
  }

  function currentSheet() {
    return global.document ? global.document.querySelector(".sheet.on") : null;
  }

  function placePanel(panel, rect) {
    const viewportWidth = global.innerWidth || 1024;
    const viewportHeight = global.innerHeight || 768;
    const panelRect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : {};
    const panelWidth = Number(panelRect.width || panel.offsetWidth || POPOVER_WIDTH);
    const panelHeight = Number(panelRect.height || panel.offsetHeight || 180);
    const preferredBelow = Number(rect.bottom || 0) + POPOVER_GAP;
    const preferredAbove = Number(rect.top || 0) - panelHeight - POPOVER_GAP;
    const top = clamp(
      preferredBelow + panelHeight > viewportHeight - VIEWPORT_MARGIN && preferredAbove >= VIEWPORT_MARGIN
        ? preferredAbove
        : preferredBelow,
      VIEWPORT_MARGIN,
      viewportHeight - panelHeight - VIEWPORT_MARGIN
    );
    const left = clamp(rect.right - panelWidth, VIEWPORT_MARGIN, viewportWidth - panelWidth - VIEWPORT_MARGIN);
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function firstMessage(thread) {
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    return messages[0] || null;
  }

  class CommentOverlay {
    constructor({ model, store, pageKey, pageVersion } = {}) {
      this.model = model || global.DashboardCommentModel;
      this.store = store || (global.DashboardCommentStore && global.DashboardCommentStore.createDefaultStore());
      this.pageKey = pageKey || "";
      this.pageVersion = pageVersion || "";
      this.commentMode = false;
      this.threads = [];
      this.layer = null;
      this.fab = null;
      this.composer = null;
      this.popover = null;
      this.initialized = false;
      this.pendingRenderFrame = null;
      this.boundDocumentClick = this.onDocumentClick.bind(this);
      this.boundWindowScroll = this.onWindowScroll.bind(this);
      this.boundResize = this.onResize.bind(this);
    }

    async init() {
      if (!global.document) return;
      if (this.initialized) {
        await this.reloadPins();
        return;
      }
      if (!this.layer) {
        this.layer = global.document.createElement("div");
        this.layer.className = "comment-layer";
        global.document.body.appendChild(this.layer);
      }
      if (!this.fab) {
        this.fab = global.document.createElement("button");
        this.fab.type = "button";
        this.fab.className = "comment-fab";
        this.fab.setAttribute("aria-pressed", "false");
        this.fab.setAttribute("aria-label", "评论");
        this.fab.setAttribute("title", "评论");
        this.fab.innerHTML = COMMENT_ICON_SVG;
        this.fab.addEventListener("click", (event) => {
          event.preventDefault();
          this.setCommentMode(!this.commentMode);
        });
        global.document.body.appendChild(this.fab);
      }
      global.document.addEventListener("click", this.boundDocumentClick, true);
      if (typeof global.addEventListener === "function") {
        global.addEventListener("scroll", this.boundWindowScroll);
        global.addEventListener("resize", this.boundResize);
      }
      this.initialized = true;
      await this.reloadPins();
    }

    destroy() {
      if (!global.document) return;
      global.document.removeEventListener("click", this.boundDocumentClick, true);
      if (typeof global.removeEventListener === "function") {
        global.removeEventListener("scroll", this.boundWindowScroll);
        global.removeEventListener("resize", this.boundResize);
      }
      this.cancelScheduledRenderPins();
      this.setCommentMode(false);
      this.closeComposer();
      this.closePopover();
      if (this.layer) this.layer.remove();
      if (this.fab) this.fab.remove();
      this.layer = null;
      this.fab = null;
      this.initialized = false;
    }

    async reloadPins() {
      if (!this.store || typeof this.store.listThreads !== "function") return;
      this.threads = await this.store.listThreads({
        pageKey: this.pageKey,
        pageVersion: this.pageVersion
      });
      this.renderPins();
    }

    upsertThread(thread) {
      if (!thread || !thread.id) return false;
      const index = this.threads.findIndex((item) => item && item.id === thread.id);
      if (index === -1) this.threads.unshift(thread);
      else this.threads[index] = thread;
      return true;
    }

    setCommentMode(enabled) {
      this.commentMode = Boolean(enabled);
      if (global.document) {
        global.document.body.classList.toggle("comment-mode", this.commentMode);
      }
      if (this.fab) {
        this.fab.classList.toggle("on", this.commentMode);
        this.fab.setAttribute("aria-pressed", this.commentMode ? "true" : "false");
      }
      if (!this.commentMode) this.closeComposer();
    }

    scheduleRenderPins() {
      if (this.pendingRenderFrame) return;
      const run = () => {
        this.pendingRenderFrame = null;
        this.renderPins();
      };
      if (typeof global.requestAnimationFrame === "function") {
        this.pendingRenderFrame = {
          type: "animationFrame",
          id: global.requestAnimationFrame(run)
        };
        return;
      }
      this.pendingRenderFrame = {
        type: "timeout",
        id: global.setTimeout ? global.setTimeout(run, 16) : setTimeout(run, 16)
      };
    }

    cancelScheduledRenderPins() {
      if (!this.pendingRenderFrame) return;
      if (this.pendingRenderFrame.type === "animationFrame" && typeof global.cancelAnimationFrame === "function") {
        global.cancelAnimationFrame(this.pendingRenderFrame.id);
      } else if (this.pendingRenderFrame.type === "timeout") {
        const clear = global.clearTimeout || clearTimeout;
        clear(this.pendingRenderFrame.id);
      }
      this.pendingRenderFrame = null;
    }

    isPageScrollEvent(event) {
      if (!event || !event.target || !global.document) return true;
      return event.target === global ||
        event.target === global.document ||
        event.target === global.document.body ||
        event.target === global.document.documentElement;
    }

    onWindowScroll(event) {
      this.scheduleRenderPins();
      if (!this.isPageScrollEvent(event)) return;
      this.closeComposer();
      this.closePopover();
    }

    onResize() {
      this.scheduleRenderPins();
      this.closeComposer();
      this.closePopover();
    }

    onDocumentClick(event) {
      const pin = event.target && event.target.closest ? event.target.closest(".comment-pin") : null;
      if (pin) {
        event.preventDefault();
        event.stopPropagation();
        this.openPopover(pin.dataset.threadId, pin.getBoundingClientRect());
        return;
      }

      if (!this.commentMode) return;
      if (shouldIgnoreCommentClick(event.target)) return;
      const target = event.target && event.target.closest ? event.target.closest("[data-anchor-id]") : null;
      if (!target) return;
      const sheet = currentSheet();
      if (sheet && !sheet.contains(target)) return;

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

      const anchor = this.model && typeof this.model.readAnchorFromElement === "function"
        ? this.model.readAnchorFromElement(target)
        : null;
      if (anchor) this.openComposer(anchor, target.getBoundingClientRect());
    }

    renderPins() {
      if (!this.layer || !global.document) return;
      this.layer.querySelectorAll(".comment-pin").forEach((pin) => pin.remove());
      const sheet = currentSheet();
      if (!sheet) return;

      this.threads
        .filter((thread) => thread && thread.status === "open" && thread.anchor)
        .forEach((thread) => {
          const target = this.resolveThreadTarget(thread, sheet);
          if (!target) return;
          const rect = target.getBoundingClientRect();
          const viewportWidth = global.innerWidth || 1024;
          const viewportHeight = global.innerHeight || 768;
          if (!isRectVisibleInViewport(rect, viewportWidth, viewportHeight)) return;
          const position = pinPositionFromRect(rect, viewportWidth);
          const pin = global.document.createElement("button");
          pin.type = "button";
          pin.className = "comment-pin";
          pin.dataset.threadId = thread.id;
          pin.setAttribute("aria-label", "打开评论");
          pin.style.top = `${position.top}px`;
          pin.style.left = `${position.left}px`;
          this.layer.appendChild(pin);
        });
    }

    resolveThreadTarget(thread, sheet) {
      if (!this.model || typeof this.model.anchorId !== "function") return null;
      const exactId = this.model.anchorId(thread.anchor);
      const exact = sheet.querySelector(`[data-anchor-id="${cssEscape(exactId)}"]`);
      const parent = this.findParentTarget(thread.anchor, sheet);
      return resolveVisibleTarget({ exact, parent });
    }

    findParentTarget(anchor, sheet) {
      if (!anchor || !sheet || !this.model || typeof this.model.anchorId !== "function") return null;
      if (anchor.anchorType === "cell" && anchor.rowKey) {
        const rowAnchor = {
          ...anchor,
          anchorType: "row",
          columnKey: ""
        };
        const rowId = this.model.anchorId(rowAnchor);
        const rowTarget = sheet.querySelector(`[data-anchor-id="${cssEscape(rowId)}"]`);
        if (rowTarget) return rowTarget;
      }
      if (anchor.rowKey) {
        return sheet.querySelector(`[data-anchor-row="${cssEscape(anchor.rowKey)}"][data-anchor-type="row"]`);
      }
      if (anchor.sectionKey) {
        return sheet.querySelector(`[data-anchor-section="${cssEscape(anchor.sectionKey)}"][data-anchor-type="section"]`);
      }
      return null;
    }

    openComposer(anchor, rect) {
      this.closeComposer();
      this.closePopover();
      if (!this.layer || !global.document) return;

      const composer = global.document.createElement("form");
      composer.className = "comment-composer";
      composer.innerHTML = [
        `<div class="comment-anchor-label">${escapeHtml(this.anchorLabel(anchor))}</div>`,
        `<textarea name="body" rows="4"></textarea>`,
        `<div class="comment-actions">`,
        `<button type="button" data-action="mention">提及</button>`,
        `<button type="button" data-action="cancel">取消</button>`,
        `<button class="primary" type="submit">提交</button>`,
        `</div>`
      ].join("");
      composer.addEventListener("click", (event) => event.stopPropagation());
      composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        const textarea = composer.querySelector("textarea");
        const body = textarea ? textarea.value : "";
        const thread = await this.store.createThread({ anchor, body });
        this.closeComposer();
        if (this.upsertThread(thread)) this.renderPins();
        else await this.reloadPins();
        this.setCommentMode(false);
      });
      composer.querySelector('[data-action="cancel"]').addEventListener("click", () => {
        this.closeComposer();
      });
      composer.querySelector('[data-action="mention"]').addEventListener("click", () => {
        const textarea = composer.querySelector("textarea");
        if (!textarea || !this.model || typeof this.model.makeMentionToken !== "function") return;
        this.insertAtCursor(textarea, this.model.makeMentionToken(anchor));
      });

      this.composer = composer;
      this.layer.appendChild(composer);
      placePanel(composer, rect);
      const textarea = composer.querySelector("textarea");
      if (textarea) textarea.focus();
    }

    closeComposer() {
      if (this.composer) {
        this.composer.remove();
        this.composer = null;
      }
    }

    openPopover(threadId, rect) {
      const thread = this.threads.find((item) => item.id === threadId);
      if (!thread || !this.layer || !global.document) return;
      this.closeComposer();
      this.closePopover();

      const popover = global.document.createElement("div");
      popover.className = "comment-popover";
      popover.innerHTML = this.threadHtml(thread);
      popover.addEventListener("click", (event) => event.stopPropagation());
      popover.querySelector('[data-action="close"]').addEventListener("click", () => this.closePopover());
      popover.querySelector('[data-action="resolve"]').addEventListener("click", async () => {
        const updatedThread = await this.store.resolveThread(thread.id);
        if (updatedThread) this.upsertThread(updatedThread);
        this.closePopover();
        if (updatedThread) this.renderPins();
        else await this.reloadPins();
      });
      popover.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const textarea = popover.querySelector("textarea");
        const body = textarea ? textarea.value : "";
        const updatedThread = await this.store.addMessage(thread.id, { body });
        if (updatedThread) this.upsertThread(updatedThread);
        else await this.reloadPins();
        this.openPopover(thread.id, rect);
      });

      this.popover = popover;
      this.layer.appendChild(popover);
      placePanel(popover, rect);
    }

    closePopover() {
      if (this.popover) {
        this.popover.remove();
        this.popover = null;
      }
    }

    threadHtml(thread) {
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const messageHtml = messages.length
        ? messages.map((message) => {
          const authorName = message.authorName || message.authorId || "未知用户";
          return [
            `<div class="comment-message">`,
            `<div class="comment-message-meta">`,
            `<span class="comment-message-author">${escapeHtml(authorName)}</span>`,
            `</div>`,
            `<div class="comment-message-body">${escapeHtml(message.body)}</div>`,
            `</div>`
          ].join("");
        }).join("")
        : `<div class="comment-message">暂无消息</div>`;
      return [
        `<div class="comment-anchor-label">${escapeHtml(this.anchorLabel(thread.anchor))}</div>`,
        messageHtml,
        `<form>`,
        `<textarea name="body" rows="3"></textarea>`,
        `<div class="comment-actions">`,
        `<button type="button" data-action="close">关闭</button>`,
        `<button type="button" data-action="resolve">解决</button>`,
        `<button class="primary" type="submit">回复</button>`,
        `</div>`,
        `</form>`
      ].join("");
    }

    anchorLabel(anchor) {
      if (this.model && typeof this.model.anchorLabel === "function") {
        return this.model.anchorLabel(anchor);
      }
      return anchor && (anchor.columnLabel || anchor.rowLabel || anchor.sectionTitle || anchor.sheetTitle || anchor.rowKey) || "";
    }

    insertAtCursor(textarea, text) {
      const start = typeof textarea.selectionStart === "number" ? textarea.selectionStart : textarea.value.length;
      const end = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : textarea.value.length;
      const prefix = textarea.value.slice(0, start);
      const suffix = textarea.value.slice(end);
      const spacer = prefix && !/\s$/.test(prefix) ? " " : "";
      const token = `${spacer}${text}`;
      textarea.value = `${prefix}${token}${suffix}`;
      const nextCursor = prefix.length + token.length;
      if (typeof textarea.setSelectionRange === "function") {
        textarea.setSelectionRange(nextCursor, nextCursor);
      }
      textarea.focus();
    }

    firstMessage(thread) {
      return firstMessage(thread);
    }
  }

  global.DashboardCommentOverlay = {
    CommentOverlay,
    pinPositionFromRect,
    isRectVisibleInViewport,
    placePanel,
    resolveVisibleTarget,
    shouldIgnoreCommentClick,
    escapeHtml
  };
})(typeof window !== "undefined" ? window : globalThis);

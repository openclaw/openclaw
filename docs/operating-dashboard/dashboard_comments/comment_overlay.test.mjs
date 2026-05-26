// docs/dashboard_comments/comment_overlay.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadOverlay() {
  const source = readFileSync(join(__dirname, "comment_overlay.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "comment_overlay.js" });
  return sandbox.window.DashboardCommentOverlay;
}

function loadOverlayWithWindow(window) {
  const source = readFileSync(join(__dirname, "comment_overlay.js"), "utf8");
  const sandbox = { window };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "comment_overlay.js" });
  return sandbox.window.DashboardCommentOverlay;
}

function target({ hidden = false } = {}) {
  return {
    hidden,
    style: {},
    hasAttribute(name) {
      return name === "hidden" ? this.hidden : false;
    },
    getAttribute(name) {
      return name === "aria-hidden" && this.hidden ? "true" : null;
    },
    getClientRects() {
      return hidden ? [] : [{ width: 10, height: 10 }];
    }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeElement(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    style: {},
    children: [],
    attributes: {},
    textContent: "",
    type: "",
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    addEventListener() {},
    remove() {
      this.removed = true;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    querySelectorAll() {
      return [];
    }
  };
}

function closestMock(matches) {
  return {
    closest(selector) {
      return matches[selector] || null;
    }
  };
}

test("resolveVisibleTarget returns exact target when it is visible", () => {
  const { resolveVisibleTarget } = loadOverlay();
  const exact = target();
  const parent = target();

  assert.equal(resolveVisibleTarget({ exact, parent }), exact);
});

test("resolveVisibleTarget falls back to parent when exact target is hidden", () => {
  const { resolveVisibleTarget } = loadOverlay();
  const exact = target({ hidden: true });
  const parent = target();

  assert.equal(resolveVisibleTarget({ exact, parent }), parent);
});

test("resolveVisibleTarget returns null when no visible target exists", () => {
  const { resolveVisibleTarget } = loadOverlay();

  assert.equal(resolveVisibleTarget({ exact: target({ hidden: true }), parent: null }), null);
  assert.equal(resolveVisibleTarget({ exact: null, parent: null }), null);
});

test("resolveVisibleTarget does not fall back when exact target is missing", () => {
  const { resolveVisibleTarget } = loadOverlay();

  assert.equal(resolveVisibleTarget({ exact: null, parent: target() }), null);
});

test("pinPositionFromRect places pins near the top-right cell edge and clamps to viewport", () => {
  const { pinPositionFromRect } = loadOverlay();

  assert.deepEqual(
    plain(pinPositionFromRect({ top: 100, right: 220, width: 90, height: 24 }, 1000)),
    { top: 96, left: 211 }
  );
  assert.deepEqual(
    plain(pinPositionFromRect({ top: 20, right: 1010, width: 90, height: 24 }, 1000)),
    { top: 16, left: 978 }
  );
});

test("placePanel keeps the full comment panel inside the viewport", () => {
  const { placePanel } = loadOverlayWithWindow({ innerWidth: 1280, innerHeight: 900 });
  const panel = {
    offsetWidth: 320,
    offsetHeight: 180,
    style: {},
    getBoundingClientRect() {
      return { width: 320, height: 180 };
    }
  };

  placePanel(panel, { top: 820, bottom: 844, right: 1180 });

  assert.equal(panel.style.top, "630px");
  assert.equal(panel.style.left, "860px");
});

test("isRectVisibleInViewport rejects fully offscreen targets", () => {
  const { isRectVisibleInViewport } = loadOverlay();
  const viewportWidth = 1000;
  const viewportHeight = 700;

  assert.equal(isRectVisibleInViewport({ left: -100, right: 0, top: 100, bottom: 124 }, viewportWidth, viewportHeight), false);
  assert.equal(isRectVisibleInViewport({ left: 1000, right: 1100, top: 100, bottom: 124 }, viewportWidth, viewportHeight), false);
  assert.equal(isRectVisibleInViewport({ left: 100, right: 190, top: -50, bottom: 0 }, viewportWidth, viewportHeight), false);
  assert.equal(isRectVisibleInViewport({ left: 100, right: 190, top: 700, bottom: 724 }, viewportWidth, viewportHeight), false);
});

test("isRectVisibleInViewport keeps partially visible targets visible", () => {
  const { isRectVisibleInViewport } = loadOverlay();
  const viewportWidth = 1000;
  const viewportHeight = 700;

  assert.equal(isRectVisibleInViewport({ left: -100, right: 1, top: 100, bottom: 124 }, viewportWidth, viewportHeight), true);
  assert.equal(isRectVisibleInViewport({ left: 999, right: 1100, top: 100, bottom: 124 }, viewportWidth, viewportHeight), true);
  assert.equal(isRectVisibleInViewport({ left: 100, right: 190, top: -50, bottom: 1 }, viewportWidth, viewportHeight), true);
  assert.equal(isRectVisibleInViewport({ left: 100, right: 190, top: 699, bottom: 724 }, viewportWidth, viewportHeight), true);
});

test("escapeHtml prevents raw script injection in rendered message bodies", () => {
  const { escapeHtml } = loadOverlay();

  assert.equal(
    escapeHtml("hello <script>alert('x')</script> & bye"),
    "hello &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; bye"
  );
});

test("threadHtml renders author names without timestamps", () => {
  const { CommentOverlay } = loadOverlay();
  const overlay = new CommentOverlay({});
  const html = overlay.threadHtml({
    anchor: { rowLabel: "新增 UV" },
    messages: [{
      body: "需要确认口径",
      authorName: "OpenClaw User",
      authorId: "feishu_on_abc",
      createdAt: "2026-05-25T00:00:00.000Z"
    }]
  });

  assert.match(html, /comment-message-author/);
  assert.match(html, /OpenClaw User/);
  assert.match(html, /需要确认口径/);
  assert.doesNotMatch(html, /comment-message-time/);
  assert.doesNotMatch(html, /2026-05-25T00:00:00.000Z/);
});

test("init uses a comment icon FAB instead of the text glyph", async () => {
  const bodyChildren = [];
  const window = {
    innerWidth: 1000,
    innerHeight: 700,
    document: {
      body: {
        classList: { toggle() {} },
        appendChild(element) {
          bodyChildren.push(element);
        }
      },
      createElement: fakeElement,
      querySelector() {
        return null;
      },
      addEventListener() {},
      removeEventListener() {}
    },
    addEventListener() {},
    removeEventListener() {}
  };
  const { CommentOverlay } = loadOverlayWithWindow(window);
  const overlay = new CommentOverlay({
    store: {
      async listThreads() {
        return [];
      }
    }
  });

  await overlay.init();

  const fab = bodyChildren.find((element) => element.className === "comment-fab");
  assert.ok(fab);
  assert.equal(fab.textContent, "");
  assert.match(fab.innerHTML, /comment-fab-icon/);
  assert.equal(fab.attributes["aria-label"], "评论");
});

test("destroy clears comment mode from body and FAB state", () => {
  const bodyClassNames = new Set(["comment-mode"]);
  const fabClassNames = new Set(["comment-fab", "on"]);
  const window = {
    document: {
      body: {
        classList: {
          toggle(name, enabled) {
            if (enabled) bodyClassNames.add(name);
            else bodyClassNames.delete(name);
          }
        }
      },
      removeEventListener() {}
    },
    removeEventListener() {}
  };
  const { CommentOverlay } = loadOverlayWithWindow(window);
  const overlay = new CommentOverlay({});
  overlay.commentMode = true;
  overlay.layer = { remove() {} };
  const fab = {
    remove() {},
    classList: {
      toggle(name, enabled) {
        if (enabled) fabClassNames.add(name);
        else fabClassNames.delete(name);
      }
    },
    setAttribute(name, value) {
      this[name] = value;
    }
  };
  overlay.fab = fab;

  overlay.destroy();

  assert.equal(bodyClassNames.has("comment-mode"), false);
  assert.equal(fabClassNames.has("on"), false);
  assert.equal(overlay.commentMode, false);
  assert.equal(fab["aria-pressed"], "false");
});

test("scheduleRenderPins coalesces repeated calls into one frame", () => {
  const callbacks = [];
  const window = {
    requestAnimationFrame(callback) {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelAnimationFrame() {}
  };
  const { CommentOverlay } = loadOverlayWithWindow(window);
  const overlay = new CommentOverlay({});
  let renderCount = 0;
  overlay.renderPins = () => {
    renderCount += 1;
  };

  overlay.scheduleRenderPins();
  overlay.scheduleRenderPins();
  overlay.scheduleRenderPins();

  assert.equal(callbacks.length, 1);
  assert.equal(renderCount, 0);
  callbacks.shift()();
  assert.equal(renderCount, 1);

  overlay.scheduleRenderPins();
  assert.equal(callbacks.length, 1);
});

test("upsertThread updates local thread state without forcing a reload", () => {
  const { CommentOverlay } = loadOverlay();
  const overlay = new CommentOverlay({});
  overlay.threads = [{ id: "thread-1", status: "open", messages: [] }];

  assert.equal(overlay.upsertThread({ id: "thread-2", status: "open", messages: [] }), true);
  assert.deepEqual(plain(overlay.threads.map((thread) => thread.id)), ["thread-2", "thread-1"]);

  assert.equal(overlay.upsertThread({ id: "thread-1", status: "resolved", messages: [] }), true);
  assert.deepEqual(plain(overlay.threads), [
    { id: "thread-2", status: "open", messages: [] },
    { id: "thread-1", status: "resolved", messages: [] }
  ]);
  assert.equal(overlay.upsertThread(null), false);
});

test("init is idempotent and does not duplicate layer, FAB, or listeners", async () => {
  const bodyChildren = [];
  const documentListeners = [];
  const windowListeners = [];
  const window = {
    innerWidth: 1000,
    innerHeight: 700,
    document: {
      body: {
        classList: { toggle() {} },
        appendChild(element) {
          bodyChildren.push(element);
        }
      },
      createElement: fakeElement,
      querySelector() {
        return null;
      },
      addEventListener(type) {
        documentListeners.push(type);
      },
      removeEventListener() {}
    },
    addEventListener(type) {
      windowListeners.push(type);
    },
    removeEventListener() {}
  };
  const { CommentOverlay } = loadOverlayWithWindow(window);
  const overlay = new CommentOverlay({
    store: {
      async listThreads() {
        return [];
      }
    }
  });

  await overlay.init();
  await overlay.init();

  assert.equal(bodyChildren.filter((element) => element.className === "comment-layer").length, 1);
  assert.equal(bodyChildren.filter((element) => element.className === "comment-fab").length, 1);
  assert.deepEqual(documentListeners, ["click"]);
  assert.deepEqual(windowListeners, ["scroll", "resize"]);
});

test("element scroll schedules pins without closing floating UI", () => {
  const callbacks = [];
  const window = {
    document: {
      body: {},
      documentElement: {}
    },
    requestAnimationFrame(callback) {
      callbacks.push(callback);
      return callbacks.length;
    }
  };
  const { CommentOverlay } = loadOverlayWithWindow(window);
  const overlay = new CommentOverlay({});
  let composerRemoved = false;
  let popoverRemoved = false;
  overlay.composer = { remove() { composerRemoved = true; } };
  overlay.popover = { remove() { popoverRemoved = true; } };
  overlay.renderPins = () => {};

  overlay.onWindowScroll({ target: { className: "right-pane" } });

  assert.equal(callbacks.length, 1);
  assert.equal(composerRemoved, false);
  assert.equal(popoverRemoved, false);
});

test("shouldIgnoreCommentClick passes through explicit drilldown toggles", () => {
  const { shouldIgnoreCommentClick } = loadOverlay();
  const expandableRow = { className: "grid-row has-children" };
  const toggle = closestMock({
    ".tg": {},
    ".grid-row.has-children": expandableRow
  });

  assert.equal(shouldIgnoreCommentClick(toggle), true);
});

test("shouldIgnoreCommentClick allows non-toggle anchor clicks", () => {
  const { shouldIgnoreCommentClick } = loadOverlay();
  const label = closestMock({
    "[data-anchor-id]": {}
  });

  assert.equal(shouldIgnoreCommentClick(label), false);
});

(function attachCommentStore(global) {
  "use strict";

  const STORAGE_KEY = "moclaw-dashboard-comments";
  const API_BASE = "/api/dashboard-comments";
  const JSON_HEADERS = { "Content-Type": "application/json" };
  const REQUIRED_ANCHOR_FIELDS = {
    sheet: ["pageKey", "pageVersion", "sheetKey", "anchorType"],
    section: ["pageKey", "pageVersion", "sheetKey", "sectionKey", "anchorType"],
    row: ["pageKey", "pageVersion", "sheetKey", "sectionKey", "rowKey", "anchorType"],
    cell: ["pageKey", "pageVersion", "sheetKey", "sectionKey", "rowKey", "columnKey", "anchorType"]
  };

  function defaultNow() {
    return new Date().toISOString();
  }

  function defaultIdFactory() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readThreads(storage, storageKey) {
    const raw = storage.getItem(storageKey);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (_error) {
      // Corrupted localStorage should not block the dashboard from loading.
    }
    writeThreads(storage, storageKey, []);
    return [];
  }

  function writeThreads(storage, storageKey, threads) {
    storage.setItem(storageKey, JSON.stringify(threads));
  }

  function findThreadIndex(threads, threadId) {
    return threads.findIndex((thread) => thread.id === threadId);
  }

  function missingThread(threadId) {
    return new Error(`Thread not found: ${threadId}`);
  }

  function isPresent(value) {
    return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
  }

  function isValidAnchorShape(anchor) {
    if (!anchor || typeof anchor !== "object") return false;
    const required = REQUIRED_ANCHOR_FIELDS[anchor.anchorType];
    if (!required) return false;
    return required.every((field) => isPresent(anchor[field]));
  }

  function assertValidAnchor(anchor) {
    if (!isValidAnchorShape(anchor)) {
      throw new Error("Invalid comment anchor");
    }
  }

  function assertValidBody(body) {
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new Error("Comment body is required");
    }
  }

  function encodeQuery(params) {
    return Object.keys(params)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key]).replace(/%20/g, "+")}`)
      .join("&");
  }

  class LocalCommentStore {
    constructor(options) {
      if (typeof options === "string") {
        options = { storageKey: options };
      }
      options = options || {};
      this.storage = options.storage || global.localStorage;
      this.storageKey = options.storageKey || STORAGE_KEY;
      this.now = options.now || defaultNow;
      this.idFactory = options.idFactory || defaultIdFactory;
      if (!this.storage) {
        throw new Error("LocalCommentStore requires localStorage");
      }
    }

    async listThreads(filter) {
      filter = filter || {};
      return readThreads(this.storage, this.storageKey).filter((thread) => {
        return thread.anchor &&
          thread.anchor.pageKey === filter.pageKey &&
          thread.anchor.pageVersion === filter.pageVersion;
      });
    }

    async createThread({ anchor, body }) {
      assertValidAnchor(anchor);
      assertValidBody(body);
      const idToken = this.idFactory();
      const createdAt = this.now();
      const thread = {
        id: `thread-${idToken}`,
        anchor: clone(anchor),
        status: "open",
        createdAt,
        updatedAt: createdAt,
        messages: [{
          id: `message-${idToken}`,
          body,
          createdAt
        }]
      };
      const threads = readThreads(this.storage, this.storageKey);
      threads.push(thread);
      writeThreads(this.storage, this.storageKey, threads);
      return thread;
    }

    async addMessage(threadId, { body }) {
      assertValidBody(body);
      const threads = readThreads(this.storage, this.storageKey);
      const index = findThreadIndex(threads, threadId);
      if (index === -1) throw missingThread(threadId);

      const createdAt = this.now();
      threads[index].messages = threads[index].messages || [];
      threads[index].messages.push({
        id: `message-${this.idFactory()}`,
        body,
        createdAt
      });
      threads[index].updatedAt = createdAt;
      writeThreads(this.storage, this.storageKey, threads);
      return threads[index];
    }

    async resolveThread(threadId) {
      const threads = readThreads(this.storage, this.storageKey);
      const index = findThreadIndex(threads, threadId);
      if (index === -1) throw missingThread(threadId);

      threads[index].status = "resolved";
      threads[index].updatedAt = this.now();
      writeThreads(this.storage, this.storageKey, threads);
      return threads[index];
    }
  }

  class HttpCommentStore {
    constructor(options) {
      if (typeof options === "string") {
        options = { base: options };
      }
      options = options || {};
      this.base = String(options.base || API_BASE).replace(/\/+$/, "");
      this.fetch = options.fetch || ((...args) => global.fetch(...args));
    }

    async listThreads({ pageKey, pageVersion }) {
      const params = encodeQuery({ pageKey, pageVersion });
      const payload = await this.request(`/threads?${params}`, { method: "GET" });
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.threads)) return payload.threads;
      return [];
    }

    async createThread({ anchor, body }) {
      assertValidAnchor(anchor);
      assertValidBody(body);
      return this.request("/threads", {
        method: "POST",
        body: JSON.stringify({ anchor, body })
      });
    }

    async addMessage(threadId, { body }) {
      assertValidBody(body);
      return this.request(`/threads/${encodeURIComponent(threadId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body })
      });
    }

    async resolveThread(threadId) {
      return this.request(`/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "resolved" })
      });
    }

    async request(path, options) {
      if (!this.fetch) {
        throw new Error("HttpCommentStore requires fetch");
      }
      const response = await this.fetch(`${this.base}${path}`, {
        credentials: "include",
        headers: JSON_HEADERS,
        ...options
      });
      if (!response.ok) {
        const errorText = await readResponseText(response);
        const suffix = errorText ? ` ${errorText}` : "";
        throw new Error(`Dashboard comments request failed: ${response.status || "unknown"}${suffix}`);
      }
      if (response.status === 204) return null;
      const text = await readResponseText(response);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_error) {
        return null;
      }
    }
  }

  async function readResponseText(response) {
    if (typeof response.text === "function") {
      return response.text();
    }
    if (typeof response.json === "function") {
      return JSON.stringify(await response.json());
    }
    return "";
  }

  function createDefaultStore() {
    if (global.DASHBOARD_COMMENTS_API_BASE) {
      return new HttpCommentStore({ base: global.DASHBOARD_COMMENTS_API_BASE });
    }
    return new LocalCommentStore("moclaw-operating-dashboard-comments");
  }

  global.DashboardCommentStore = {
    LocalCommentStore,
    HttpCommentStore,
    createDefaultStore
  };
})(typeof window !== "undefined" ? window : globalThis);

// docs/dashboard_comments/comment_store.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createLocalStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadStore(overrides = {}) {
  const source = readFileSync(join(__dirname, "comment_store.js"), "utf8");
  const sandbox = {
    window: {},
    console,
    ...overrides
  };
  sandbox.window = {
    localStorage: createLocalStorage(),
    ...overrides.window
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "comment_store.js" });
  return sandbox.window.DashboardCommentStore;
}

const anchorA = {
  pageKey: "moclaw_operating_dashboard",
  pageVersion: "v1",
  sheetKey: "user_acquisition",
  sectionKey: "paid_media",
  rowKey: "ad_spend",
  columnKey: "today_2026_05_22",
  anchorType: "cell"
};

const anchorB = {
  ...anchorA,
  pageVersion: "v3",
  columnKey: "today_2026_05_23"
};

test("local store creates and persists open threads with a first message", async () => {
  const storage = createLocalStorage();
  const { LocalCommentStore } = loadStore({ window: { localStorage: storage } });

  const store = new LocalCommentStore({ idFactory: () => "id-1", now: () => "2026-05-25T00:00:00.000Z" });
  const thread = await store.createThread({ anchor: anchorA, body: "这里的落地率口径是什么？" });

  assert.equal(thread.id, "thread-id-1");
  assert.equal(thread.status, "open");
  assert.deepEqual(plain(thread.anchor), anchorA);
  assert.deepEqual(plain(thread.messages), [{
    id: "message-id-1",
    body: "这里的落地率口径是什么？",
    createdAt: "2026-05-25T00:00:00.000Z"
  }]);

  const reloaded = new LocalCommentStore({ storage });
  assert.deepEqual(plain(await reloaded.listThreads({
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1"
  })), plain([thread]));
});

test("local store accepts a storage key string constructor", async () => {
  const storage = createLocalStorage();
  const { LocalCommentStore } = loadStore({ window: { localStorage: storage } });

  const store = new LocalCommentStore("test-comments");
  await store.createThread({ anchor: anchorA, body: "string constructor" });

  assert.equal(storage.getItem("dashboard_comment_threads_v1"), null);
  assert.equal(JSON.parse(storage.getItem("test-comments")).length, 1);
});

test("local store no-arg constructor uses the planned default storage key", async () => {
  const storage = createLocalStorage();
  const { LocalCommentStore } = loadStore({ window: { localStorage: storage } });

  const store = new LocalCommentStore();
  await store.createThread({ anchor: anchorA, body: "default constructor" });

  assert.equal(storage.getItem("dashboard_comment_threads_v1"), null);
  assert.equal(JSON.parse(storage.getItem("moclaw-dashboard-comments")).length, 1);
});

test("local store recovers from corrupted localStorage JSON", async () => {
  const storage = createLocalStorage({ "test-comments": "{not valid json" });
  const { LocalCommentStore } = loadStore({ window: { localStorage: storage } });
  const store = new LocalCommentStore("test-comments");

  assert.deepEqual(plain(await store.listThreads({
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1"
  })), []);
  assert.equal(storage.getItem("test-comments"), "[]");
});

test("local store listThreads filters by anchor page key and version", async () => {
  const storage = createLocalStorage();
  const { LocalCommentStore } = loadStore({ window: { localStorage: storage } });
  let nextId = 0;
  const store = new LocalCommentStore({
    storage,
    idFactory: () => `id-${++nextId}`,
    now: () => "2026-05-25T00:00:00.000Z"
  });

  const visible = await store.createThread({ anchor: anchorA, body: "v1 comment" });
  await store.createThread({ anchor: anchorB, body: "v3 comment" });

  assert.deepEqual(plain(await store.listThreads({
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1"
  })), plain([visible]));
});

test("local store appends messages and resolves existing threads", async () => {
  const storage = createLocalStorage();
  const { LocalCommentStore } = loadStore({ window: { localStorage: storage } });
  let nextId = 0;
  const store = new LocalCommentStore({
    storage,
    idFactory: () => `id-${++nextId}`,
    now: () => "2026-05-25T00:00:00.000Z"
  });
  const thread = await store.createThread({ anchor: anchorA, body: "first" });

  const afterMessage = await store.addMessage(thread.id, { body: "second" });
  assert.equal(afterMessage.messages.length, 2);
  assert.equal(afterMessage.messages[1].body, "second");

  const resolved = await store.resolveThread(thread.id);
  assert.equal(resolved.status, "resolved");
  assert.equal((await store.listThreads({
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1"
  }))[0].status, "resolved");
});

test("local store throws for missing threads", async () => {
  const { LocalCommentStore } = loadStore();
  const store = new LocalCommentStore();

  await assert.rejects(
    () => store.addMessage("missing-thread", { body: "reply" }),
    /Thread not found: missing-thread/
  );
  await assert.rejects(
    () => store.resolveThread("missing-thread"),
    /Thread not found: missing-thread/
  );
});

test("local store validates anchors and message bodies at the boundary", async () => {
  const { LocalCommentStore } = loadStore();
  const store = new LocalCommentStore();
  const thread = await store.createThread({ anchor: anchorA, body: "first" });

  await assert.rejects(
    () => store.createThread({ anchor: null, body: "comment" }),
    /Invalid comment anchor/
  );
  await assert.rejects(
    () => store.createThread({ anchor: { ...anchorA, columnKey: "" }, body: "comment" }),
    /Invalid comment anchor/
  );
  await assert.rejects(
    () => store.createThread({ anchor: anchorA, body: "  \n " }),
    /Comment body is required/
  );
  await assert.rejects(
    () => store.addMessage(thread.id, { body: "" }),
    /Comment body is required/
  );
});

test("http store sends JSON requests with credentials", async () => {
  const calls = [];
  const response = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const fetch = (url, options) => {
    calls.push({ url, options });
    return response({ ok: true });
  };
  const { HttpCommentStore } = loadStore({ window: { fetch } });
  const store = new HttpCommentStore({ base: "/api/dashboard-comments" });

  await store.listThreads({ pageKey: "page 1", pageVersion: "v1" });
  await store.createThread({ anchor: anchorA, body: "first" });
  await store.addMessage("thread-1", { body: "second" });
  await store.resolveThread("thread-1");

  assert.deepEqual(plain(calls), [
    {
      url: "/api/dashboard-comments/threads?pageKey=page+1&pageVersion=v1",
      options: {
        method: "GET",
        credentials: "include",
        headers: { "Content-Type": "application/json" }
      }
    },
    {
      url: "/api/dashboard-comments/threads",
      options: {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anchor: anchorA, body: "first" })
      }
    },
    {
      url: "/api/dashboard-comments/threads/thread-1/messages",
      options: {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "second" })
      }
    },
    {
      url: "/api/dashboard-comments/threads/thread-1",
      options: {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved" })
      }
    }
  ]);
});

test("http store accepts a base URL string constructor", async () => {
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  };
  const { HttpCommentStore } = loadStore({ window: { fetch } });
  const store = new HttpCommentStore("/api/dashboard-comments");

  await store.listThreads({ pageKey: "page-1", pageVersion: "v1" });

  assert.equal(calls[0].url, "/api/dashboard-comments/threads?pageKey=page-1&pageVersion=v1");
});

test("http store no-arg constructor uses the planned default API base", async () => {
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  };
  const { HttpCommentStore } = loadStore({ window: { fetch } });
  const store = new HttpCommentStore();

  await store.listThreads({ pageKey: "page-1", pageVersion: "v1" });

  assert.equal(calls[0].url, "/api/dashboard-comments/threads?pageKey=page-1&pageVersion=v1");
});

test("http store binds native window fetch when using the default fetch", async () => {
  const calls = [];
  const window = {
    fetch(url, options) {
      assert.ok(this && this.localStorage, "default fetch should be called with the browser window as this");
      calls.push({ url, options });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ threads: [] }) });
    }
  };
  const { HttpCommentStore } = loadStore({ window });
  const store = new HttpCommentStore("/api/dashboard-comments");

  await store.listThreads({ pageKey: "page-1", pageVersion: "v1" });

  assert.equal(calls[0].url, "/api/dashboard-comments/threads?pageKey=page-1&pageVersion=v1");
});

test("http store normalizes the API thread envelope to an array", async () => {
  const apiThread = { id: "thread-1", anchor: anchorA, status: "open", messages: [] };
  const fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ threads: [apiThread] })
  });
  const { HttpCommentStore } = loadStore({ window: { fetch } });
  const store = new HttpCommentStore("/api/dashboard-comments");

  const threads = await store.listThreads({ pageKey: "page-1", pageVersion: "v1" });

  assert.deepEqual(plain(threads), [apiThread]);
});

test("http store validates payloads before sending requests", async () => {
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  const { HttpCommentStore } = loadStore({ window: { fetch } });
  const store = new HttpCommentStore("/api/dashboard-comments");

  await assert.rejects(
    () => store.createThread({ anchor: { ...anchorA, rowKey: "" }, body: "comment" }),
    /Invalid comment anchor/
  );
  await assert.rejects(
    () => store.createThread({ anchor: anchorA, body: "\t " }),
    /Comment body is required/
  );
  await assert.rejects(
    () => store.addMessage("thread-1", { body: " " }),
    /Comment body is required/
  );
  assert.equal(calls.length, 0);
});

test("http store handles empty success responses and useful error bodies", async () => {
  const responses = [
    { ok: true, status: 204, text: () => Promise.resolve("") },
    { ok: true, status: 200, text: () => Promise.resolve("") },
    { ok: true, status: 200, text: () => Promise.resolve("created") },
    { ok: false, status: 422, text: () => Promise.resolve("invalid anchor") }
  ];
  const fetch = () => Promise.resolve(responses.shift());
  const { HttpCommentStore } = loadStore({ window: { fetch } });
  const store = new HttpCommentStore("/api/dashboard-comments");

  assert.equal(await store.resolveThread("thread-1"), null);
  assert.equal(await store.resolveThread("thread-1"), null);
  assert.equal(await store.resolveThread("thread-1"), null);
  await assert.rejects(
    () => store.resolveThread("thread-1"),
    /Dashboard comments request failed: 422 invalid anchor/
  );
});

test("createDefaultStore chooses HTTP only when API base is configured", () => {
  const localApi = loadStore();
  assert.equal(localApi.createDefaultStore() instanceof localApi.LocalCommentStore, true);

  const httpApi = loadStore({ window: { DASHBOARD_COMMENTS_API_BASE: "/api/comments" } });
  assert.equal(httpApi.createDefaultStore() instanceof httpApi.HttpCommentStore, true);
});

test("createDefaultStore local fallback uses the planned dashboard storage key", async () => {
  const storage = createLocalStorage();
  const api = loadStore({ window: { localStorage: storage } });

  const store = api.createDefaultStore();
  await store.createThread({ anchor: anchorA, body: "default local key" });

  assert.equal(storage.getItem("dashboard_comment_threads_v1"), null);
  assert.equal(JSON.parse(storage.getItem("moclaw-operating-dashboard-comments")).length, 1);
});

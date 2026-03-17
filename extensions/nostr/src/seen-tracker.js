function createSeenTracker(options) {
  const maxEntries = options?.maxEntries ?? 1e5;
  const ttlMs = options?.ttlMs ?? 60 * 60 * 1e3;
  const pruneIntervalMs = options?.pruneIntervalMs ?? 10 * 60 * 1e3;
  const entries = /* @__PURE__ */ new Map();
  let head = null;
  let tail = null;
  function moveToFront(id) {
    const entry = entries.get(id);
    if (!entry) {
      return;
    }
    if (head === id) {
      return;
    }
    if (entry.prev) {
      const prevEntry = entries.get(entry.prev);
      if (prevEntry) {
        prevEntry.next = entry.next;
      }
    }
    if (entry.next) {
      const nextEntry = entries.get(entry.next);
      if (nextEntry) {
        nextEntry.prev = entry.prev;
      }
    }
    if (tail === id) {
      tail = entry.prev;
    }
    entry.prev = null;
    entry.next = head;
    if (head) {
      const headEntry = entries.get(head);
      if (headEntry) {
        headEntry.prev = id;
      }
    }
    head = id;
    if (!tail) {
      tail = id;
    }
  }
  function removeFromList(id) {
    const entry = entries.get(id);
    if (!entry) {
      return;
    }
    if (entry.prev) {
      const prevEntry = entries.get(entry.prev);
      if (prevEntry) {
        prevEntry.next = entry.next;
      }
    } else {
      head = entry.next;
    }
    if (entry.next) {
      const nextEntry = entries.get(entry.next);
      if (nextEntry) {
        nextEntry.prev = entry.prev;
      }
    } else {
      tail = entry.prev;
    }
  }
  function evictLRU() {
    if (!tail) {
      return;
    }
    const idToEvict = tail;
    removeFromList(idToEvict);
    entries.delete(idToEvict);
  }
  function insertAtFront(id, seenAt) {
    const newEntry = {
      seenAt,
      prev: null,
      next: head
    };
    if (head) {
      const headEntry = entries.get(head);
      if (headEntry) {
        headEntry.prev = id;
      }
    }
    entries.set(id, newEntry);
    head = id;
    if (!tail) {
      tail = id;
    }
  }
  function pruneExpired() {
    const now = Date.now();
    const toDelete = [];
    for (const [id, entry] of entries) {
      if (now - entry.seenAt > ttlMs) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      removeFromList(id);
      entries.delete(id);
    }
  }
  let pruneTimer;
  if (pruneIntervalMs > 0) {
    pruneTimer = setInterval(pruneExpired, pruneIntervalMs);
    if (pruneTimer.unref) {
      pruneTimer.unref();
    }
  }
  function add(id) {
    const now = Date.now();
    const existing = entries.get(id);
    if (existing) {
      existing.seenAt = now;
      moveToFront(id);
      return;
    }
    while (entries.size >= maxEntries) {
      evictLRU();
    }
    insertAtFront(id, now);
  }
  function has(id) {
    const entry = entries.get(id);
    if (!entry) {
      add(id);
      return false;
    }
    if (Date.now() - entry.seenAt > ttlMs) {
      removeFromList(id);
      entries.delete(id);
      add(id);
      return false;
    }
    entry.seenAt = Date.now();
    moveToFront(id);
    return true;
  }
  function peek(id) {
    const entry = entries.get(id);
    if (!entry) {
      return false;
    }
    if (Date.now() - entry.seenAt > ttlMs) {
      removeFromList(id);
      entries.delete(id);
      return false;
    }
    return true;
  }
  function deleteEntry(id) {
    if (entries.has(id)) {
      removeFromList(id);
      entries.delete(id);
    }
  }
  function clear() {
    entries.clear();
    head = null;
    tail = null;
  }
  function size() {
    return entries.size;
  }
  function stop() {
    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = void 0;
    }
  }
  function seed(ids) {
    const now = Date.now();
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (!entries.has(id) && entries.size < maxEntries) {
        insertAtFront(id, now);
      }
    }
  }
  return {
    has,
    add,
    peek,
    delete: deleteEntry,
    clear,
    size,
    stop,
    seed
  };
}
export {
  createSeenTracker
};

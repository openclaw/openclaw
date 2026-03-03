const SKILLS_SYNC_QUEUE = new Map();
export async function serializeByKey(key, task) {
    const prev = SKILLS_SYNC_QUEUE.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    SKILLS_SYNC_QUEUE.set(key, next);
    try {
        return await next;
    }
    finally {
        if (SKILLS_SYNC_QUEUE.get(key) === next) {
            SKILLS_SYNC_QUEUE.delete(key);
        }
    }
}

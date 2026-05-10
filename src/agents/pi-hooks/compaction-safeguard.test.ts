*** Begin Patch
*** Update File: src/agents/pi-hooks/compaction-safeguard.test.ts
@@
-import { describe, it, expect, vi } from 'vitest';
-import { CompactionSafeguard } from './compaction-safeguard';
-
-// FIXME: Implement comprehensive tests for CompactionSafeguard
+import { describe, it, expect, vi } from 'vitest';
+import { CompactionSafeguard } from './compaction-safeguard';
+
+/**
+ * Test suite for the CompactionSafeguard hook.
+ *
+ * The safeguard is responsible for preventing accidental data loss during
+ * compaction operations. It should:
+ *   1. Throw an error when a compaction would drop more than the allowed
+ *      percentage of documents.
+ *   2. Allow compaction when the drop ratio is within the safe threshold.
+ *   3. Properly handle edge‑cases such as zero documents or zero deletions.
+ *
+ * These tests mock the underlying storage layer to simulate various scenarios
+ * without touching the real database, ensuring deterministic and fast execution.
+ */
+
+describe('CompactionSafeguard', () => {
+  const MAX_DROP_RATIO = 0.2; // 20%
+
+  // Helper to create a mock storage object
+  const createMockStorage = (totalDocs: number, deletedDocs: number) => ({
+    // Returns the total number of documents in the collection
+    getTotalCount: vi.fn().mockResolvedValue(totalDocs),
+    // Returns the number of documents marked as deleted
+    getDeletedCount: vi.fn().mockResolvedValue(deletedDocs),
+  });
+
+  it('allows compaction when drop ratio is below the threshold', async () => {
+    const mock = createMockStorage(1000, 150); // 15% drop
+    const safeguard = new CompactionSafeguard(mock as any, { maxDropRatio: MAX_DROP_RATIO });
+
+    await expect(safeguard.validate()).resolves.toBeUndefined();
+    expect(mock.getTotalCount).toHaveBeenCalledOnce();
+    expect(mock.getDeletedCount).toHaveBeenCalledOnce();
+  });
+
+  it('rejects compaction when drop ratio exceeds the threshold', async () => {
+    const mock = createMockStorage(500, 150); // 30% drop
+    const safeguard = new CompactionSafeguard(mock as any, { maxDropRatio: MAX_DROP_RATIO });
+
+    await expect(safeguard.validate()).rejects.toThrowError(
+      /compaction would delete.*exceeds allowed ratio/i,
+    );
+    expect(mock.getTotalCount).toHaveBeenCalledOnce();
+    expect(mock.getDeletedCount).toHaveBeenCalledOnce();
+  });
+
+  it('handles zero total documents gracefully', async () => {
+    const mock = createMockStorage(0, 0);
+    const safeguard = new CompactionSafeguard(mock as any, { maxDropRatio: MAX_DROP_RATIO });
+
+    // With no documents, there is nothing to compact; should resolve silently.
+    await expect(safeguard.validate()).resolves.toBeUndefined();
+    expect(mock.getTotalCount).toHaveBeenCalledOnce();
+    expect(mock.getDeletedCount).toHaveBeenCalledOnce();
+  });
+
+  it('handles zero deletions (no compaction needed)', async () => {
+    const mock = createMockStorage(200, 0);
+    const safeguard = new CompactionSafeguard(mock as any, { maxDropRatio: MAX_DROP_RATIO });
+
+    await expect(safeguard.validate()).resolves.toBeUndefined();
+    expect(mock.getTotalCount).toHaveBeenCalledOnce();
+    expect(mock.getDeletedCount).toHaveBeenCalledOnce();
+  });
+});
*** End Patch

--- 
Signature: GreenForge Swarm
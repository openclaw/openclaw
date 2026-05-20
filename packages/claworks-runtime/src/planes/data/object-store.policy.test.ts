import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "./db.js";
import { createObjectStore } from "./object-store.js";

describe("objectStore onPolicyWrite", () => {
  it("fires callback when RbacPolicy is created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-osp-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const onPolicyWrite = vi.fn();
    const store = createObjectStore(db, { onPolicyWrite });

    await store.create("RbacPolicy", {
      id: "test-policy",
      action: "rest.read",
      resource: "*",
      subjectType: "apikey",
      subjectId: "*",
      effect: "allow",
    });

    expect(onPolicyWrite).toHaveBeenCalledWith("RbacPolicy");
    close();
  });
});

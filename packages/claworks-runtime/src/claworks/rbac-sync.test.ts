import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIngressRouter, DEFAULT_INGRESS_POLICIES } from "../kernel/ingress.js";
import { openDatabase } from "../planes/data/db.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { syncIngressFromObjectStore, syncRbacFromObjectStore } from "./rbac-sync.js";
import { createRbacGuard, DEFAULT_RBAC_POLICIES } from "./robot-identity.js";
import type { ClaworksRuntime } from "./runtime-types.js";

function minimalRuntime(dbPath: string): ClaworksRuntime {
  const { db, close } = openDatabase(`sqlite://${dbPath}`);
  const objectStore = createObjectStore(db);
  const runtime = {
    objectStore,
    rbac: createRbacGuard([...DEFAULT_RBAC_POLICIES]),
    ingress: createIngressRouter(),
    logger: () => undefined,
  } as unknown as ClaworksRuntime;
  (runtime as { close: () => void }).close = close;
  return runtime;
}

describe("rbac-sync", () => {
  it("syncIngressFromObjectStore resets to defaults when store is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-ingress-sync-"));
    const runtime = minimalRuntime(join(dir, "t.db"));
    runtime.ingress.reload([
      {
        id: "custom-only",
        source: "im",
        eventTypePattern: "*",
        decision: { action: "deny", reason: "test" },
        priority: 200,
      },
    ]);

    await syncIngressFromObjectStore(runtime);

    const decision = runtime.ingress.decide("connector", "alarm.created", "x");
    expect(decision.action).toBe("kernel");
    expect(DEFAULT_INGRESS_POLICIES.some((p) => p.id === "connector-kernel")).toBe(true);
    (runtime as { close: () => void }).close();
  });

  it("syncRbacFromObjectStore resets to defaults when store is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-rbac-sync-"));
    const runtime = minimalRuntime(join(dir, "t2.db"));
    runtime.rbac.reload([
      {
        id: "deny-all",
        action: "*",
        resource: "*",
        subjectType: "apikey",
        subjectId: "*",
        effect: "deny",
      },
    ]);

    await syncRbacFromObjectStore(runtime);

    const result = runtime.rbac.check({
      action: "rest.write",
      resource: "event:*",
      subjectType: "apikey",
      subjectId: "k1",
    });
    expect(result.allowed).toBe(true);
    expect(DEFAULT_RBAC_POLICIES.some((p) => p.id === "apikey-write")).toBe(true);
    (runtime as { close: () => void }).close();
  });

  it("syncRbacFromObjectStore loads custom deny policies from ObjectStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-rbac-custom-"));
    const runtime = minimalRuntime(join(dir, "custom.db"));
    await runtime.objectStore.create("RbacPolicy", {
      id: "deny-k2",
      action: "rest.write",
      resource: "event:*",
      subjectType: "apikey",
      subjectId: "k2",
      effect: "deny",
    });

    await syncRbacFromObjectStore(runtime);

    const denied = runtime.rbac.check({
      action: "rest.write",
      resource: "event:alarm.created",
      subjectType: "apikey",
      subjectId: "k2",
    });
    expect(denied.allowed).toBe(false);
    const allowed = runtime.rbac.check({
      action: "rest.write",
      resource: "event:alarm.created",
      subjectType: "apikey",
      subjectId: "other",
    });
    expect(allowed.allowed).toBe(true);
    (runtime as { close: () => void }).close();
  });

  it("syncIngressFromObjectStore loads custom policies ahead of defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-ingress-custom-"));
    const runtime = minimalRuntime(join(dir, "custom-ingress.db"));
    await runtime.objectStore.create("IngressPolicy", {
      id: "deny-connector-test",
      source: "connector",
      eventTypePattern: "test.*",
      decision: { action: "deny", reason: "blocked" },
      priority: 500,
    });

    await syncIngressFromObjectStore(runtime);

    const denied = runtime.ingress.decide("connector", "test.alarm", "x");
    expect(denied.action).toBe("deny");
    const kernel = runtime.ingress.decide("connector", "alarm.created", "x");
    expect(kernel.action).toBe("kernel");
    (runtime as { close: () => void }).close();
  });
});

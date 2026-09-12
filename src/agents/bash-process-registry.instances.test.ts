/**
 * Duplicated registry module instances must observe one process-wide state.
 *
 * The bash process registry is reloaded once per bundle that inlines it (the
 * shared Gateway chunk and the self-contained worker bundle), and the test
 * support helper documents that "a later module evaluation may replace the
 * global slot while existing callers still own the original instance".
 *
 * A background exec admitted through one module instance has to stay visible to
 * the readers served by another instance: the runtime "Active exec sessions"
 * carrier is fed by `listActiveProcessSessionReferences()`, while the `process`
 * tool reads the registry directly. When the state is per instance rather than
 * per process those two readers disagree about the same run.
 *
 * Registry state is process-wide, so every case resets it explicitly, the same
 * way the rest of the registry suite isolates its own sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";

const SCOPE_KEY = "agent:main:registry-instance-probe";

describe("bash process registry across module instances", () => {
  beforeEach(() => {
    resetProcessRegistryForTests();
    vi.resetModules();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    vi.resetModules();
  });

  it("shows a background session admitted by another module instance", async () => {
    const writer = await import("./bash-process-registry.js");
    vi.resetModules();
    const reader = await import("./bash-process-references.js");

    const session = createProcessSessionFixture({ id: "instance-probe", backgrounded: true });
    session.scopeKey = SCOPE_KEY;
    writer.addSession(session);

    expect(reader.listActiveProcessSessionReferences({ scopeKey: SCOPE_KEY })).toMatchObject([
      { sessionId: "instance-probe", status: "running" },
    ]);
  });

  it("keeps the carrier reader working for its own instance (control)", async () => {
    const reader = await import("./bash-process-references.js");
    const readerRegistry = await import("./bash-process-registry.js");

    const session = createProcessSessionFixture({ id: "own-instance-probe", backgrounded: true });
    session.scopeKey = SCOPE_KEY;
    readerRegistry.addSession(session);

    expect(reader.listActiveProcessSessionReferences({ scopeKey: SCOPE_KEY })).toMatchObject([
      { sessionId: "own-instance-probe", status: "running" },
    ]);
  });

  it("keeps the scope filter closed to other scopes (control)", async () => {
    const writer = await import("./bash-process-registry.js");
    vi.resetModules();
    const reader = await import("./bash-process-references.js");

    const session = createProcessSessionFixture({ id: "other-scope-probe", backgrounded: true });
    session.scopeKey = "agent:other:elsewhere";
    writer.addSession(session);

    expect(reader.listActiveProcessSessionReferences({ scopeKey: SCOPE_KEY })).toEqual([]);
  });
});

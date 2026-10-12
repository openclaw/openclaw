import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "../runtime/registry.js";
import { upsertAcpSessionMeta } from "../runtime/session-meta.js";
import { AcpSessionManager } from "./manager.core.js";
import { disposeAcpSessionManagerInstance } from "./manager.lifecycle.js";

function createRuntime(sessionKey: string) {
  const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {});
  const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async () => ({
    sessionKey,
    backend: "cancellation-proof",
    runtimeSessionName: "retained-runtime",
  }));
  const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
    yield { type: "done" };
  });
  const getStatus = vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async () => ({ summary: "ready" }));
  const runtime: AcpRuntime = { ensureSession, runTurn, getStatus, cancel, close: async () => {} };
  return { runtime, cancel, ensureSession, runTurn, getStatus };
}

type Fixture = ReturnType<typeof createRuntime> & {
  state: OpenClawTestState;
  manager: AcpSessionManager;
  target: { cfg: OpenClawConfig; agentId: string; sessionKey: string };
};

export async function withAcpCancellationFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { metadata?: "global" | "inline"; sessionKey?: string } = {},
) {
  await withOpenClawTestState({ label: "acp-cancel-worker" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      acp: { enabled: true, backend: "cancellation-proof", dispatch: { enabled: true } },
    };
    const target = {
      cfg,
      agentId: "main",
      sessionKey: options.sessionKey ?? "agent:main:acp:cancellation-proof",
    };
    const inlineMeta = options.metadata === "inline";
    const meta: SessionAcpMeta = {
      backend: "cancellation-proof",
      agent: "main",
      runtimeSessionName: "retained-runtime",
      mode: "persistent",
      state: "running",
      lastActivityAt: 100,
    };
    await replaceSessionEntry(target, {
      sessionId: "cancellation-session",
      lifecycleRevision: "cancellation-lifecycle",
      updatedAt: 100,
      spawnedBy: "agent:main:main",
      ...(inlineMeta ? { acp: meta } : {}),
    });
    if (inlineMeta) {
      openOpenClawStateDatabase({ env: state.env });
    } else {
      await upsertAcpSessionMeta({ ...target, skipMaintenance: true, mutate: () => meta });
    }
    const runtime = createRuntime(target.sessionKey);
    registerAcpRuntimeBackend({ id: "cancellation-proof", runtime: runtime.runtime });
    const manager = new AcpSessionManager();
    try {
      await run({ ...runtime, state, target, manager });
    } finally {
      await disposeAcpSessionManagerInstance(manager, "proof-cleanup");
      unregisterAcpRuntimeBackend("cancellation-proof");
    }
  });
}

export function readDurableAcpSignals(fixture: Fixture, runId: string) {
  return openOpenClawStateDatabase({ env: fixture.state.env })
    .db.prepare("SELECT kind, payload_json FROM session_state_events WHERE run_id = ?")
    .all(runId);
}

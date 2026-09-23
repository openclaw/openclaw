import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isGatewayClientRequestError } from "openclaw/plugin-sdk/gateway-runtime";
import type {
  ActivityState,
  AdmittedOperation,
  ConsistencyMode,
  DestinationState,
  DestinationStatus,
  OperationReceipt,
} from "../../extensions/continuity-spike/api.js";
import { startSpikeNetwork, type SpikeChatResult, type SpikeNetwork } from "./gateways.js";

const ADVANCE = "tool search qa check target=continuity_advance. Call that tool exactly once.";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
type Destination = "company" | "family";

/** Runs real isolated Gateways. The relay below is a test transport, NOT Reef. */
export async function runSpike(network: SpikeNetwork) {
  const scenarios: Array<{ name: string; passed: true; elapsedMs: number; evidence: unknown }> = [];
  const chats: Array<{ label: string; metrics: SpikeChatResult["metrics"] }> = [];
  const rpc = (name: "home" | Destination, method: string, params?: unknown) =>
    network.call(name, `continuity_spike.${method}`, params);
  const home = async (id: string) => (await rpc("home", "status", { id })) as ActivityState;
  const remote = async (name: Destination, id: string) =>
    (await rpc(name, "status", { id })) as DestinationState;
  const session = (id: string) => `agent:qa:continuity-${id}`;
  const enroll = async (
    id: string,
    mode: ConsistencyMode = "next-turn",
    destinationId: Destination = "company",
    targetSteps = 1,
  ) => {
    await rpc(destinationId, "destination.enroll", { id, targetSteps });
    await rpc("home", "enroll", { id, sessionKey: session(id), destinationId, mode, targetSteps });
  };
  const nativeTurn = async (id: string) => {
    const result = await network.chatAdvance("home", { sessionKey: session(id) });
    chats.push({ label: id, metrics: result.metrics });
    assert.ok(result.requests.length > 0, "actual model transport must be observed");
    const state = await home(id);
    if (!state.operations.some((record) => record.state === "admitted")) {
      console.error(
        JSON.stringify({
          diagnostic: id,
          turns: state.turns,
          terminal: result.terminal,
          requests: result.requests.map((request) => ({
            plannedToolName: request.plannedToolName,
            toolOutput: request.toolOutput,
          })),
        }),
      );
    }
    return result;
  };
  const pending = async (id: string) => {
    const found = (await home(id)).operations.find((record) => record.state === "admitted");
    assert.ok(found, `native tool must admit an operation for ${id}`);
    return found.operation;
  };
  const release = async (id: string, operation: AdmittedOperation) =>
    (await rpc("home", "dispatch", { id, operationId: operation.id })) as AdmittedOperation;
  const execute = async (destinationId: Destination, operation: AdmittedOperation) =>
    (await rpc(destinationId, "execute", { operation })) as OperationReceipt;
  const settle = async (id: string, receipt: OperationReceipt) =>
    (await rpc("home", "receipt", { id, receipt })) as ActivityState;
  const bridge = async (id: string, destinationId: Destination = "company") => {
    const operation = await release(id, await pending(id));
    const receipt = await execute(destinationId, operation);
    await settle(id, receipt);
    return { operation, receipt };
  };
  const scenario = async (name: string, body: () => Promise<unknown>) => {
    console.log(`RUN ${name}`);
    const started = performance.now();
    const evidence = await body();
    scenarios.push({ name, passed: true, elapsedMs: performance.now() - started, evidence });
    console.log(`PASS ${name}`);
  };
  const waitFor = async <T>(
    read: () => Promise<T>,
    ready: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const deadline = performance.now() + 20_000;
    do {
      const value = await read();
      if (ready(value)) {
        return value;
      }
      await new Promise((done) => {
        setTimeout(done, 100);
      });
    } while (performance.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
  };

  for (const role of network.names) {
    await rpc(role, "init", { role });
  }

  await scenario("read-only Gateway client can inspect but cannot change a decision", async () => {
    const id = "scope-denial";
    await enroll(id);
    const before = await home(id);
    return network.withReadOnlyClient("home", async ({ grantedScopes, request }) => {
      assert.deepEqual(grantedScopes, ["operator.read"]);
      assert.deepEqual(await request("continuity_spike.status", { id }), before);
      await assert.rejects(
        () => request("continuity_spike.decision", { id, direction: "B", requestId: "denied-b" }),
        (error: unknown) => {
          assert.ok(isGatewayClientRequestError(error));
          assert.equal(error.gatewayCode, "FORBIDDEN");
          assert.deepEqual(error.details, {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          });
          assert.equal(error.retryable, false);
          return true;
        },
      );
      assert.deepEqual(await home(id), before, "denied RPC must not change durable activity state");
      await rpc("home", "decision", { id, direction: "B", requestId: "allowed-b" });
      const after = await home(id);
      assert.equal(after.currentDecision.direction, "B");
      assert.deepEqual(await request("continuity_spike.status", { id }), after);
      return { grantedScopes, readAllowed: true, mutationDenied: true, adminMutationAllowed: true };
    });
  });

  await scenario(
    "selected-save commits through native SQLite and retains only the released record",
    async () => {
      const activityId = "native-save";
      const temporaryId = "native-sidechat";
      await rpc("home", "context.policy", {
        policy: {
          id: "native-save-policy",
          sourceId: "home",
          activityId,
          readers: ["home", "company"],
          exportTo: ["company"],
          retain: true,
        },
      });
      await rpc("home", "context.import", {
        sourceId: "home",
        recipientId: "company",
        activityId,
        allowed: true,
      });
      await rpc("home", "context.temporary.begin", {
        id: temporaryId,
        activityId,
        expiresAt: Date.now() + 60_000,
      });
      await rpc("home", "context.record", {
        record: {
          id: "native-directive",
          activityId,
          policyId: "native-save-policy",
          profile: "ephemeral",
          temporaryId,
          text: "SYNTHETIC_RELEASED_DIRECTIVE_B",
        },
      });
      const saved = await rpc("home", "context.temporary.save", {
        temporaryId,
        recipientId: "company",
        recordIds: ["native-directive"],
        profile: "shared",
      });
      assert.deepEqual(saved, { savedIds: ["saved:native-directive"], omittedCount: 0 });
      await rpc("home", "context.temporary.end", { id: temporaryId });
      await assert.rejects(() =>
        rpc("home", "context.read", {
          activityId,
          recipientId: "home",
          recordIds: ["native-directive"],
        }),
      );
      const retained = await rpc("home", "context.read", {
        activityId,
        recipientId: "company",
        recordIds: ["saved:native-directive"],
      });
      assert.ok(Array.isArray(retained));
      assert.equal(retained.length, 1);
      assert.equal(retained[0]?.id, "saved:native-directive");
      assert.equal(retained[0]?.text, "SYNTHETIC_RELEASED_DIRECTIVE_B");
      return { saved, sourceClosed: true, retainedCount: retained.length };
    },
  );

  await scenario(
    "native baseline: unchanged direction completes a real synthetic artifact",
    async () => {
      await enroll("baseline");
      await nativeTurn("baseline");
      const result = await bridge("baseline");
      assert.equal(result.receipt.outcome, "succeeded");
      assert.equal((await home("baseline")).status, "completed");
      assert.equal((await remote("company", "baseline")).artifacts.length, 1);
      return result;
    },
  );

  await scenario(
    "native scheduled B, reused run identity is fenced, fresh turn continues",
    async () => {
      const id = "scheduled";
      await enroll(id, "next-turn", "company", 2);
      const scheduled = await rpc("home", "schedule", { id });
      await rpc("home", "decision", { id, direction: "B", requestId: "scheduled-b" });
      await waitFor(
        () => home(id),
        (state) => state.operations.some((record) => record.state === "admitted"),
        "native scheduled operation",
      );
      assert.equal((await pending(id)).direction, "B");
      await bridge(id);
      await waitFor(
        () => home(id),
        (state) => state.turns.every((turn) => turn.state === "finished"),
        "first scheduled turn completion",
      );
      const afterFirst = await home(id);
      // Queue ownership is released, but this OpenClaw revision reuses the persistent
      // session ID as its Cron run ID. A finished admitted turn must not be reopened.
      const nextSchedule = await rpc("home", "schedule", { id });
      assert.ok(
        nextSchedule && typeof nextSchedule === "object" && "jobId" in nextSchedule,
        "the next continuation must create a job, not coalesce with an already-started turn",
      );
      const repeatedJob = await waitFor(
        async () => {
          const listing = (await network.call("home", "cron.list", { includeDisabled: true })) as {
            jobs: Array<{
              id: string;
              enabled: boolean;
              state?: { lastRunStatus?: string; lastError?: string };
            }>;
          };
          return listing.jobs.find((job) => job.id === nextSchedule.jobId);
        },
        (job) => job?.state?.lastRunStatus === "error",
        "reused Cron run identity to fail closed",
      );
      assert.equal(repeatedJob?.enabled, false);
      assert.match(repeatedJob?.state?.lastError ?? "", /current authorized turn/);
      assert.deepEqual(
        await home(id),
        afterFirst,
        "reused run cannot reopen or mutate the finished turn",
      );
      await nativeTurn(id);
      assert.equal((await pending(id)).direction, "B");
      await bridge(id);
      assert.equal((await home(id)).status, "completed");
      assert.equal((await remote("company", id)).artifacts.length, 2);
      return {
        scheduled,
        nextSchedule,
        repeatedScheduling: "unsupported: native Cron reuses session ID as run ID",
        staleRunBlocked: true,
        freshTurnCompleted: true,
        final: await home(id),
      };
    },
  );

  for (const mode of ["next-turn", "operation"] as const) {
    await scenario(`A to B during a real active turn (${mode})`, async () => {
      const id = mode;
      await enroll(id, mode, "company", 2);
      await rpc("home", "hold", { id, enabled: true });
      const ticket = await network.startChat("home", { sessionKey: session(id), message: ADVANCE });
      await waitFor(
        async () => (await rpc("home", "held", { id })) as { held: boolean },
        (state) => state.held,
        "actual before-tool admission hold",
      );
      assert.equal((await home(id)).turns.at(-1)?.direction, "A");
      await rpc("home", "decision", { id, direction: "B", requestId: `select-b-${mode}` });
      await rpc("home", "hold", { id, enabled: false });
      const result = await network.finishChat(ticket);
      chats.push({ label: `${id}-old-turn`, metrics: result.metrics });
      const afterA = await home(id);
      if (mode === "next-turn") {
        assert.equal((await pending(id)).direction, "A");
        await bridge(id);
        assert.deepEqual((await home(id)).completedSteps, []);
      } else {
        assert.equal(afterA.operations.length, 0, "superseded run must not create new admission");
      }
      await nativeTurn(id);
      assert.equal((await pending(id)).direction, "B");
      await bridge(id);
      await nativeTurn(id);
      await bridge(id);
      const final = await home(id);
      const destination = await remote("company", id);
      assert.equal(final.currentDecision.direction, "B");
      assert.equal(final.status, "completed");
      assert.deepEqual(final.completedSteps, [1, 2]);
      assert.deepEqual(
        destination.artifacts.map((artifact) => artifact.direction),
        mode === "next-turn" ? ["A", "B", "B"] : ["B", "B"],
      );
      return { mode, final, destination };
    });
  }

  await scenario("independent attachments: company offline, family progresses", async () => {
    await enroll("offline-company");
    await enroll("online-family", "next-turn", "family");
    await rpc("home", "attachment", { id: "offline-company", connected: false });
    await nativeTurn("online-family");
    await bridge("online-family", "family");
    assert.equal((await home("online-family")).status, "completed");
    assert.equal((await home("offline-company")).status, "blocked");
    assert.equal((await home("offline-company")).operations.length, 0);
    await rpc("home", "decision", {
      id: "offline-company",
      direction: "B",
      requestId: "offline-b",
    });
    await rpc("home", "attachment", {
      id: "offline-company",
      connected: true,
      destinationRevision: 1,
    });
    await nativeTurn("offline-company");
    await bridge("offline-company");
    return { company: await home("offline-company"), family: await home("online-family") };
  });

  await scenario(
    "lost receipt and home process replacement reconcile without duplicate effect",
    async () => {
      const id = "lost-receipt";
      await enroll(id, "operation", "company", 2);
      await nativeTurn(id);
      const operation = await release(id, await pending(id));
      const originalReceipt = await execute("company", operation);
      await rpc("home", "unknown", { id, operationId: operation.id });
      await network.restart("home");
      assert.equal((await home(id)).blockedReason, "outcome-unknown");
      const status = (await rpc("company", "lookup", {
        id,
        operationId: operation.id,
      })) as DestinationStatus;
      assert.equal(status.outcome, "found");
      assert.ok(status.outcome === "found");
      assert.deepEqual(status.receipt, originalReceipt);
      await settle(id, status.receipt);
      assert.deepEqual(await execute("company", operation), originalReceipt);
      assert.equal((await remote("company", id)).artifacts.length, 1);
      await nativeTurn(id);
      await bridge(id);
      assert.equal((await home(id)).status, "completed");
      return { final: await home(id), destination: await remote("company", id) };
    },
  );

  await scenario(
    "unknown not-found stays blocked until a terminal cancellation fence",
    async () => {
      const id = "not-found";
      await enroll(id);
      await nativeTurn(id);
      const operation = await release(id, await pending(id));
      await rpc("home", "unknown", { id, operationId: operation.id });
      assert.deepEqual(await rpc("company", "lookup", { id, operationId: operation.id }), {
        outcome: "not-found",
      });
      assert.equal((await home(id)).blockedReason, "outcome-unknown");
      const cancelled = (await rpc("company", "cancel", { operation })) as OperationReceipt;
      assert.equal(cancelled.outcome, "cancelled");
      await settle(id, cancelled);
      assert.deepEqual(await execute("company", operation), cancelled);
      assert.equal((await remote("company", id)).artifacts.length, 0);
      await nativeTurn(id);
      await bridge(id);
      return { final: await home(id), cancellation: cancelled };
    },
  );

  await scenario("destination revision conflict blocks until state refresh", async () => {
    const id = "destination-change";
    await enroll(id);
    await nativeTurn(id);
    const operation = await release(id, await pending(id));
    await rpc("company", "destination.change", { id });
    const conflict = await execute("company", operation);
    assert.equal(conflict.reason, "destination-revision-conflict");
    await settle(id, conflict);
    assert.equal((await home(id)).status, "blocked");
    assert.equal((await remote("company", id)).artifacts.length, 0);
    const changed = await remote("company", id);
    await rpc("home", "attachment", { id, connected: true, destinationRevision: changed.revision });
    await nativeTurn(id);
    await bridge(id);
    assert.equal((await home(id)).status, "completed");
    return { conflict, final: await home(id) };
  });

  await scenario("receipt-read policy gates lookup and both aggregate response forms", async () => {
    const id = "reconcile-policy";
    await enroll(id);
    await nativeTurn(id);
    const operation = await release(id, await pending(id));
    await execute("company", operation);
    await rpc("company", "policy", { id, execute: false });
    await rpc("home", "policy", { id, execute: false });
    const status = (await rpc("company", "lookup", {
      id,
      operationId: operation.id,
    })) as DestinationStatus;
    assert.ok(status.outcome === "found");
    await settle(id, status.receipt);
    const connections = [];
    for (const role of ["company", "home"] as const) {
      connections.push(
        await network.withReadOnlyClient(role, async ({ grantedScopes, request }) => {
          assert.deepEqual(grantedScopes, ["operator.read"]);
          const exchanges: Array<{
            phase: string;
            method: string;
            params: unknown;
            ok: boolean;
            payload?: unknown;
            error?: unknown;
          }> = [];
          // Capture actual synthetic RPC payloads, never connection credentials or hello frames.
          const read = async (phase: string, method: string, params: unknown) => {
            const payload = await request(`continuity_spike.${method}`, params);
            exchanges.push({
              phase,
              method: `continuity_spike.${method}`,
              params,
              ok: true,
              payload,
            });
            return payload;
          };
          const denied = async (method: string, params: unknown) => {
            await assert.rejects(
              () => request(`continuity_spike.${method}`, params),
              (error: unknown) => {
                assert.ok(isGatewayClientRequestError(error));
                assert.equal(error.gatewayCode, "FORBIDDEN");
                assert.equal(error.retryable, false);
                assert.deepEqual(error.details, {
                  pluginId: "continuity-spike",
                  category: "denied",
                  reason: role === "home" ? "home-status-denied" : "destination-status-denied",
                });
                exchanges.push({
                  phase: "revoked",
                  method: `continuity_spike.${method}`,
                  params,
                  ok: false,
                  error: {
                    code: error.gatewayCode,
                    message: error.message,
                    retryable: error.retryable,
                    details: error.details,
                  },
                });
                return true;
              },
            );
          };
          const before = (await read("allowed", "status", { id })) as
            | ActivityState
            | DestinationState;
          const records = before.kind === "home-activity" ? before.operations : before.records;
          assert.deepEqual(
            records.find((record) => record.operation.id === operation.id)?.receipt,
            status.receipt,
          );
          const inventory = (await read("allowed", "status", {})) as {
            role: string;
            activities: Array<ActivityState | DestinationState>;
          };
          assert.deepEqual(
            inventory.activities.find((activity) => activity.id === id),
            before,
          );
          if (role === "company") {
            assert.deepEqual(
              await read("allowed", "lookup", { id, operationId: operation.id }),
              status,
            );
          }

          await rpc(role, "policy", { id, statusRead: false });
          await denied("status", { id });
          if (role === "company") {
            await denied("lookup", { id, operationId: operation.id });
          }
          const filtered = await read("revoked", "status", {});
          const visible = inventory.activities.filter((activity) => activity.id !== id);
          assert.ok(
            visible.some((activity) => activity.id === "baseline"),
            "readable sibling must remain",
          );
          assert.deepEqual(filtered, { role, activities: visible });
          assert.ok(
            !JSON.stringify(filtered).includes(operation.id),
            "no receipt or artifact copy may escape",
          );
          assert.deepEqual(
            await read("revoked", "status", { id: "baseline" }),
            visible.find((activity) => activity.id === "baseline"),
          );

          const restored = await rpc(role, "policy", { id, statusRead: true });
          assert.deepEqual(await read("restored", "status", { id }), restored);
          assert.deepEqual(await read("restored", "status", {}), {
            role,
            activities: inventory.activities.map((activity) =>
              activity.id === id ? restored : activity,
            ),
          });
          if (role === "company") {
            assert.deepEqual(
              await read("restored", "lookup", { id, operationId: operation.id }),
              status,
            );
          }
          return { role, grantedScopes, exchanges };
        }),
      );
    }
    return { receipt: status.receipt, connections, final: await home(id) };
  });

  await scenario(
    "source scopes and native prompt projection exclude private rationale",
    async () => {
      const id = "context-company";
      await enroll(id, "next-turn", "company", 2);
      const base = { sourceId: "home", activityId: id, retain: true };
      await rpc("home", "context.policy", {
        policy: { ...base, id: "private-policy", readers: ["home"], exportTo: [] },
      });
      await rpc("home", "context.policy", {
        policy: {
          ...base,
          id: "directive-policy",
          readers: ["home", "company"],
          exportTo: ["company"],
        },
      });
      await rpc("home", "context.import", {
        sourceId: "home",
        recipientId: "company",
        activityId: id,
        allowed: true,
      });
      await rpc("home", "context.record", {
        record: {
          id: "private-rationale",
          policyId: "private-policy",
          activityId: id,
          profile: "private",
          text: "PRIVATE_RATIONALE_CANARY_NEVER_EXPORT_72",
        },
      });
      await rpc("home", "context.record", {
        record: {
          id: "permitted-directive",
          policyId: "directive-policy",
          activityId: id,
          profile: "shared",
          text: "SCOPED_DIRECTIVE_B_COMPANY_72",
        },
      });
      await assert.rejects(() =>
        rpc("home", "context.read", {
          activityId: id,
          recipientId: "company",
          recordIds: ["private-rationale"],
        }),
      );
      await assert.rejects(() =>
        rpc("home", "context.read", {
          activityId: id,
          recipientId: "family",
          recordIds: ["permitted-directive"],
        }),
      );
      await rpc("home", "context.select", {
        sessionKey: session(id),
        recordIds: ["permitted-directive"],
      });
      await rpc("home", "decision", { id, direction: "B", requestId: "context-b" });
      const result = await nativeTurn(id);
      assert.ok(
        result.requests.some((request) =>
          request.allInputText.includes("SCOPED_DIRECTIVE_B_COMPANY_72"),
        ),
      );
      assert.ok(
        result.requests.every(
          (request) => !request.allInputText.includes("PRIVATE_RATIONALE_CANARY_NEVER_EXPORT_72"),
        ),
      );
      await bridge(id);
      await assert.rejects(() =>
        rpc("home", "context.select", { sessionKey: session(id), recordIds: [] }),
      );
      await rpc("home", "context.policy", {
        policy: { ...base, id: "directive-policy", readers: ["home"], exportTo: [] },
      });
      const cursor = await network.requestCursor("home");
      await network.chatAdvance("home", { sessionKey: session(id) });
      assert.equal(
        (await network.requests("home", { after: cursor })).length,
        0,
        "revoked historical context must block before inference",
      );
      return {
        selected: "permitted-directive",
        privateCanaryObserved: false,
        postRevocationRequests: 0,
      };
    },
  );

  const requests = await Promise.all(
    network.names.map(async (name) => ({ name, count: (await network.requests(name)).length })),
  );
  return {
    schemaVersion: 1,
    status: "passed",
    runtime:
      "three real isolated OpenClaw Gateways; embedded runtime; local deterministic mock provider",
    transport: "authenticated test-owned Gateway RPC relay, not Reef",
    consistency: "both selectable hypotheses tested, neither chosen for production",
    scenarios,
    chats,
    requests,
    unmeasured: [
      "paid model tokens/cost/quality",
      "same-turn classifier overhead",
      "native Codex",
      "live Reef",
      "abrupt power loss or snapshot rollback",
      "native ephemeral/vault erasure",
      "real UI workspace switching",
    ],
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { report: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: node --import ./scripts/tsx.mjs scripts/continuity-spike/cli.ts [--report new-file.json]\nRequires: node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime\nStarts only owned local QA Gateways/mock providers; no live config or paid inference.",
    );
    return;
  }
  console.log("Starting three isolated QA Gateways. All data and model responses are synthetic.");
  const network = await startSpikeNetwork(repoRoot);
  let report: Awaited<ReturnType<typeof runSpike>>;
  try {
    report = await runSpike(network);
  } finally {
    await network.stop();
  }
  if (values.report) {
    await writeFile(resolve(values.report), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(
    `PASS ${report.scenarios.length} real-Gateway scenarios; all owned processes stopped.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Continuity spike failed");
    process.exitCode = 1;
  });
}

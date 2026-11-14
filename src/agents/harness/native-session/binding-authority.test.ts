import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import * as paths from "../../../state/openclaw-agent-db.paths.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  combinePreparedNativeSessionBindingAuthority,
  createNativeSessionBindingAuthority,
  createNativeSessionBindingScope,
  readNativeSessionBindingEntries,
} from "./binding-authority.js";
import { bindingGate } from "./binding-interleaving.test-support.js";

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.restoreAllMocks();
});

async function createIncognitoBinding(previousSessionId?: string) {
  const { env, cleanup } = await createOpenClawTestState({ scenario: "minimal" });
  onTestFinished(cleanup);
  const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-test", env };
  const entry = { sessionId: "current", previousSessionId, updatedAt: 1 };
  await replaceSessionEntry(scope, entry);
  const read = { ...scope, storePath: paths.resolveIncognitoOpenClawAgentSqlitePath(scope) };
  return { scope, entry, read };
}

it("does not warn on prepared authority", () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  combinePreparedNativeSessionBindingAuthority(
    createNativeSessionBindingScope(() => {}),
  ).assertCurrent();
  expect(warning).not.toHaveBeenCalled();
});

it("admits incognito predecessor lineage without SQL and rejects changed lineage", async () => {
  const { scope, entry, read } = await createIncognitoBinding("predecessor");
  const superseded = new Error("native lineage superseded");
  const authority = createNativeSessionBindingAuthority(
    [{ read, ...entry, createSupersededError: () => superseded }],
    () => {},
  );
  const queries = observeHostDataSql();
  await expect(authority.withCurrent(() => "admitted")).resolves.toBe("admitted");
  const mutation = await authority.prepareMutation();
  mutation.assertCurrent();
  expect(queries.queries).toEqual([]);
  await replaceSessionEntry(scope, { ...entry, previousSessionId: "changed", updatedAt: 2 });
  expect(mutation.assertCurrent).toThrow(superseded);
  await expect(authority.withCurrent(() => "stale")).rejects.toThrow(superseded);
  await expect(authority.prepareMutation()).rejects.toThrow(superseded);
});

it("keeps the incognito source incarnation across a durable lineage wait", async () => {
  const { scope, entry, read: native } = await createIncognitoBinding();
  const durable = { ...scope, sessionKey: "agent:main:durable-custody" };
  replaceSessionEntrySync(durable, { sessionId: "durable", updatedAt: 1 });
  const storePath = paths.resolveOpenClawAgentSqlitePath(durable);
  await using gate = bindingGate();
  const read = sessionReads.withSessionEntriesFromStoresInWorker;
  vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker").mockImplementationOnce(
    async (inputs, consume, options) => {
      await gate.pause();
      return read(inputs, consume, options);
    },
  );
  const consume = vi.fn();
  const outcome = gate.observe(
    readNativeSessionBindingEntries([native, { ...durable, storePath }], consume),
  );
  await gate.wait(outcome, "Durable lineage read was not reached");
  memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: native.storePath });
  await replaceSessionEntry(scope, entry);
  gate.resume();
  expect(await outcome).toMatchObject({ message: "Incognito session actor owner is closed" });
  expect(consume).not.toHaveBeenCalled();
});

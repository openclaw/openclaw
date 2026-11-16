import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveAgentDir } from "../agent-scope.js";
import { persistInlineAuthFailure } from "./inline-usage.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";
import { markAuthProfileFailure } from "./usage.js";

const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

it.each(["health", "store", "inline"] as const)(
  "keeps admitted %s auth writes off main-thread filesystem identity calls",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = { agents: { entries: { main: {}, voice: {} } } };
      setRuntimeConfigSnapshot(config, config);
      resolveAgentDir(config, "main", state.env);
      const agentDir = resolveAgentDir(config, "voice", state.env);
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          selected: { type: "api_key", provider: "fixture", key: "synthetic" },
        },
      };
      saveAuthProfileStore(store, agentDir, saveOptions);
      setRuntimeAuthProfileStoreSnapshot(store, agentDir);
      const write = () =>
        kind === "health"
          ? markAuthProfileFailure({ store, profileId: "selected", reason: "auth", agentDir })
          : kind === "inline"
            ? persistInlineAuthFailure(agentDir, { provider: "fixture", reason: "auth" })
            : updateAuthProfileStoreWithLock({
                agentDir,
                saveOptions,
                updater(current) {
                  current.order = { fixture: ["selected"] };
                  return true;
                },
              });
      await write();
      const calls: string[] = [];
      const record = (pathname: unknown) => {
        if (String(pathname).startsWith(state.stateDir)) {
          calls.push(new Error().stack ?? "Missing filesystem stack");
        }
      };
      const stat = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof stat>) => {
        record(args[0]);
        return Reflect.apply(stat, fs, args);
      });
      const realpath = fs.realpathSync.native;
      vi.spyOn(fs.realpathSync, "native").mockImplementation(
        (...args: Parameters<typeof realpath>) => {
          record(args[0]);
          return Reflect.apply(realpath, fs.realpathSync, args);
        },
      );
      syncBuiltinESMExports();
      try {
        await write();
      } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
      }
      expect(calls).toEqual([]);
    });
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses inline auth replacement during the %s host grant",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentDir = state.agentDir("voice");
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, saveOptions);
      await persistInlineAuthFailure(agentDir, { provider: "fixture", reason: "auth" });
      let replaced = false;
      probe.admission(operationAdmission, (request, grant, admit) => {
        const facts = request.facts;
        if (
          !replaced &&
          request.stage === stage &&
          isRecord(facts) &&
          isRecord(facts.identity) &&
          facts.identity.nativeLocation === databasePath
        ) {
          admit(request, () => {
            replaced = true;
            const original = `${databasePath}.original`;
            fs.renameSync(databasePath, original);
            fs.copyFileSync(original, databasePath);
            return grant();
          });
        } else {
          admit(request, grant);
        }
      });
      await expect(
        persistInlineAuthFailure(agentDir, { provider: "fixture", reason: "auth" }),
      ).rejects.toThrow(/identity|physical|borrowed native owner/i);
      expect(replaced).toBe(true);
    });
  },
);

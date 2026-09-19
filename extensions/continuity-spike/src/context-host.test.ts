import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createContextHost } from "./context-host.js";
import type { ContextPolicy } from "./context.js";
import type { ActivityState } from "./types.js";

type GatewayMethod = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function fixture() {
  const sessionKey = "agent:main:context-proof";
  const scope: ActivityState = {
    kind: "home-activity",
    schemaVersion: 1,
    id: "campaign-x",
    sessionKey,
    destinationId: "company",
    objective: "Synthetic context proof",
    targetSteps: 1,
    mode: "next-turn",
    currentDecision: { revision: 1, direction: "A", requestId: "initial" },
    decisions: [],
    turns: [],
    operations: [],
    policy: { execute: true, statusRead: true, cancel: true },
    authorityGeneration: 1,
    attachment: { connected: true, generation: 1, destinationRevision: 1 },
    stopped: false,
    completedSteps: [],
    status: "pending",
    blockedReason: null,
  };
  const policy: ContextPolicy = {
    id: "directive",
    sourceId: "home",
    activityId: scope.id,
    readers: ["home", "company"],
    exportTo: ["company"],
    retain: true,
  };
  const namespaces = new Map<string, Map<string, unknown>>();
  const state = (namespace: string) => {
    let data = namespaces.get(namespace);
    if (!data) {
      data = new Map();
      namespaces.set(namespace, data);
    }
    return data;
  };
  const controls = {
    beforeManifestUpdate: () => {},
    manifestWrite: "write" as "write" | "no-op" | "throw",
  };
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>({
    namespace,
  }: {
    namespace: string;
  }): PluginStateSyncKeyedStore<T> => {
    const data = state(namespace);
    // The native JSON store uses its caller's declared value type as well.
    const lookup = (key: string) => structuredClone(data.get(key)) as T | undefined;
    return {
      register: (key, value) => {
        data.set(key, structuredClone(value));
      },
      registerIfAbsent: (key, value) => {
        if (data.has(key)) {
          return false;
        }
        data.set(key, structuredClone(value));
        return true;
      },
      update: (key, apply) => {
        if (namespace === "context-home-manifests") {
          controls.beforeManifestUpdate();
        }
        const value = apply(lookup(key));
        if (namespace === "context-home-manifests") {
          if (controls.manifestWrite === "throw") {
            throw new Error("Synthetic manifest write failure");
          }
          if (controls.manifestWrite === "no-op") {
            return false;
          }
        }
        if (value === undefined) {
          return false;
        }
        data.set(key, structuredClone(value));
        return true;
      },
      lookup,
      consume: (key) => {
        const value = lookup(key);
        data.delete(key);
        return value;
      },
      delete: (key) => data.delete(key),
      entries: () =>
        [...data].map(([key, value]) => ({
          key,
          value: structuredClone(value) as T,
          createdAt: 1,
        })),
      clear: () => data.clear(),
    };
  };
  const api = createTestPluginApi({ id: "continuity-spike", name: "Context proof", runtime });
  const methods = new Map<string, GatewayMethod>();
  api.registerGatewayMethod = (name, handler) => {
    methods.set(name, handler);
  };
  const host = createContextHost(
    api,
    () => "home",
    (key) => (key === sessionKey ? scope : undefined),
  );
  const rpc = async (name: string, params: Record<string, unknown>) => {
    const method = `continuity_spike.context.${name}`;
    const handler = methods.get(method);
    if (!handler) {
      throw new Error("Missing context method");
    }
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handler({
      req: { type: "req", id: "synthetic", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      get context(): never {
        throw new Error("No unrelated Gateway services in this context-owner test");
      },
    });
    const response = respond.mock.calls.at(-1);
    if (!response) {
      throw new Error("Missing context response");
    }
    const [ok, result, error] = response;
    if (!ok) {
      throw new Error(error?.message ?? "Context request denied");
    }
    return result;
  };
  const add = (recordId: string) =>
    rpc("record", {
      record: {
        id: recordId,
        activityId: scope.id,
        policyId: policy.id,
        profile: "shared",
        text: `Synthetic ${recordId}`,
      },
    });
  return {
    host,
    sessionKey,
    controls,
    state,
    scope,
    policy,
    rpc,
    add,
    select: (recordIds = ["first"]) => rpc("select", { sessionKey, recordIds }),
    async seed() {
      await rpc("policy", { policy });
      await rpc("import", {
        sourceId: "home",
        recipientId: "company",
        activityId: scope.id,
        allowed: true,
      });
      await add("first");
      await add("second");
    },
  };
}

describe("continuity context manifest commit", () => {
  it.each(["select", "prompt"] as const)(
    "rechecks audience, import, and scope before committing a %s manifest",
    async (operation) => {
      for (const change of ["policy", "import", "scope", "stop"] as const) {
        const f = fixture();
        await f.seed();
        if (operation === "prompt") {
          await f.select();
        }
        f.controls.beforeManifestUpdate = () => {
          if (change === "policy") {
            f.state("context-home-policies").set("directive", { ...f.policy, readers: ["home"] });
          } else if (change === "import") {
            f.state("context-home-imports").clear();
          } else if (change === "scope") {
            f.scope.destinationId = "family";
          } else {
            f.host.stop();
          }
        };
        const failure =
          change === "scope" && operation === "prompt"
            ? /context-manifest-changed/
            : /audience-denied|import-denied|session-context-scope-changed|host-retired/;
        if (operation === "select") {
          await expect(f.select()).rejects.toThrow(failure);
          expect(f.state("context-home-manifests").get(f.sessionKey)).toBeUndefined();
        } else {
          expect(() => f.host.promptContext(f.sessionKey)).toThrow(failure);
          expect(f.state("context-home-manifests").get(f.sessionKey)).toMatchObject({
            used: false,
          });
        }
      }
    },
  );

  it.each(["no-op", "throw"] as const)(
    "does not acknowledge selection or emit native context after a manifest %s",
    async (manifestWrite) => {
      const f = fixture();
      await f.seed();
      f.controls.manifestWrite = manifestWrite;
      await expect(f.select()).rejects.toThrow();
      expect(f.state("context-home-manifests").get(f.sessionKey)).toBeUndefined();
      f.controls.manifestWrite = "write";
      await f.select();
      f.controls.manifestWrite = manifestWrite;
      expect(() => f.host.promptContext(f.sessionKey)).toThrow();
      expect(f.state("context-home-manifests").get(f.sessionKey)).toMatchObject({ used: false });
      f.controls.manifestWrite = "write";
      await f.select(["second"]);
      expect(f.host.promptContext(f.sessionKey)).toContain("Synthetic second");
      await expect(f.select(["first"])).rejects.toThrow(
        "context-manifest-frozen-use-fresh-session",
      );
    },
  );

  it.each(["select", "prompt"] as const)(
    "rejects a changed record instead of committing the prepared %s projection",
    async (operation) => {
      const f = fixture();
      await f.seed();
      if (operation === "prompt") {
        await f.select();
      }
      f.controls.beforeManifestUpdate = () => {
        // Replace the record through the public store contract, retaining its ID
        // and policy. A prepared prompt must not commit either content version.
        f.state("context-home-records").set("context-records-v1", {
          records: [
            {
              id: "first",
              activityId: f.scope.id,
              profile: "shared",
              text: "Changed after selection was prepared",
              provenance: [
                {
                  recordId: "first",
                  policyId: f.policy.id,
                  sourceId: "home",
                  activityId: f.scope.id,
                  profile: "shared",
                },
              ],
            },
          ],
        });
      };
      if (operation === "select") {
        await expect(f.select()).rejects.toThrow("context-record-changed");
        expect(f.state("context-home-manifests").get(f.sessionKey)).toBeUndefined();
      } else {
        expect(() => f.host.promptContext(f.sessionKey)).toThrow("context-record-changed");
        expect(f.state("context-home-manifests").get(f.sessionKey)).toMatchObject({ used: false });
      }
    },
  );

  it("reopens retained context on restart without reviving retired temporary views", async () => {
    const f = fixture();
    await f.seed();
    await f.select();
    await f.rpc("temporary.begin", {
      id: "sidechat",
      activityId: f.scope.id,
      expiresAt: Date.now() + 60_000,
    });
    await f.rpc("record", {
      record: {
        id: "temporary",
        activityId: f.scope.id,
        policyId: f.policy.id,
        profile: "ephemeral",
        temporaryId: "sidechat",
        text: "Temporary fixture",
      },
    });
    f.host.stop();
    expect(() => f.host.promptContext(f.sessionKey)).toThrow("host-retired");
    f.host.start();
    expect(f.host.promptContext(f.sessionKey)).toContain("Synthetic first");
    await expect(
      f.rpc("read", { activityId: f.scope.id, recipientId: "home", recordIds: ["temporary"] }),
    ).rejects.toThrow("record-unavailable");
  });
});

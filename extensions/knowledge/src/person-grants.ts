import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { assertCallerCurrent, canChangeAssignments } from "./access.js";
import {
  personGrantKey,
  type PersonGrant,
  type PersonGrantChangeInput,
} from "./person-grants-contract.js";
import { effectiveBinding, storesRevision } from "./stores-config.js";
import type { StoresChangeOutput } from "./stores-contract.js";
import type { Stores } from "./stores.js";

/** Person grants use the same registry publication and live principal guards as
 * conversation grants. They select one space, not an additional memory owner. */
export function createPersonGrantOperations(stores: Stores) {
  function assertAdmin(context: FeatureInvocationContext, agent?: string) {
    if (!stores.policy.operatorRead || !canChangeAssignments(context)) {
      throw new Error(
        "Person grants require a current operator administrator; agent tools cannot manage them.",
      );
    }
    assertCallerCurrent(context);
    if (
      context.source === "session-action" &&
      agent &&
      context.action.client?.allowsAgent &&
      !context.action.client.allowsAgent(agent)
    ) {
      throw new Error("Your operator role does not include this agent.");
    }
  }
  async function snapshot(_: unknown, context: FeatureInvocationContext) {
    const incarnation = stores.incarnation;
    assertAdmin(context);
    await stores.ensure();
    stores.assertLive(incarnation);
    assertAdmin(context);
    const client = context.source === "session-action" ? context.action.client : undefined;
    const section = stores.registry.current!.personGrants;
    return {
      revision: storesRevision(section),
      entries: Object.values(section).filter((entry) => client?.allowsAgent?.(entry.agent) ?? true),
    };
  }
  async function grant(
    input: PersonGrantChangeInput,
    context: FeatureInvocationContext,
  ): Promise<StoresChangeOutput> {
    const incarnation = stores.incarnation;
    assertAdmin(context, input.agent);
    await stores.ensure();
    stores.assertLive(incarnation);
    assertAdmin(context, input.agent);
    const current = stores.registry.current!.personGrants;
    if (storesRevision(current) !== input.expectedRevision) {
      return {
        outcome: "conflict",
        message:
          "Person grants changed; read person_grants and retry against its current revision.",
      };
    }
    const binding = effectiveBinding(stores.membership(), input.agent);
    if (input.access !== "none" && (!binding || !stores.agents().includes(input.agent))) {
      return {
        outcome: "invalid",
        message: "The agent has no valid store membership. Nothing was changed.",
      };
    }
    const key = personGrantKey(input.profileId, input.agent);
    if (
      input.access !== "none" &&
      !Object.hasOwn(current, key) &&
      Object.keys(current).length >= 500
    ) {
      return {
        outcome: "invalid",
        message: "At most 500 person grants are supported. Remove one first.",
      };
    }
    const value: PersonGrant | null =
      input.access === "none"
        ? null
        : {
            profileId: input.profileId,
            agent: input.agent,
            binding: binding!,
            space: input.space,
            access: input.access,
          };
    const next = { ...current };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    // The registry worker asks this original source guard immediately before
    // its synchronous transaction. An accepted write may finish after the
    // caller disconnects; no later caller can reuse its publication authority.
    await stores.registry.callGuarded(
      () => {
        stores.assertLive(incarnation);
        assertAdmin(context, input.agent);
      },
      "personGrant",
      input.profileId,
      input.agent,
      value,
      input.expectedRevision,
    );
    stores.assertLive(incarnation);
    if (storesRevision(stores.registry.current!.personGrants) !== storesRevision(next)) {
      return {
        outcome: "conflict",
        message: "Person grants changed; read person_grants and retry.",
      };
    }
    return { outcome: "applied", message: value ? "Person grant saved." : "Person grant removed." };
  }
  return { person_grants: snapshot, person_grant: grant };
}

#!/usr/bin/env node

import assert from "node:assert/strict";

const routingTable = {
  gatewayId: "gw-usw2-a-01",
  servedCells: {
    "cell-usw2-a": {
      dataResidencyRegion: "us-west",
      allowedCustomerTenants: ["cust_acme"],
      orgs: {
        org_build: {
          namespaceId: "ns-build-prod-a",
          runtimePools: ["pool-buildbot-prod"],
        },
      },
    },
  },
};

const aliasRegistry = new Map([
  [
    "abe_live",
    {
      canonicalPrincipalId: "principal_nikolay",
      orgId: "org_build",
      customerTenantId: "cust_acme",
      isolationCellId: "cell-usw2-a",
      bindingEpoch: 7,
      revoked: false,
    },
  ],
]);

function hash(value) {
  return `hash:${JSON.stringify(value)}`;
}

function assertAliasAssertion(assertion, now = 1000) {
  if (!assertion?.signed) throw new Error("alias_assertion_unsigned");
  if (assertion.aud !== routingTable.gatewayId) throw new Error("alias_assertion_bad_audience");
  if (assertion.exp <= now) throw new Error("alias_assertion_expired");
  if (assertion.replayed) throw new Error("alias_assertion_replay");
  const binding = aliasRegistry.get(assertion.aliasBindingEventId);
  if (!binding || binding.revoked) throw new Error("alias_binding_not_live");
  if (binding.bindingEpoch !== assertion.bindingEpoch) throw new Error("alias_binding_stale_epoch");
  if (binding.canonicalPrincipalId !== assertion.canonicalPrincipalId) {
    throw new Error("alias_binding_principal_mismatch");
  }
  return binding;
}

function createContextFromAlias(assertion, requested) {
  const binding = assertAliasAssertion(assertion);
  const cell = routingTable.servedCells[requested.isolationCellId];
  if (!cell) throw new Error("gateway_cell_not_served");
  if (!cell.allowedCustomerTenants.includes(binding.customerTenantId)) {
    throw new Error("customer_not_allowed_on_cell");
  }
  if (binding.isolationCellId !== requested.isolationCellId) {
    throw new Error("alias_cell_mismatch");
  }
  const orgRoute = cell.orgs[binding.orgId];
  if (!orgRoute) throw new Error("org_not_routed_on_cell");
  if (orgRoute.namespaceId !== requested.namespaceId) throw new Error("namespace_mismatch");
  if (!orgRoute.runtimePools.includes(requested.runtimePoolId))
    throw new Error("runtime_pool_mismatch");
  return {
    principalId: binding.canonicalPrincipalId,
    orgId: binding.orgId,
    customerTenantId: binding.customerTenantId,
    isolationCellId: binding.isolationCellId,
    namespaceId: requested.namespaceId,
    runtimePoolId: requested.runtimePoolId,
    dataResidencyRegion: cell.dataResidencyRegion,
  };
}

function mintRootCapability(context) {
  return {
    id: "cap_root",
    parentId: null,
    orgId: context.orgId,
    customerTenantId: context.customerTenantId,
    isolationCellId: context.isolationCellId,
    scopes: ["tool:read", "memory:read", "message:send"],
    dataClasses: ["public", "internal"],
    expiresAt: 2000,
    revoked: false,
    hash: hash(["root", context]),
  };
}

function attenuate(parent, requested) {
  if (parent.revoked) throw new Error("parent_revoked");
  if (requested.expiresAt > parent.expiresAt) throw new Error("child_expiry_exceeds_parent");
  if (requested.customerTenantId !== parent.customerTenantId)
    throw new Error("child_customer_mismatch");
  if (requested.isolationCellId !== parent.isolationCellId) throw new Error("child_cell_mismatch");
  for (const scope of requested.scopes) {
    if (!parent.scopes.includes(scope)) throw new Error("child_scope_exceeds_parent");
  }
  for (const dataClass of requested.dataClasses) {
    if (!parent.dataClasses.includes(dataClass)) throw new Error("child_data_class_exceeds_parent");
  }
  return {
    id: "cap_child",
    parentId: parent.id,
    ...requested,
    hash: hash(["child", parent.hash, requested]),
  };
}

function cachedAllowStillValid(decision, epochs) {
  if (decision.effect !== "allow") return true;
  return (
    decision.expiresAt > epochs.now &&
    decision.policyEpoch === epochs.policyEpoch &&
    decision.aliasBindingEpoch === epochs.aliasBindingEpoch &&
    decision.revocationEpoch === epochs.revocationEpoch &&
    decision.classificationEpoch === epochs.classificationEpoch
  );
}

function canReadMemory(record, context, policy) {
  if (record.state !== "active") throw new Error("memory_not_active");
  if (record.orgId !== context.orgId) throw new Error("memory_org_mismatch");
  if (record.customerTenantId !== context.customerTenantId)
    throw new Error("memory_customer_mismatch");
  if (record.isolationCellId !== context.isolationCellId) throw new Error("memory_cell_mismatch");
  if (!policy.allowedDataClasses.includes(record.dataClass))
    throw new Error("memory_data_class_denied");
  if (record.provenanceState !== "applied") throw new Error("memory_provenance_missing");
  if (record.erasureEpoch > policy.readerErasureEpoch)
    throw new Error("memory_erasure_epoch_stale");
  return true;
}

function materialActionAudited(actionReceipt, platformReceipt) {
  if (!actionReceipt) throw new Error("action_receipt_missing");
  if (actionReceipt.platformReceiptId !== platformReceipt.id)
    throw new Error("platform_receipt_not_linked");
  if (!actionReceipt.policyDecisionId) throw new Error("policy_decision_missing");
  if (!actionReceipt.receiptHash || !actionReceipt.signedBy)
    throw new Error("receipt_not_tamper_evident");
  return true;
}

function canResumeCheckpoint(checkpoint, context, capability) {
  if (checkpoint.contextHash !== hash(context)) throw new Error("checkpoint_context_mismatch");
  if (checkpoint.customerTenantId !== context.customerTenantId)
    throw new Error("checkpoint_customer_mismatch");
  if (checkpoint.isolationCellId !== context.isolationCellId)
    throw new Error("checkpoint_cell_mismatch");
  if (checkpoint.namespaceId !== context.namespaceId)
    throw new Error("checkpoint_namespace_mismatch");
  if (capability.revoked) throw new Error("checkpoint_capability_revoked");
  if (checkpoint.capabilityHash !== capability.hash)
    throw new Error("checkpoint_capability_mismatch");
  return true;
}

function erasureInvalidates(record, erasureEvent) {
  if (record.customerTenantId !== erasureEvent.customerTenantId) return false;
  if (record.orgId !== erasureEvent.orgId) return false;
  if (record.dataClass !== erasureEvent.dataClass) return false;
  record.state = "erasing";
  record.erasureEpoch = erasureEvent.erasureEpoch;
  return true;
}

function expectError(name, fn, expectedMessage) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.message, expectedMessage, name);
    return;
  }
  throw new Error(`${name}: expected ${expectedMessage}`);
}

const validAssertion = {
  signed: true,
  iss: "l5-adapter:telegram:prod",
  aud: "gw-usw2-a-01",
  exp: 2000,
  jti: "evt_1",
  aliasBindingEventId: "abe_live",
  bindingEpoch: 7,
  canonicalPrincipalId: "principal_nikolay",
};

const validRoute = {
  isolationCellId: "cell-usw2-a",
  namespaceId: "ns-build-prod-a",
  runtimePoolId: "pool-buildbot-prod",
};

expectError(
  "unsigned alias",
  () => createContextFromAlias({ ...validAssertion, signed: false }, validRoute),
  "alias_assertion_unsigned",
);
expectError(
  "wrong cell",
  () => createContextFromAlias(validAssertion, { ...validRoute, isolationCellId: "cell-euw1-a" }),
  "gateway_cell_not_served",
);
expectError(
  "wrong namespace",
  () => createContextFromAlias(validAssertion, { ...validRoute, namespaceId: "ns-other" }),
  "namespace_mismatch",
);
expectError(
  "wrong runtime pool",
  () => createContextFromAlias(validAssertion, { ...validRoute, runtimePoolId: "pool-other" }),
  "runtime_pool_mismatch",
);

const context = createContextFromAlias(validAssertion, validRoute);
const rootCap = mintRootCapability(context);

expectError(
  "child token scope exceeds parent",
  () =>
    attenuate(rootCap, {
      customerTenantId: "cust_acme",
      isolationCellId: "cell-usw2-a",
      scopes: ["tool:admin"],
      dataClasses: ["internal"],
      expiresAt: 1500,
    }),
  "child_scope_exceeds_parent",
);

expectError(
  "child token crosses customer",
  () =>
    attenuate(rootCap, {
      customerTenantId: "cust_other",
      isolationCellId: "cell-usw2-a",
      scopes: ["tool:read"],
      dataClasses: ["internal"],
      expiresAt: 1500,
    }),
  "child_customer_mismatch",
);

expectError(
  "child token outlives parent",
  () =>
    attenuate(rootCap, {
      customerTenantId: "cust_acme",
      isolationCellId: "cell-usw2-a",
      scopes: ["tool:read"],
      dataClasses: ["internal"],
      expiresAt: 3000,
    }),
  "child_expiry_exceeds_parent",
);

assert.equal(
  cachedAllowStillValid(
    {
      effect: "allow",
      expiresAt: 2000,
      policyEpoch: 1,
      aliasBindingEpoch: 7,
      revocationEpoch: 1,
      classificationEpoch: 3,
    },
    { now: 1000, policyEpoch: 1, aliasBindingEpoch: 7, revocationEpoch: 2, classificationEpoch: 3 },
  ),
  false,
  "stale allow invalidates on revocation epoch",
);

expectError(
  "memory graph edge missing blocks read",
  () =>
    canReadMemory(
      {
        state: "active",
        orgId: "org_build",
        customerTenantId: "cust_acme",
        isolationCellId: "cell-usw2-a",
        dataClass: "internal",
        provenanceState: "missing",
        erasureEpoch: 1,
      },
      context,
      { allowedDataClasses: ["internal"], readerErasureEpoch: 1 },
    ),
  "memory_provenance_missing",
);

expectError(
  "platform receipt without action receipt",
  () => materialActionAudited(null, { id: "msg_1" }),
  "action_receipt_missing",
);

expectError(
  "checkpoint wrong context hash",
  () =>
    canResumeCheckpoint(
      {
        contextHash: "hash:old",
        customerTenantId: "cust_acme",
        isolationCellId: "cell-usw2-a",
        namespaceId: "ns-build-prod-a",
        capabilityHash: rootCap.hash,
      },
      context,
      rootCap,
    ),
  "checkpoint_context_mismatch",
);

expectError(
  "checkpoint revoked capability",
  () =>
    canResumeCheckpoint(
      {
        contextHash: hash(context),
        customerTenantId: "cust_acme",
        isolationCellId: "cell-usw2-a",
        namespaceId: "ns-build-prod-a",
        capabilityHash: rootCap.hash,
      },
      context,
      { ...rootCap, revoked: true },
    ),
  "checkpoint_capability_revoked",
);

const memoryRecord = {
  state: "active",
  orgId: "org_build",
  customerTenantId: "cust_acme",
  isolationCellId: "cell-usw2-a",
  dataClass: "internal",
  provenanceState: "applied",
  erasureEpoch: 1,
};
assert.equal(
  erasureInvalidates(memoryRecord, {
    orgId: "org_build",
    customerTenantId: "cust_acme",
    dataClass: "internal",
    erasureEpoch: 2,
  }),
  true,
  "erasure event marks matching record",
);
expectError(
  "erasing record blocks read",
  () =>
    canReadMemory(memoryRecord, context, {
      allowedDataClasses: ["internal"],
      readerErasureEpoch: 1,
    }),
  "memory_not_active",
);

assert.equal(
  materialActionAudited(
    {
      id: "ar_1",
      platformReceiptId: "msg_1",
      policyDecisionId: "pd_1",
      receiptHash: "hash:receipt",
      signedBy: "spiffe://superclaw/cell-usw2-a/gateway",
    },
    { id: "msg_1" },
  ),
  true,
  "valid material action receipt",
);

console.log("contract-negative-tests: 14 checks passed");

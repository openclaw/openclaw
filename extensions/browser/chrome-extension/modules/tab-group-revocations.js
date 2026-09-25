import { ACCESS_MODE_SELECTED, OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";

/** Owns group-scoped authority clocks and the private initial naming exception. */
export function createTabGroupRevocations({
  createdTabs,
  provenEpochs,
  epochIsCurrent,
  invalidateDocuments,
  invalidateAll,
  reviseDiscovery,
}) {
  const revocations = new Map();
  let revision = 0;

  const isCurrent = (epoch, groupId) =>
    !Number.isInteger(groupId) ||
    groupId < 0 ||
    epoch.groupRevision >= (revocations.get(groupId) ?? 0);

  const isProvenCurrent = (tabId, epoch, isEpochCurrent) => {
    const proof = provenEpochs.get(epoch);
    return (
      proof?.tabId === tabId &&
      isEpochCurrent(tabId, { ...epoch, documentRevision: undefined }, proof.groupId)
    );
  };

  const invalidate = (group, removed = false) => {
    if (!Number.isInteger(group?.id) || group.id < 0) {
      invalidateAll();
      return;
    }
    reviseDiscovery();
    if (!removed && group.title === "") {
      const pendingCreationForGroup = [...createdTabs.values()].some(
        (created) => !created.handedOff && created.grouping && created.pendingGroupId === group.id,
      );
      if (pendingCreationForGroup) {
        // Chrome can emit membership before tabs.group() resolves. Defer
        // ownership until the operation result is available; do not revoke
        // the in-flight creation on an event that may be its own result.
        return;
      }
    }
    const foreignPendingCreation = [...createdTabs.entries()].filter(
      ([tabId, created]) =>
        !created.handedOff &&
        created.grouping &&
        created.pendingGroupId === group.id &&
        createdTabs.get(tabId) === created,
    );
    if (!removed && foreignPendingCreation.length > 0 && typeof group.title === "string") {
      if (group.title !== OPENCLAW_TAB_GROUP_TITLE) {
        // A readable unrelated title before the operation result proves the
        // pending membership was never our creation. Abandon it without a
        // private revocation so rollback cannot reclaim the user-held tab.
        for (const [, created] of foreignPendingCreation) {
          created.initialGroup = false;
          created.grouping = false;
          created.pendingGroupId = undefined;
          createdTabs.delete(created.tab.id);
        }
        return;
      }
    }
    for (const created of createdTabs.values()) {
      if (created.handedOff && created.groupFallback && created.groupId === group.id) {
        created.groupFallback = false;
      }
    }
    if (!removed && group.title === OPENCLAW_TAB_GROUP_TITLE) {
      for (const created of createdTabs.values()) {
        if (
          !created.handedOff &&
          created.namingGroup === group.id &&
          epochIsCurrent(created.tab.id, created.epoch)
        ) {
          created.namingGroup = undefined;
        }
      }
      return;
    }
    const naming = !removed
      ? [...createdTabs.values()].filter(
          (created) =>
            !created.handedOff &&
            created.namingGroup === group.id &&
            created.initialGroup &&
            group.title === "" &&
            epochIsCurrent(created.tab.id, created.epoch),
        )
      : [];
    invalidateDocuments(group);
    const next = ++revision;
    revocations.set(group.id, next);
    for (const created of naming) {
      // This private empty-title event may advance only its own epoch.
      created.epoch.groupRevision = next;
      created.initialGroup = false;
    }
  };

  return {
    capture: () => revision,
    captureEpoch: (accessRevision, tabRevision) => ({
      revision: accessRevision,
      groupRevision: revision,
      tabRevision,
    }),
    invalidate,
    isCreationCurrent: (created) =>
      isCurrent(created.epoch, created.expectedGroupId ?? created.groupId),
    isCurrent,
    isCurrentInMode: (mode, epoch, tab) =>
      mode !== ACCESS_MODE_SELECTED || isCurrent(epoch, tab?.groupId),
    isProvenCurrent,
  };
}

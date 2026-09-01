import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const importFromRepo = (file) => import(pathToFileURL(path.join(repo, file)).href);

function card(id, title, position, overrides = {}) {
  return {
    id,
    title,
    status: "todo",
    priority: "normal",
    labels: [],
    position,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sorted(values) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

async function main() {
  const [{ deleteWorkboardCard }, { getWorkboardState }] = await Promise.all([
    importFromRepo("extensions/workboard/browser/lib/workboard/mutations.ts"),
    importFromRepo("extensions/workboard/browser/lib/workboard/runtime.ts"),
  ]);
  if (process.argv[3] === "--negative-control") {
    const host = {};
    const state = getWorkboardState(host);
    const requests = [];
    const result = await deleteWorkboardCard({
      host,
      client: {
        request(method) {
          requests.push(method);
          assert(method === "workboard.cards.delete", `unexpected Gateway method: ${method}`);
          return Promise.resolve({ deleted: false });
        },
      },
      cardId: "missing-card",
    });
    console.log(
      JSON.stringify({
        entrypoint: "extensions/workboard/browser/lib/workboard/mutations.ts:deleteWorkboardCard",
        boundary: "production Workboard mutation with a missing-card negative control",
        result,
        requests,
        cards: state.cards.length,
      }),
    );
    return;
  }
  const checks = {
    entrypoint: "extensions/workboard/browser/lib/workboard/mutations.ts:deleteWorkboardCard",
    boundary: "production Workboard mutation with deferred Gateway acknowledgements",
  };

  {
    const deletion = deferred();
    const host = {};
    const state = getWorkboardState(host);
    const parent = card("parent", "Parent", 1000);
    const sibling = card("sibling", "Sibling", 2000);
    const selectedCardIds = new Set([parent.id, sibling.id]);
    state.cards = [parent, sibling];
    state.selectedCardIds = selectedCardIds;
    state.bulkDialog = {
      kind: "delete",
      cardIds: [parent.id, sibling.id],
      observedCards: [parent, sibling],
    };
    const client = {
      request(method) {
        assert(method === "workboard.cards.delete", `unexpected Gateway method: ${method}`);
        return deletion.promise;
      },
    };
    const pending = deleteWorkboardCard({ host, client, cardId: parent.id });
    const optimisticSelectionProjected =
      state.selectedCardIds.size === 1 && state.selectedCardIds.has(sibling.id);
    const optimisticBulkDialogProjected = state.bulkDialog?.cardIds.join(",") === sibling.id;
    deletion.reject(new Error("Gateway refused delete"));
    await pending;
    const selectionRestored =
      state.selectedCardIds.size === 2 &&
      state.selectedCardIds.has(parent.id) &&
      state.selectedCardIds.has(sibling.id);
    const bulkDialogRestored = state.bulkDialog?.cardIds.join(",") === `${parent.id},${sibling.id}`;
    checks.rejectedDelete = {
      optimisticSelectionProjected,
      optimisticBulkDialogProjected,
      selectionRestored,
      bulkDialogRestored,
      selectedCardIds: sorted(state.selectedCardIds),
      bulkDialogCardIds: state.bulkDialog?.cardIds,
      selectionIdentityPreserved: state.selectedCardIds === selectedCardIds,
      errorVisible: Boolean(state.error),
    };
  }

  {
    const deletion = deferred();
    const host = {};
    const state = getWorkboardState(host);
    const parent = card("changed-parent", "Parent", 1000);
    const sibling = card("changed-sibling", "Sibling", 2000);
    state.cards = [parent, sibling];
    state.selectedCardIds = new Set([parent.id, sibling.id]);
    const client = { request: () => deletion.promise };
    const pending = deleteWorkboardCard({ host, client, cardId: parent.id });
    state.selectedCardIds.delete(sibling.id);
    deletion.reject(new Error("Gateway refused delete"));
    await pending;
    checks.changedSelectionPreserved = {
      selectedCardIds: sorted(state.selectedCardIds),
      preserved: state.selectedCardIds.size === 0,
    };
  }

  {
    const parentDeletion = deferred();
    const siblingDeletion = deferred();
    const host = {};
    const state = getWorkboardState(host);
    const parent = card("overlap-parent", "Parent", 1000);
    const sibling = card("overlap-sibling", "Sibling", 2000);
    const selectedCardIds = new Set([parent.id, sibling.id]);
    state.cards = [parent, sibling];
    state.selectedCardIds = selectedCardIds;
    state.bulkDialog = {
      kind: "delete",
      cardIds: [parent.id, sibling.id],
      observedCards: [parent, sibling],
    };
    const client = {
      request(method, params) {
        assert(method === "workboard.cards.delete", `unexpected Gateway method: ${method}`);
        return (params.id === parent.id ? parentDeletion : siblingDeletion).promise;
      },
    };
    const parentPending = deleteWorkboardCard({ host, client, cardId: parent.id });
    const siblingPending = deleteWorkboardCard({ host, client, cardId: sibling.id });
    parentDeletion.reject(new Error("parent delete rejected"));
    await parentPending;
    siblingDeletion.reject(new Error("sibling delete rejected"));
    await siblingPending;
    const selectionRestored =
      state.selectedCardIds.size === 2 &&
      state.selectedCardIds.has(parent.id) &&
      state.selectedCardIds.has(sibling.id);
    const bulkDialogRestored = state.bulkDialog?.cardIds.join(",") === `${parent.id},${sibling.id}`;
    checks.overlappingRejectedDeletes = {
      selectionRestored,
      bulkDialogRestored,
      selectedCardIds: sorted(state.selectedCardIds),
      bulkDialogCardIds: state.bulkDialog?.cardIds,
      selectionIdentityPreserved: state.selectedCardIds === selectedCardIds,
    };
  }

  {
    const parentDeletion = deferred();
    const childDeletion = deferred();
    const host = {};
    const state = getWorkboardState(host);
    if (!(state.pendingCardRemovals instanceof Map)) {
      checks.concurrentCleanupRevision = {
        supported: false,
        reason: "pinned base does not expose pending rollback state",
      };
    } else {
      const parent = card("cleanup-parent", "Parent", 1000, { status: "done" });
      const child = card("cleanup-child", "Child", 2000, {
        metadata: {
          links: [{ id: "parent-link", type: "parent", targetCardId: parent.id, createdAt: 1 }],
        },
      });
      state.cards = [parent, child];
      const client = {
        request(method, params) {
          assert(method === "workboard.cards.delete", `unexpected Gateway method: ${method}`);
          return (params.id === parent.id ? parentDeletion : childDeletion).promise;
        },
      };
      const parentPending = deleteWorkboardCard({ host, client, cardId: parent.id });
      const childPending = deleteWorkboardCard({ host, client, cardId: child.id });
      parentDeletion.resolve({
        deleted: true,
        referenceUpdates: [{ id: child.id, previousUpdatedAt: child.updatedAt, updatedAt: 20 }],
      });
      await parentPending;
      assert(
        state.pendingCardRemovals.get(child.id)?.card?.updatedAt === 20,
        "cleanup revision did not update pending rollback snapshot",
      );
      childDeletion.reject(new Error("Gateway refused child delete"));
      await childPending;
      assert(
        state.cards.length === 1 && state.cards[0]?.id === child.id,
        "child rollback did not restore the child card",
      );
      assert(state.cards[0]?.updatedAt === 20, "child rollback restored stale revision");
      assert(!state.cards[0]?.metadata?.links, "child rollback resurrected a deleted parent link");
      checks.concurrentCleanupRevision = {
        supported: true,
        pendingRevisionBeforeChildRollback: 20,
        restoredCard: {
          id: state.cards[0]?.id,
          updatedAt: state.cards[0]?.updatedAt,
          links: state.cards[0]?.metadata?.links ?? [],
        },
      };
    }
  }

  console.log(JSON.stringify(checks));
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

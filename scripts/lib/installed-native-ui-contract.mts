import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Shared rendered witnesses complement the sixty in-process owner/race cases.
// Their phases attest real controls; they never stand in for private identity or joins.
export const nativePhoneWitnesses = {
  "run-controls": ["open", "done", "reopen", "gesture", "replace", "select-other"],
  "sidebar-routing": ["settings-held", "overview-held", "same-key-held", "chat-held"],
  "settings-paths": [
    "diagnostics",
    "diagnostics-back",
    "usage",
    "usage-back",
    "watch",
    "license",
    "headers",
    "logs",
  ],
  "dashboard-presentation": ["gear", "done", "gear-reopen", "gesture", "public-url", "url-done"],
  "native-projection": ["settings-open", "settings-inspect", "user-chat-open"],
  "sidebar-fork": ["menu", "fork", "adopted"],
  "new-chat": ["bound-held", "protected-editor", "ordinary"],
  "fork-session-controls": [
    "fork",
    "remove-attachment",
    "fork-again",
    "reset",
    "new-thread",
    "return-child",
  ],
  "app-chat-modal": ["background-tasks", "refused", "done", "fresh-open"],
  "shared-chat-modal": ["select-text", "refused", "close", "fresh-open"],
  "new-options-landscape": ["landscape", "cover", "create-refused", "retry-created", "portrait"],
  "pages-portrait": ["edit", "pin", "unpin", "done", "reopen", "gesture", "select"],
  "pages-landscape": ["landscape", "cover", "refused", "done", "fresh-open", "portrait"],
  "gateway-problem": ["node-fault", "details", "refused", "done", "operator-current", "fresh-open"],
  "approval-dashboard": ["inbox", "review", "refused", "done", "cancel", "fresh-open"],
  "notification-guidance": [
    "system-denied",
    "approval-event",
    "prompt",
    "refused",
    "not-now",
    "fresh-open",
  ],
  "agent-deeplink": ["public-url", "prompt", "refused", "cancel", "fresh-open"],
  "gateway-trust": ["public-setup", "fingerprint", "refused", "cancel", "fresh-open"],
} as const;

// This is an actual iPad split layout. The synthetic 1024x768 plus vertical-compact
// condition remains in the hosted owner test and is not claimed by this witness.
export const nativeTabletWitnesses = {
  "split-pages": ["landscape", "split-visible", "edit", "pin", "unpin", "done", "select"],
} as const;

export const nativeUISelectors = {
  phone: "NativeActionUITests/testNativeControlsPreserveOwnerAuthority",
  tablet: "NativeActionUITests/testSplitPagesControlsPreserveOwnerAuthority",
} as const;
export type NativeUIKind = keyof typeof nativeUISelectors;

export function nativeUIPhases(kind: NativeUIKind): string[] {
  assert(kind === "phone" || kind === "tablet", "Unknown native UI inventory");
  const roster: Readonly<Record<string, readonly string[]>> =
    kind === "phone" ? nativePhoneWitnesses : nativeTabletWitnesses;
  const phases = ["onboarded"];
  for (const [id, steps] of Object.entries(roster)) {
    phases.push(id + ":begin");
    for (const step of steps) {
      phases.push(id + ":" + step);
    }
    phases.push(id + ":complete");
  }
  phases.push("complete");
  return phases;
}

export type NativeUIObservation = {
  forwardingEntries: number;
  forwardingCompletions: number;
  forwardingKind: "none" | "session" | "compose" | "inspect";
  forwardingOutcome: "none" | "opened" | "cancelled" | "unavailable";
  forwardingOverflow: boolean;
  forwardingMisattributed: boolean;
  idleUnprotectedComposer: boolean;
};

export function readNativeUIObservation(value: unknown): NativeUIObservation {
  assert(isRecord(value), "Missing native UI owner observation");
  for (const key of ["forwardingEntries", "forwardingCompletions"] as const) {
    assert(
      Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) < 256,
      "Native UI observation counter overflow or invalid value",
    );
  }
  assert(
    typeof value.forwardingKind === "string" &&
      ["none", "session", "compose", "inspect"].includes(value.forwardingKind),
  );
  assert(
    typeof value.forwardingOutcome === "string" &&
      ["none", "opened", "cancelled", "unavailable"].includes(value.forwardingOutcome),
  );
  assert.equal(value.forwardingOverflow, false);
  assert.equal(value.forwardingMisattributed, false);
  assert.equal(typeof value.idleUnprotectedComposer, "boolean");
  return {
    forwardingEntries: Number(value.forwardingEntries),
    forwardingCompletions: Number(value.forwardingCompletions),
    forwardingKind: value.forwardingKind as NativeUIObservation["forwardingKind"],
    forwardingOutcome: value.forwardingOutcome as NativeUIObservation["forwardingOutcome"],
    forwardingOverflow: false,
    forwardingMisattributed: false,
    idleUnprotectedComposer: value.idleUnprotectedComposer as boolean,
  };
}

export function assertNativeUIForward(
  before: NativeUIObservation,
  after: NativeUIObservation,
  kind: Exclude<NativeUIObservation["forwardingKind"], "none">,
  outcome: Exclude<NativeUIObservation["forwardingOutcome"], "none">,
) {
  assert.equal(
    before.forwardingEntries,
    before.forwardingCompletions,
    "Previous native action is still owned",
  );
  assert.equal(after.forwardingEntries, before.forwardingEntries + 1);
  assert.equal(after.forwardingCompletions, before.forwardingCompletions + 1);
  assert.equal(after.forwardingKind, kind);
  assert.equal(after.forwardingOutcome, outcome);
}

export function assertNativeUITestResult(value: unknown, kind: NativeUIKind) {
  assert(isRecord(value) && Array.isArray(value.testNodes), "Missing native UI result tree");
  const cases: Record<string, unknown>[] = [];
  const visit = (nodes: unknown[]) => {
    for (const node of nodes) {
      assert(isRecord(node) && typeof node.nodeType === "string", "Invalid native UI result node");
      if (node.nodeType === "Test Case") {
        cases.push(node);
      }
      if (node.children !== undefined) {
        assert(Array.isArray(node.children));
        visit(node.children);
      }
    }
  };
  visit(value.testNodes);
  assert.equal(cases.length, 1, "Each native UI selector owns exactly one XCTest result");
  assert(kind === "phone" || kind === "tablet", "Unknown native UI inventory");
  const expected = nativeUISelectors[kind];
  assert.equal(typeof cases[0]!.nodeIdentifier, "string", "Invalid native UI selector identity");
  const identifier = (cases[0]!.nodeIdentifier as string).replace(/\(\)$/, "");
  assert(
    identifier === expected || identifier === "OpenClawUITests/" + expected,
    "Wrong native UI selector result",
  );
  assert.equal(cases[0]!.result, "Passed");
}

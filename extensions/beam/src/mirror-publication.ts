import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  enrollBeamMirrorV2,
  inspectBeamMirrorV2Enrollment,
  prepareBeamMirrorV2Intent,
  publishBeamMirrorV2,
  requireBeamMirrorPublisher,
  type BeamMirrorV2Head,
  type BeamMirrorV2Intent,
} from "./mirror-v2.js";

export type BeamMirrorEnrollment = {
  catalogId: string;
  hostId: string;
  threadId: string;
  agentId: string;
  sourceHomeId: string;
};
type InitialWrite = { beamId: string; requestId: string; sha256: string };
export type MirrorPublicationStoreValue = {
  sourceSalt: string;
  credential: string;
  initial?: InitialWrite;
  head?: BeamMirrorV2Head;
  pending?: { beamId: string; raw: string; intent: BeamMirrorV2Intent };
  fenced?: "released" | "conflict";
};
type Store = Pick<
  PluginStateKeyedStore<MirrorPublicationStoreValue, 2>,
  "observe" | "compareAndApply" | "registerIfAbsent"
>;

function credentialScope(salt: string, token?: string): string {
  return createHmac("sha256", salt)
    .update(JSON.stringify(token ?? null))
    .digest("hex");
}

export async function openBeamMirrorEnrollment(params: {
  store: Store;
  source: BeamMirrorEnrollment;
  endpoint: string;
  token?: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  explicit?: boolean;
  confirmGeneration?: string;
  revalidate?: () => Promise<void>;
}) {
  const { store, source } = params;
  const endpoint = new URL(params.endpoint).href;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        endpoint,
        source.catalogId,
        source.hostId,
        source.threadId,
        source.agentId,
        source.sourceHomeId,
      ]),
    )
    .digest("hex");
  const options = {
    endpoint,
    token: params.token,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  };
  let row = await store.observe(key);
  if (!row.value && params.confirmGeneration) {
    throw new Error("No enrollment exists for this receiver and native source");
  }
  if (
    params.explicit &&
    !params.confirmGeneration &&
    !row.value?.initial &&
    !row.value?.head &&
    !row.value?.fenced
  ) {
    await requireBeamMirrorPublisher(options);
    params.assertCurrent();
    const sourceSalt = row.value?.sourceSalt ?? randomUUID();
    const credential = credentialScope(sourceSalt, params.token);
    if (!row.value) {
      await store.registerIfAbsent(key, { sourceSalt, credential });
    } else if (row.value.credential !== credential) {
      // With no first-write intent there can be no remote publication to adopt.
      // A stopped clean may leave exactly this local reservation across credential rotation.
      await store.compareAndApply(key, row.comparison, {
        operation: "update",
        action: "set",
        value: { sourceSalt, credential },
      });
    }
    row = await store.observe(key);
  }
  if (!row.value) {
    return undefined;
  }
  params.assertCurrent();
  const credential = credentialScope(row.value.sourceSalt, params.token);
  if (row.value.credential !== credential) {
    const previous = row.value;
    const publicationId = params.confirmGeneration;
    if (
      !params.explicit ||
      !publicationId ||
      previous.fenced ||
      !previous.initial ||
      (previous.head && previous.head.publicationId !== publicationId)
    ) {
      throw new Error(
        "Receiver credential changed. Select the original publication and confirm its exact generation to reauthorize.",
      );
    }
    const seen = await inspectBeamMirrorV2Enrollment({
      ...options,
      beamId: previous.initial.beamId,
      sha256: previous.head?.sha256 ?? previous.initial.sha256,
      pendingSha256: previous.pending?.intent.sha256,
    });
    if (
      seen.state !== "observed" ||
      seen.head.publicationId !== publicationId ||
      (previous.head &&
        previous.head.revision !== seen.head.revision &&
        previous.pending?.intent.sha256 !== seen.head.sha256)
    ) {
      throw new Error(
        "The new credential could not verify publisher authority on the enrolled generation",
      );
    }
    await params.revalidate?.();
    params.assertCurrent();
    // Reauthorization changes the local credential only. A previously uncertain
    // update retains its original bytes, request ID and revision for normal replay.
    const value = { ...previous, credential, head: previous.head ?? seen.head };
    const saved = await store.compareAndApply(key, row.comparison, {
      operation: "update",
      action: "set",
      value,
    });
    if (saved.status === "conflict") {
      throw new Error("Enrollment changed during credential verification");
    }
    row = await store.observe(key);
    if (row.value?.credential !== credential) {
      throw new Error("Enrollment changed after credential verification");
    }
  }
  const binding = row.value;
  const describe = () => ({
    state: binding.fenced ?? (binding.head ? "published" : "unconfirmed"),
    head: binding.head,
    beamId: binding.initial?.beamId,
  });
  return {
    sourceSalt: binding.sourceSalt,
    active: Boolean(binding.head),
    fenced: binding.fenced,
    describe,
    async enroll(beamId: string, raw: Buffer, confirmGeneration?: string) {
      if (!params.explicit) {
        throw new Error("Explicit operator enrollment required");
      }
      if (binding.head || binding.fenced) {
        return describe();
      }
      let observed = row;
      let initial = binding.initial;
      if (initial && !confirmGeneration) {
        return {
          state: "unconfirmed",
          beamId: initial.beamId,
          sha256: initial.sha256,
          message:
            "Inspect the original receiver publication. To adopt its existing generation, repeat beam.mirror.enroll with confirmGeneration.",
        };
      }
      if (!initial && confirmGeneration) {
        throw new Error("There is no pending first publication to confirm");
      }
      if (!initial) {
        initial = {
          beamId,
          requestId: randomUUID(),
          sha256: "sha256:" + createHash("sha256").update(raw).digest("hex"),
        };
        params.assertCurrent();
        const saved = await store.compareAndApply(key, observed.comparison, {
          operation: "update",
          action: "set",
          value: { ...binding, initial },
        });
        if (saved.status === "conflict") {
          throw new Error("Another enrollment is in progress; inspect the existing publication");
        }
        observed = await store.observe(key);
        if (
          observed.value?.initial?.requestId !== initial.requestId ||
          observed.value.head ||
          observed.value.fenced
        ) {
          throw new Error(
            "Another operation updated this enrollment. Inspect the existing publication.",
          );
        }
      }
      params.assertCurrent();
      // An uncertain first create can only be inspected. The operator chooses the
      // exact current generation, and the poller has no path to create or enroll.
      const result = confirmGeneration
        ? await inspectBeamMirrorV2Enrollment({
            ...options,
            beamId: initial.beamId,
            sha256: initial.sha256,
          })
        : await enrollBeamMirrorV2({ ...options, beamId, raw, requestId: initial.requestId });
      if (
        (result.state !== "published" && result.state !== "observed") ||
        (confirmGeneration && result.head.publicationId !== confirmGeneration)
      ) {
        throw new Error(
          "The selected publication could not be confirmed. Inspect its original receiver and generation.",
        );
      }
      await params.revalidate?.();
      params.assertCurrent();
      const saved = await store.compareAndApply(key, observed.comparison, {
        operation: "update",
        action: "set",
        value: { ...binding, initial, head: result.head },
      });
      if (saved.status === "conflict") {
        throw new Error(
          "Another operation updated this enrollment. Inspect the existing publication.",
        );
      }
      return { state: "published", beamId: initial.beamId, head: result.head };
    },
    async isAcknowledged(head: BeamMirrorV2Head) {
      // A catalog read can overlap a different writer or an operator reauthorization.
      // Only the current, settled local receipt can suppress a native clean.
      const { value } = await store.observe(key);
      params.assertCurrent();
      return (
        value?.credential === credential &&
        value.sourceSalt === binding.sourceSalt &&
        !value.pending &&
        !value.fenced &&
        value.head?.publicationId === head.publicationId &&
        value.head.revision === head.revision &&
        value.head.sha256 === head.sha256
      );
    },
    async publish(beamId: string, raw: Buffer): Promise<BeamMirrorV2Head | false | "retired"> {
      let observed = await store.observe(key);
      let current = observed.value;
      if (
        !current?.head ||
        current.credential !== credential ||
        current.sourceSalt !== binding.sourceSalt ||
        current.initial?.beamId !== beamId
      ) {
        return false;
      }
      if (current.fenced) {
        return "retired";
      }
      if (!current.pending) {
        const intent = prepareBeamMirrorV2Intent(raw, current.head);
        if (current.head.sha256 === intent.sha256) {
          return current.head;
        }
        params.assertCurrent();
        const next = { ...current, pending: { beamId, raw: raw.toString("base64"), intent } };
        const saved = await store.compareAndApply(key, observed.comparison, {
          operation: "update",
          action: "set",
          value: next,
        });
        if (saved.status === "conflict") {
          return false;
        }
        observed = await store.observe(key);
        current = observed.value;
      }
      const pending = current?.pending;
      if (
        !current ||
        !pending ||
        current.fenced ||
        current.credential !== credential ||
        current.sourceSalt !== binding.sourceSalt
      ) {
        return false;
      }
      params.assertCurrent();
      const result = await publishBeamMirrorV2({
        ...options,
        beamId: pending.beamId,
        raw: Buffer.from(pending.raw, "base64"),
        intent: pending.intent,
      });
      params.assertCurrent();
      const { pending: _pending, ...retained } = current;
      const next =
        result.state === "published"
          ? { ...retained, head: result.head }
          : { ...retained, fenced: result.state };
      const saved = await store.compareAndApply(key, observed.comparison, {
        operation: "update",
        action: "set",
        value: next,
      });
      if (saved.status === "conflict") {
        return false;
      }
      if (result.state !== "published") {
        return "retired";
      }
      // Replaying an older pending write cannot acknowledge a later candidate.
      return pending.beamId === beamId && pending.raw === raw.toString("base64")
        ? result.head
        : false;
    },
  };
}

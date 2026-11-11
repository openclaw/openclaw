import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// This is a bounded transport for raw evidence, not an authorization cache.
// Immutable responses replay through their original semantic validators.
// Preview acquisition observations are separate and always refreshed at effect.
export const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 512;
// Only closed graph identity/selection observations can cross the authenticated
// preview handoff. Permissions, refs and branch comparisons never enter it.
const acquisitionRoute = /^actions\/(?:artifacts\/[1-9][0-9]*|runs\/[1-9][0-9]*)$/u;
const runAttemptRoute = /^actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u;
const immutableRoute =
  /^(?:contents\/(?:\.github\/workflows\/[a-z0-9-]+\.yml|scripts\/lib\/[a-z0-9-]+\.json)\?ref=[a-f0-9]{40}|actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/jobs\?per_page=(?:30|50|100)(?:&page=[1-9][0-9]*)?|actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/jobs\?page=[1-9][0-9]*&per_page=(?:30|50|100)|actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}(?:\?per_page=1&page=2)?|actions\/jobs\/[1-9][0-9]*\/logs|actions\/artifacts\/[1-9][0-9]*\/zip)$/u;
const archiveIdentity = (metadata) => [
  metadata.id,
  metadata.name,
  metadata.digest,
  metadata.size_in_bytes,
  metadata.expires_at,
  metadata.workflow_run,
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createReleaseEvidenceReplay(
  binding,
  payload,
  { shareAcquisitionReads = false } = {},
) {
  // CLI acquisition may share raw observations, never a validation verdict.
  // This map is process-local, excluded from serialize(), and discarded before
  // every effect-boundary revalidation. Public helper transports remain live.
  const liveReads = new Map();
  const acquisitionReads = new Map();
  let acquiring = true;
  let preparedEvidence;
  const entries = new Map();
  const runs = new Map();
  const usedArchives = new Map();
  let size = 0;
  const jobPageSizes = new Map();
  const insert = (route, value) => {
    if (
      !immutableRoute.test(route) ||
      entries.has(route) ||
      entries.size >= MAX_ENTRIES ||
      !["text", "bytes"].includes(value.kind) ||
      typeof value.data !== "string"
    ) {
      throw new Error("Invalid or duplicate immutable evidence response");
    }
    const bytes = Buffer.from(value.data, value.kind === "bytes" ? "base64" : "utf8");
    if (
      bytes.length > MAX_ENTRY_BYTES ||
      digest(bytes) !== value.sha256 ||
      (value.kind === "bytes" && bytes.toString("base64") !== value.data)
    ) {
      throw new Error("Immutable evidence response digest or size mismatch");
    }
    if (runAttemptRoute.test(route) && JSON.parse(bytes.toString("utf8")).status !== "completed") {
      throw new Error("Only completed exact-attempt run evidence can be reused");
    }
    if (route.includes("/jobs?")) {
      const response = JSON.parse(bytes.toString("utf8"));
      if (
        !Array.isArray(response.jobs) ||
        response.jobs.some((job) => job.status !== "completed")
      ) {
        throw new Error("Only completed exact-attempt job evidence can be reused");
      }
    }
    size += Buffer.byteLength(JSON.stringify([route, value]));
    if (size > MAX_REPLAY_BYTES) {
      throw new Error("Immutable evidence exceeds its byte limit");
    }
    entries.set(route, value);
  };
  if (payload !== undefined) {
    if (
      payload?.schema !== "openclaw.release-evidence-replay/v1" ||
      !isDeepStrictEqual(payload.binding, binding) ||
      !Array.isArray(payload.entries) ||
      Buffer.byteLength(JSON.stringify(payload)) > MAX_REPLAY_BYTES
    ) {
      throw new Error("Immutable evidence differs from this publication attempt");
    }
    for (const [route, value] of payload.entries) {
      insert(route, value);
    }
    if (
      !Array.isArray(payload.archives ?? []) ||
      (payload.archives?.length ?? 0) > MAX_ENTRIES ||
      !Array.isArray(payload.acquisitionReads ?? []) ||
      (payload.acquisitionReads?.length ?? 0) > MAX_ENTRIES
    ) {
      throw new Error("Invalid evidence dependency inventory");
    }
    for (const [route, metadata] of payload.archives ?? []) {
      if (!/^actions\/artifacts\/[1-9][0-9]*\/zip$/u.test(route) || usedArchives.has(route)) {
        throw new Error("Invalid evidence artifact dependency");
      }
      usedArchives.set(route, metadata);
    }
    for (const [route, raw] of payload.acquisitionReads ?? []) {
      if (
        !acquisitionRoute.test(route) ||
        typeof raw !== "string" ||
        Buffer.byteLength(raw) > MAX_ENTRY_BYTES ||
        acquisitionReads.has(route)
      ) {
        throw new Error("Invalid acquisition evidence observation");
      }
      acquisitionReads.set(route, raw);
    }
    if (!Array.isArray(payload.jobPageSizes)) {
      throw new Error("Missing job listing selection");
    }
    for (const [path, perPage] of payload.jobPageSizes) {
      if (
        !/^actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/jobs\?$/u.test(path) ||
        ![100, 50, 30].includes(perPage) ||
        jobPageSizes.has(path)
      ) {
        throw new Error("Invalid job listing selection");
      }
      jobPageSizes.set(path, perPage);
    }
  }
  const read = (route, kind, load) => {
    if (!immutableRoute.test(route)) {
      if (!shareAcquisitionReads) {
        return load();
      }
      const key = kind + ":" + route;
      if (liveReads.has(key)) {
        return liveReads.get(key);
      }
      const record = (raw) => {
        liveReads.set(key, raw);
        if (
          acquiring &&
          kind === "text" &&
          acquisitionRoute.test(route) &&
          !acquisitionReads.has(route)
        ) {
          acquisitionReads.set(route, raw);
        }
        return raw;
      };
      const value = load();
      return value instanceof Promise ? value.then(record) : record(value);
    }
    if (route.endsWith("/zip") && !usedArchives.has(route)) {
      usedArchives.set(route, undefined);
    }
    const found = entries.get(route);
    if (found) {
      if (found.kind !== kind) {
        throw new Error("Immutable evidence response encoding changed");
      }
      return kind === "bytes" ? Buffer.from(found.data, "base64") : found.data;
    }
    if (payload !== undefined) {
      // Historical runs and jobs can retain nonterminal rows. Fetch those live;
      // only completed exact-attempt responses may enter the replay payload.
      if (runAttemptRoute.test(route) || route.includes("/jobs?")) {
        return load();
      }
      throw new Error(`Missing immutable evidence response: ${route}`);
    }
    const record = (raw) => {
      const bytes = Buffer.from(raw);
      if (
        runAttemptRoute.test(route) &&
        JSON.parse(bytes.toString("utf8")).status !== "completed"
      ) {
        return raw;
      }
      if (route.includes("/jobs?")) {
        const response = JSON.parse(bytes.toString("utf8"));
        if (
          !Array.isArray(response.jobs) ||
          response.jobs.some((job) => job.status !== "completed")
        ) {
          return raw;
        }
      }
      const value = {
        kind,
        data: kind === "bytes" ? bytes.toString("base64") : bytes.toString("utf8"),
        sha256: digest(bytes),
      };
      if (entries.has(route)) {
        if (!isDeepStrictEqual(entries.get(route), value)) {
          throw new Error("Immutable evidence changed during acquisition");
        }
      } else {
        insert(route, value);
      }
      return raw;
    };
    const value = load();
    return value instanceof Promise ? value.then(record) : record(value);
  };
  return {
    setPreparedEvidence(value) {
      preparedEvidence = value;
    },
    observeRun(route, run) {
      if (/^actions\/runs\/[1-9][0-9]*$/u.test(route)) {
        const identity = (value) => [
          value.id,
          value.run_attempt,
          value.status,
          value.conclusion,
          value.head_sha,
          value.head_branch,
          value.path,
          value.event,
          value.repository?.full_name,
          value.head_repository?.full_name,
        ];
        const value = identity(run);
        if (runs.has(route) && !isDeepStrictEqual(runs.get(route), value)) {
          throw new Error("Evidence producer identity changed during acquisition");
        }
        runs.set(route, value);
      }
    },
    async revalidate(client) {
      // Preview owns graph authentication. Every publication boundary owns a
      // fresh sweep of its complete dependency set, including metadata-only
      // retained payloads; no permission or ref verdict crosses the handoff.
      acquiring = false;
      liveReads.clear();
      const artifacts = new Map();
      for (const [route, raw] of acquisitionReads) {
        const expected = JSON.parse(raw);
        if (route.startsWith("actions/runs/")) {
          this.observeRun(route, expected);
        } else {
          artifacts.set(String(expected.id), expected);
        }
      }
      for (const [route] of runs) {
        this.observeRun(route, await client.getRun(route.split("/").at(-1)));
      }
      for (const [route, expected] of usedArchives) {
        if (shareAcquisitionReads && expected) {
          artifacts.set(route.split("/").at(-2), expected);
        }
      }
      // A complete producer inventory validates several exact artifact tuples
      // in one request. Single artifacts retain the cheaper direct metadata read.
      const byProducer = new Map();
      for (const [id, expected] of artifacts) {
        const producer = String(expected.workflow_run.id);
        const group = byProducer.get(producer) ?? [];
        group.push([id, expected]);
        byProducer.set(producer, group);
      }
      for (const [producer, group] of byProducer) {
        const listed =
          shareAcquisitionReads && group.length > 1
            ? await client.getRunArtifacts(producer)
            : undefined;
        for (const [id, expected] of group) {
          const current = listed
            ? listed.find((entry) => String(entry.id) === id)
            : await client.getArtifact(id);
          if (
            !current ||
            current.expired !== false ||
            !(Date.parse(current.expires_at) > Date.now()) ||
            !isDeepStrictEqual(archiveIdentity(current), archiveIdentity(expected))
          ) {
            throw new Error(`Evidence artifact ${id} changed or expired before publication`);
          }
          liveReads.set("text:actions/artifacts/" + id, JSON.stringify(current));
        }
      }
      for (const [route, expected] of usedArchives) {
        const id = route.split("/").at(-2);
        const metadata = await client.getArtifact(id);
        const bytes = entries.has(route)
          ? Buffer.from(entries.get(route).data, "base64")
          : undefined;
        if (
          String(metadata.id) !== id ||
          metadata.expired !== false ||
          !(Date.parse(metadata.expires_at) > Date.now()) ||
          metadata.size_in_bytes !== (bytes?.length ?? expected.size_in_bytes) ||
          metadata.digest !== (bytes ? "sha256:" + digest(bytes) : expected.digest) ||
          (expected && !isDeepStrictEqual(archiveIdentity(metadata), archiveIdentity(expected)))
        ) {
          throw new Error("Evidence artifact changed or expired before publication");
        }
        usedArchives.set(route, metadata);
      }
      // The authority callback is synchronous and must run after the last wait.
      liveReads.clear();
    },
    observeArchive(artifactId, metadata) {
      usedArchives.set("actions/artifacts/" + artifactId + "/zip", metadata);
    },
    jobPageSizes(path) {
      const selected = jobPageSizes.get(path);
      return payload && selected ? [selected] : undefined;
    },
    selectJobPageSize(path, perPage) {
      if (/^actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/jobs\?$/u.test(path)) {
        jobPageSizes.set(path, perPage);
      }
    },
    text: (route, load) => read(route, "text", load),
    bytes: (route, load) => read(route, "bytes", load),
    serialize() {
      const serialized = JSON.stringify({
        schema: "openclaw.release-evidence-replay/v1",
        binding,
        entries: [...entries],
        acquisitionReads: [...acquisitionReads],
        archives: [...usedArchives],
        preparedEvidence,
        jobPageSizes: [...jobPageSizes],
      });
      if (Buffer.byteLength(serialized) > MAX_REPLAY_BYTES) {
        throw new Error("Immutable evidence exceeds its byte limit");
      }
      return serialized;
    },
  };
}

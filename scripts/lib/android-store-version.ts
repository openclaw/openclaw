import { z } from "zod";
import { encodeMobileStoreVersion, MAX_MOBILE_STORE_REVISION } from "./mobile-store-version.ts";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version.mjs";

const ANDROID_VERSION_CODE_MAX = 2_100_000_000;
export const ANDROID_RELEASE_REF_PREFIX = "refs/openclaw/mobile-releases/android";
const Code = z.number().int().positive().max(ANDROID_VERSION_CODE_MAX);
const LegacyMax = z.number().int().nonnegative().max(ANDROID_VERSION_CODE_MAX);
const Sha = z.string().regex(/^[a-f0-9]{40}$/u);
const Baseline = z.object({
  audience: z.enum(["phone", "wear"]),
  version: z.string().nullable(),
  build: z
    .string()
    .regex(/^[1-9]\d*$/u)
    .nullable(),
  sourceRef: z.string().optional(),
});
const Identity = z.object({
  gatewayVersion: z.string(),
  revision: z.number().int().min(0).max(MAX_MOBILE_STORE_REVISION),
  buildNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: z.string(),
  versionCode: Code,
  wearVersionCode: Code,
});
const Plan = Identity.extend({
  schemaVersion: z.literal(2),
  legacyMaxVersionCode: LegacyMax,
  sourceSha: Sha,
  releaseNotesBaselines: z.array(Baseline),
});
const Snapshot = z.object({
  uploadedVersionCodes: z.array(Code),
  tracks: z.array(
    z.object({
      track: z.string(),
      releases: z.array(z.object({ status: z.string(), versionCodes: z.array(z.string()) })),
    }),
  ),
});

export type AndroidStorePlan = z.infer<typeof Plan>;
type AndroidPlaySnapshot = z.infer<typeof Snapshot>;
type StoreIdentity = z.infer<typeof Identity>;
export type AndroidReleaseRef = { ref: string; sha: string };
type ReleaseRecord = StoreIdentity & { sourceRef: string; legacy: boolean };

function validateIdentity(value: unknown): StoreIdentity {
  const identity = Identity.parse(value);
  if (identity.version !== encodeMobileStoreVersion(identity.gatewayVersion, identity.revision)) {
    throw new Error("Android store version does not match its Gateway version and revision.");
  }
  if (identity.wearVersionCode !== identity.versionCode + 1) {
    throw new Error("Android store Wear versionCode must equal the phone code plus 1.");
  }
  return identity;
}

export function androidStoreReleaseRef(plan: StoreIdentity): string {
  const identity = validateIdentity(plan);
  return `${ANDROID_RELEASE_REF_PREFIX}/v2/${identity.gatewayVersion}/${identity.revision}/${identity.buildNumber}/${identity.versionCode}-${identity.wearVersionCode}`;
}

export function androidStoreCutoverRef(legacyMaxVersionCode: number): string {
  return `${ANDROID_RELEASE_REF_PREFIX}/cutover-v2/${LegacyMax.parse(legacyMaxVersionCode)}`;
}

function parseAndroidStoreReleaseRef(ref: string): StoreIdentity {
  const match =
    /^refs\/openclaw\/mobile-releases\/android\/v2\/([^/]+)\/(0|[1-9]\d*)\/([1-9]\d*)\/([1-9]\d*)-([1-9]\d*)$/u.exec(
      ref,
    );
  if (!match) {
    throw new Error(`Invalid Android store release ref: ${ref}.`);
  }
  const gatewayVersion = match[1]!;
  const revision = Number(match[2]);
  const identity = validateIdentity({
    gatewayVersion,
    revision,
    buildNumber: Number(match[3]),
    version: encodeMobileStoreVersion(gatewayVersion, revision),
    versionCode: Number(match[4]),
    wearVersionCode: Number(match[5]),
  });
  if (androidStoreReleaseRef(identity) !== ref) {
    throw new Error(`Noncanonical Android store release ref: ${ref}.`);
  }
  return identity;
}

export function validateAndroidStoreBaseline(baseline: z.infer<typeof Baseline>): void {
  if (baseline.version === null || baseline.build === null) {
    if (baseline.version !== null || baseline.build !== null || baseline.sourceRef !== undefined) {
      throw new Error("Android first-release baseline must have no version, build, or source ref.");
    }
    return;
  }
  const code = Code.parse(Number(baseline.build));
  if (baseline.sourceRef?.startsWith(`${ANDROID_RELEASE_REF_PREFIX}/v2/`)) {
    const identity = parseAndroidStoreReleaseRef(baseline.sourceRef);
    const expectedCode =
      baseline.audience === "phone" ? identity.versionCode : identity.wearVersionCode;
    if (baseline.version !== identity.version || code !== expectedCode) {
      throw new Error("Android public baseline does not match its recorded store identity.");
    }
    return;
  }
  const legacy = legacyRelease(code, baseline.audience);
  if (
    legacy.version !== baseline.version ||
    (baseline.sourceRef !== undefined && baseline.sourceRef !== legacy.sourceRef)
  ) {
    throw new Error("Android public baseline does not match its legacy source ref.");
  }
}

export function validateAndroidStorePlan(value: unknown): AndroidStorePlan {
  const plan = Plan.parse(value);
  validateIdentity(plan);
  if (plan.versionCode <= plan.legacyMaxVersionCode) {
    throw new Error("Android store codes must be above the legacy cutover maximum.");
  }
  if (
    plan.releaseNotesBaselines.length !== 2 ||
    plan.releaseNotesBaselines[0]?.audience !== "phone" ||
    plan.releaseNotesBaselines[1]?.audience !== "wear"
  ) {
    throw new Error("Android release plan must contain phone and Wear production baselines.");
  }
  for (const baseline of plan.releaseNotesBaselines) {
    validateAndroidStoreBaseline(baseline);
  }
  return plan;
}

function legacyRelease(code: number, audience?: "phone" | "wear"): ReleaseRecord {
  const match = /^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[1-9]\d)(\d{2})$/u.exec(String(code));
  const suffix = Number(match?.[4]);
  const actualAudience = suffix >= 51 && suffix <= 99 ? "wear" : "phone";
  if (
    !match ||
    !((suffix >= 1 && suffix <= 49) || (suffix >= 51 && suffix <= 99)) ||
    (audience && audience !== actualAudience)
  ) {
    throw new Error(`Cannot identify legacy Android ${audience ?? "store"} versionCode ${code}.`);
  }
  const version = `${match[1]}.${Number(match[2])}.${Number(match[3])}`;
  const versionCode = actualAudience === "wear" ? code - 50 : code;
  return {
    gatewayVersion: version,
    revision: 0,
    buildNumber: suffix % 50,
    version,
    versionCode,
    wearVersionCode: versionCode + 50,
    sourceRef: `${ANDROID_RELEASE_REF_PREFIX}/${version}-${versionCode}`,
    legacy: true,
  };
}

function storeHistory(snapshot: AndroidPlaySnapshot, refs: AndroidReleaseRef[]) {
  const markers = refs.filter(({ ref }) =>
    ref.startsWith(`${ANDROID_RELEASE_REF_PREFIX}/cutover-v2/`),
  );
  if (markers.length > 1) {
    throw new Error(
      "Multiple Android store version cutover markers exist; reconcile them before releasing.",
    );
  }
  const marker = markers[0];
  const legacyMax = marker ? LegacyMax.parse(Number(marker.ref.split("/").at(-1))) : null;
  if (marker && marker.ref !== androidStoreCutoverRef(legacyMax!)) {
    throw new Error(`Invalid Android cutover marker ${marker.ref}.`);
  }
  const records = new Map<number, ReleaseRecord>();
  const candidates = new Map<string, string>();
  for (const { ref, sha } of refs) {
    Sha.parse(sha);
    if (ref.startsWith(`${ANDROID_RELEASE_REF_PREFIX}/cutover-v2/`)) {
      continue;
    }
    let record: ReleaseRecord;
    if (ref.startsWith(`${ANDROID_RELEASE_REF_PREFIX}/v2/`)) {
      const identity = parseAndroidStoreReleaseRef(ref);
      if (legacyMax === null || identity.versionCode <= legacyMax) {
        throw new Error(`Android store ref ${ref} has no matching legacy cutover boundary.`);
      }
      record = { ...identity, sourceRef: ref, legacy: false };
      const key = `${record.gatewayVersion}/${record.revision}/${record.buildNumber}`;
      if (candidates.has(key) && candidates.get(key) !== ref) {
        throw new Error(`Multiple Android store records identify candidate ${key}.`);
      }
      candidates.set(key, ref);
    } else {
      const match = /^refs\/openclaw\/mobile-releases\/android\/([^/]+)-([1-9]\d*)$/u.exec(ref);
      if (!match) {
        throw new Error(`Unknown Android release ref ${ref}.`);
      }
      record = legacyRelease(Code.parse(Number(match[2])), "phone");
      if (record.sourceRef !== ref) {
        throw new Error(`Invalid legacy Android release ref ${ref}.`);
      }
    }
    for (const code of [record.versionCode, record.wearVersionCode]) {
      if (records.has(code)) {
        throw new Error(`Multiple Android source records claim versionCode ${code}.`);
      }
      records.set(code, record);
    }
  }
  const liveCodes = new Set(snapshot.uploadedVersionCodes);
  for (const track of snapshot.tracks) {
    for (const release of track.releases) {
      for (const raw of release.versionCodes) {
        if (!/^[1-9]\d*$/u.test(raw)) {
          throw new Error(`Invalid Google Play versionCode ${raw}.`);
        }
        liveCodes.add(Code.parse(Number(raw)));
      }
    }
  }
  for (const code of liveCodes) {
    if (records.has(code)) {
      continue;
    }
    if (legacyMax !== null && code > legacyMax) {
      throw new Error(
        `Google Play versionCode ${code} has no v2 source record. Inspect the retained Android plan and uploaded AAB hashes, then perform authorized record-only recovery; do not re-upload.`,
      );
    }
  }
  return { records, liveCodes, legacyMaxVersionCode: legacyMax ?? Math.max(0, ...liveCodes) };
}

function publicBaselines(
  snapshot: AndroidPlaySnapshot,
  records: Map<number, ReleaseRecord>,
): AndroidStorePlan["releaseNotesBaselines"] {
  return (["phone", "wear"] as const).map((audience) => {
    const trackName = audience === "phone" ? "production" : "wear:production";
    const tracks = snapshot.tracks.filter(({ track }) => track === trackName);
    if (tracks.length > 1) {
      throw new Error(`Google Play returned multiple ${trackName} tracks.`);
    }
    const releases = tracks[0]?.releases ?? [];
    if (releases.some(({ status }) => !["draft", "completed"].includes(status))) {
      throw new Error(
        `Google Play ${trackName} has ambiguous public release state. Complete or resolve the rollout before releasing.`,
      );
    }
    const published = releases.filter(({ status }) => status === "completed");
    if (published.length === 0) {
      return { audience, version: null, build: null };
    }
    const codes = [...new Set(published.flatMap(({ versionCodes }) => versionCodes))];
    if (published.length !== 1 || codes.length !== 1) {
      throw new Error(
        `Google Play ${trackName} has multiple public builds; release-note baseline is ambiguous.`,
      );
    }
    const build = codes[0]!;
    const record = records.get(Number(build));
    if (!record) {
      throw new Error(
        `Google Play ${trackName} versionCode ${build} has no recorded source identity. Verify that build's version and source before releasing.`,
      );
    }
    const expected = audience === "phone" ? record.versionCode : record.wearVersionCode;
    if (Number(build) !== expected) {
      throw new Error(
        `Google Play ${trackName} versionCode ${build} belongs to a different form factor.`,
      );
    }
    return { audience, version: record.version, build, sourceRef: record.sourceRef };
  });
}

export function resolveAndroidPublicBaselines(snapshotValue: unknown, refs: AndroidReleaseRef[]) {
  const snapshot = Snapshot.parse(snapshotValue);
  return publicBaselines(snapshot, storeHistory(snapshot, refs).records);
}

export function resolveAndroidStorePlan(input: {
  gatewayVersion: string;
  pinnedVersion: string;
  pinnedVersionCode: number;
  sourceSha: string;
  snapshot: unknown;
  refs: AndroidReleaseRef[];
}): AndroidStorePlan {
  const parsed = parseReleaseVersion(input.gatewayVersion.trim().replace(/^v/u, ""));
  if (!parsed) {
    throw new Error(`Invalid Gateway release version ${input.gatewayVersion}.`);
  }
  const gatewayVersion = parsed.baseVersion;
  encodeMobileStoreVersion(gatewayVersion, 0);
  const snapshot = Snapshot.parse(input.snapshot);
  const history = storeHistory(snapshot, input.refs);
  const releaseNotesBaselines = publicBaselines(snapshot, history.records);
  const records = [...new Set(history.records.values())];
  for (const version of [input.pinnedVersion, ...records.map((record) => record.gatewayVersion)]) {
    if (
      compareReleaseVersions(gatewayVersion, version) === null ||
      compareReleaseVersions(gatewayVersion, version)! < 0
    ) {
      throw new Error(
        `Gateway version ${gatewayVersion} precedes or cannot compare with Android release ${version}.`,
      );
    }
  }
  const sameGateway = records.filter((record) => record.gatewayVersion === gatewayVersion);
  const highestRevision = Math.max(0, ...sameGateway.map((record) => record.revision));
  const highestIsPublic = releaseNotesBaselines.some(({ build }) => {
    const record = build ? history.records.get(Number(build)) : undefined;
    return record?.gatewayVersion === gatewayVersion && record.revision === highestRevision;
  });
  const revision = highestRevision + (highestIsPublic ? 1 : 0);
  if (revision > MAX_MOBILE_STORE_REVISION) {
    throw new Error(
      `Android public revisions for ${gatewayVersion} are exhausted. Advance the Gateway patch before releasing.`,
    );
  }
  const buildNumber =
    Math.max(
      0,
      ...sameGateway
        .filter((record) => !record.legacy && record.revision === revision)
        .map((record) => record.buildNumber),
    ) + 1;
  const highWater = Math.max(
    history.legacyMaxVersionCode,
    Code.parse(input.pinnedVersionCode) + 50,
    ...history.liveCodes,
    ...history.records.keys(),
  );
  if (highWater > ANDROID_VERSION_CODE_MAX - 2) {
    throw new Error(
      "Android versionCode space is exhausted; there is no room for another phone/Wear pair.",
    );
  }
  return validateAndroidStorePlan({
    schemaVersion: 2,
    gatewayVersion,
    revision,
    buildNumber,
    version: encodeMobileStoreVersion(gatewayVersion, revision),
    versionCode: highWater + 1,
    wearVersionCode: highWater + 2,
    legacyMaxVersionCode: history.legacyMaxVersionCode,
    sourceSha: input.sourceSha,
    releaseNotesBaselines,
  });
}

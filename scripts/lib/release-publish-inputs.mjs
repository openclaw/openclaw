import {
  selectPluginSdkApiReleaseEvidence,
  validatePluginSdkApiReleaseEvidence,
} from "../plugin-sdk-api-release-evidence.mjs";
import corePackages from "./npm-core-release-packages.json" with { type: "json" };
import {
  fetchNpmRegistryPackumentWithRetry,
  resolveNpmPublishPlan,
  resolveNpmVersionPublicationDecision,
} from "./npm-publish-plan.mjs";
import { isRecord } from "./record-shared.mjs";

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(`Invalid sealed publication inputs: ${message}`);
  }
}

function selectedPackages(manifest) {
  const source = manifest.sourceAdmission;
  requireValue(source?.validationPurpose === "publish", "publish source required");
  requireValue(Array.isArray(source.projection?.packages), "package projection required");
  return source.projection.packages.filter((pkg) => pkg.targets.includes("npm"));
}

function waiver(value) {
  requireValue(typeof value === "string" && value.length <= 4096, "stable soak waiver");
  return value.trim() ? value : "";
}

/** Reads authenticated manifest facts; explicit nonempty operator inputs take precedence. */
export function resolveReleasePublishInputs(manifest, overrides = {}) {
  const overrideAcknowledgement = (overrides.pluginSdkApiAcknowledgement ?? "").trim();
  requireValue(
    overrideAcknowledgement === "" || /^[a-f0-9]{8}$/u.test(overrideAcknowledgement),
    "SDK override",
  );
  const overrideWaiver = waiver(overrides.stableSoakWaiver ?? "");
  const sealed = manifest?.publishInputs;
  if (sealed === undefined) {
    return {
      pluginSdkApiAcknowledgement: overrideAcknowledgement,
      stableSoakWaiver: overrideWaiver,
      npmDecisions: undefined,
    };
  }
  requireValue(isRecord(sealed) && sealed.version === 1, "version");
  requireValue(
    /^[a-f0-9]{40}$/u.test(sealed.targetSha) &&
      sealed.targetSha === manifest.targetSha &&
      (!overrides.targetSha || sealed.targetSha === overrides.targetSha),
    "target SHA mismatch",
  );
  requireValue(
    sealed.npmDistTag === manifest.sourceAdmission?.publicationSelection?.npmDistTag &&
      ["alpha", "beta", "latest", "extended-stable"].includes(sealed.npmDistTag) &&
      (!overrides.npmDistTag || sealed.npmDistTag === overrides.npmDistTag),
    "npm dist-tag mismatch",
  );
  requireValue(
    /^[a-f0-9]{64}$/u.test(sealed.pluginSdkApiEvidenceDigest) &&
      (sealed.pluginSdkApiAcknowledgement === "" ||
        sealed.pluginSdkApiAcknowledgement === sealed.pluginSdkApiEvidenceDigest.slice(0, 8)),
    "SDK acknowledgement digest mismatch",
  );
  waiver(sealed.stableSoakWaiver);
  const packages = selectedPackages(manifest);
  requireValue(
    Array.isArray(sealed.npmDecisions) &&
      sealed.npmDecisions.length === packages.length &&
      new Set(sealed.npmDecisions.map((row) => row.packageName)).size === packages.length,
    "npm package roster",
  );
  for (const row of sealed.npmDecisions) {
    requireValue(
      packages.some((pkg) => pkg.name === row.packageName && pkg.version === row.packageVersion),
      "npm package identity",
    );
    requireValue(
      isRecord(row.plan) &&
        ["alpha", "beta", "stable"].includes(row.plan.channel) &&
        ["alpha", "beta", "latest", "extended-stable"].includes(row.plan.publishTag) &&
        Array.isArray(row.plan.mirrorDistTags) &&
        row.plan.mirrorDistTags.every((tag) => ["alpha", "beta", "latest"].includes(tag)) &&
        ["already-published", "superseded", "plan"].includes(row.decision) &&
        [null, "npm-readback", "npm-mirror", "npm-tag-repair"].includes(row.route) &&
        typeof row.bootstrap === "boolean" &&
        (row.decision === "plan") === (row.route === null) &&
        (row.decision === "superseded"
          ? typeof row.supersededBy === "string" && row.supersededBy.length > 0
          : row.supersededBy === null) &&
        (!row.bootstrap || row.decision === "plan"),
      `npm decision for ${row.packageName}`,
    );
  }
  const acknowledgement = overrideAcknowledgement || sealed.pluginSdkApiAcknowledgement;
  requireValue(acknowledgement === "" || /^[a-f0-9]{8}$/u.test(acknowledgement), "SDK override");
  const sealedWaiver = waiver(sealed.stableSoakWaiver);
  // A sealed waiver stays authoritative only while the repository variable
  // still holds the same text; clearing it before publication revokes it.
  const current = overrides.currentStableSoakWaiver;
  const defaultWaiver =
    current === undefined || waiver(current) === sealedWaiver ? sealedWaiver : "";
  return {
    ...sealed,
    pluginSdkApiAcknowledgement: acknowledgement,
    stableSoakWaiver: overrideWaiver || defaultWaiver,
  };
}

/** Seal fresh registry planning facts without granting publication authority. */
export async function createReleasePublishInputs({ manifest, npmManifest, stableSoakWaiver = "" }) {
  const packages = selectedPackages(manifest);
  const npmDistTag = manifest.sourceAdmission.publicationSelection.npmDistTag;
  requireValue(npmManifest.releaseSha === manifest.targetSha, "npm artifact target mismatch");
  const selected = selectPluginSdkApiReleaseEvidence({
    evidence: npmManifest.pluginSdkApi,
    npmDistTag,
  });
  const sdk = validatePluginSdkApiReleaseEvidence({
    evidence: npmManifest.pluginSdkApi,
    acknowledgement: selected?.digest?.slice(0, 8),
    expectedHeadSha: manifest.targetSha,
    expectedWorkflowSha: manifest.publicationArtifacts.npmPreflight.producer.workflowSha,
    npmDistTag,
  });
  const npmDecisions = [];
  // Bound concurrent registry requests independently of the selected plugin count.
  for (let offset = 0; offset < packages.length; offset += 8) {
    npmDecisions.push(
      ...(await Promise.all(
        packages.slice(offset, offset + 8).map(async (pkg) => {
          const registry = await fetchNpmRegistryPackumentWithRetry({
            packageName: pkg.name,
            packageUrl: `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
            maxBytes: 16 * 1024 * 1024,
            timeoutMs: 15_000,
            attempts: 2,
            redirect: "manual",
          });
          const bootstrap = registry.status === 404;
          const core =
            pkg.name === "openclaw" || corePackages.some((entry) => entry.name === pkg.name);
          requireValue(!bootstrap || !core, `${pkg.name}: core package missing from npm`);
          const packument = registry.packument;
          requireValue(
            bootstrap ||
              (registry.ok &&
                isRecord(packument) &&
                isRecord(packument.versions) &&
                Object.keys(packument.versions).length > 0 &&
                isRecord(packument["dist-tags"])),
            `${pkg.name}: registry response`,
          );
          const tags = bootstrap ? {} : packument["dist-tags"];
          const published = !bootstrap && Object.hasOwn(packument.versions, pkg.version);
          const plan = resolveNpmPublishPlan(
            pkg.version,
            tags.beta,
            npmDistTag === "extended-stable" ? npmDistTag : undefined,
          );
          if (core && npmDistTag === "beta") {
            plan.publishTag = "beta";
            plan.mirrorDistTags = [];
          }
          const { route, supersededBy } = resolveNpmVersionPublicationDecision({
            packageVersion: pkg.version,
            publishPlan: plan,
            distTags: tags,
            published,
          });
          return {
            packageName: pkg.name,
            packageVersion: pkg.version,
            plan,
            decision: supersededBy ? "superseded" : published ? "already-published" : "plan",
            route,
            supersededBy,
            bootstrap,
          };
        }),
      )),
    );
  }
  return resolveReleasePublishInputs({
    ...manifest,
    publishInputs: {
      version: 1,
      targetSha: manifest.targetSha,
      npmDistTag,
      // The sealed digest is evidence only. SDK API changes still need an
      // operator-supplied acknowledgement at publication.
      pluginSdkApiAcknowledgement: "",
      pluginSdkApiEvidenceDigest: sdk.digest,
      stableSoakWaiver,
      npmDecisions,
    },
  });
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";
import { sleep } from "./lib/sleep.mjs";

const ARCHITECTURES = Object.freeze(["amd64", "arm64"]);
const VARIANTS = Object.freeze([
  { aliasKey: "default", suffix: "" },
  { aliasKey: "slim", suffix: "-slim" },
  { aliasKey: "browser", suffix: "-browser" },
]);
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
]);
const IMAGE_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const READ_TIMEOUT_MS = 20_000;
const BODY_MAX_BYTES = 8 * 1024 * 1024;
const RETRY_DELAYS_MS = Object.freeze([1_000, 3_000, 10_000, 30_000]);

function requireImage(value, label) {
  const image = value?.trim();
  if (!image || /\s|@/u.test(image) || /:[^/]+$/u.test(image)) {
    throw new Error(label + " must be an untagged container image name.");
  }
  const slash = image.indexOf("/");
  if (slash <= 0 || !image.slice(0, slash).includes(".")) {
    throw new Error(label + " must include its registry host.");
  }
  return image;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(label + " returned invalid JSON.", { cause: error });
  }
}

function requireDigest(value, label) {
  const digest = String(value ?? "").trim();
  if (!DIGEST.test(digest)) {
    throw new Error(label + " did not return a valid sha256 digest.");
  }
  return digest;
}

function runImagetools(args, execFileSyncImpl) {
  return String(
    execFileSyncImpl("docker", ["buildx", "imagetools", ...args], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: BODY_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: READ_TIMEOUT_MS,
    }),
  );
}

function inspectContainerManifest(ref, execFileSyncImpl) {
  const descriptor = parseJson(
    runImagetools(["inspect", ref, "--format", "{{json .Manifest}}"], execFileSyncImpl),
    ref + " manifest descriptor",
  );
  const manifest = parseJson(
    runImagetools(["inspect", ref, "--raw"], execFileSyncImpl),
    ref + " manifest",
  );
  return { digest: requireDigest(descriptor.digest, ref), manifest, ref };
}

export async function readContainerManifest(ref, options = {}) {
  const separator = ref.lastIndexOf(":");
  if (separator <= ref.indexOf("/")) {
    throw new Error("Container ref must include a tag: " + ref);
  }
  requireImage(ref.slice(0, separator), "Container image");
  const tag = ref.slice(separator + 1);
  if (!tag || tag.includes("/")) {
    throw new Error("Container ref has an invalid tag: " + ref);
  }
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const delay = options.delay ?? sleep;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return inspectContainerManifest(ref, execFileSyncImpl);
    } catch (error) {
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new Error(ref + ": registry read failed. Retry readback, not publication.", {
          cause: error,
        });
      }
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(ref + ": registry read exhausted its retry budget.");
}

function selectedVariants(includeBrowser) {
  if (typeof includeBrowser !== "boolean") {
    throw new Error("includeBrowser must be a boolean.");
  }
  return includeBrowser ? VARIANTS : VARIANTS.filter(({ aliasKey }) => aliasKey !== "browser");
}

export function createContainerRegistryReadbackPlan({
  version,
  includeBrowser,
  dockerImages,
  vercelImage,
}) {
  const policy = resolveDockerReleasePolicy(version);
  const images = dockerImages.map((image, index) =>
    requireImage(image, "Docker image " + (index + 1)),
  );
  if (images.length === 0) {
    throw new Error("At least one Docker image is required.");
  }
  const variants = selectedVariants(includeBrowser);
  const registries = images.map((image) => ({ image, kind: "docker", variants }));
  if (vercelImage) {
    registries.push({
      image: requireImage(vercelImage, "Vercel image"),
      kind: "vercel",
      variants,
    });
  }
  return { policy, registries };
}

function normalizedJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizedJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, normalizedJsonValue(value[key])]),
  );
}

function normalizedDescriptor(descriptor, ref) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new Error(ref + " contains an invalid descriptor.");
  }
  return {
    digest: requireDigest(descriptor.digest, ref),
    mediaType: descriptor.mediaType,
    size: descriptor.size,
    platform: normalizedJsonValue(descriptor.platform),
  };
}

function descriptorKey(descriptor) {
  return JSON.stringify(descriptor);
}

function inspectIndex(record, kind) {
  const { manifest, ref } = record;
  if (!INDEX_MEDIA_TYPES.has(manifest?.mediaType) || !Array.isArray(manifest.manifests)) {
    throw new Error(ref + " must resolve to an image index.");
  }
  const descriptors = manifest.manifests.map((descriptor) => normalizedDescriptor(descriptor, ref));
  const platforms = {};
  for (const architecture of ARCHITECTURES) {
    const matches = descriptors.filter(
      (descriptor) =>
        descriptor.platform?.os === "linux" &&
        descriptor.platform?.architecture === architecture &&
        IMAGE_MEDIA_TYPES.has(descriptor.mediaType),
    );
    if (matches.length !== 1) {
      throw new Error(
        ref + " must contain exactly one linux/" + architecture + " image descriptor.",
      );
    }
    platforms[architecture] = matches[0];
  }
  if (kind === "vercel" && descriptors.length !== ARCHITECTURES.length) {
    throw new Error(ref + " must contain only the two released platform descriptors.");
  }
  return {
    descriptors: descriptors.toSorted((left, right) =>
      descriptorKey(left).localeCompare(descriptorKey(right)),
    ),
    platforms,
  };
}

function assertSameDescriptors(actual, expected, ref) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(ref + " descriptor set differs from the expected immutable ref.");
  }
}

function inspectArchitecture(record, kind, architecture) {
  if (kind === "vercel") {
    if (!IMAGE_MEDIA_TYPES.has(record.manifest?.mediaType)) {
      throw new Error(record.ref + " must resolve to an image manifest.");
    }
    return { descriptors: null, platformDigest: record.digest };
  }
  const { manifest, ref } = record;
  if (!INDEX_MEDIA_TYPES.has(manifest?.mediaType) || !Array.isArray(manifest.manifests)) {
    throw new Error(ref + " must resolve to an image index.");
  }
  const descriptors = manifest.manifests.map((descriptor) => normalizedDescriptor(descriptor, ref));
  const images = descriptors.filter(
    (descriptor) =>
      descriptor.platform?.os === "linux" && IMAGE_MEDIA_TYPES.has(descriptor.mediaType),
  );
  if (images.length !== 1 || images[0].platform?.architecture !== architecture) {
    throw new Error(ref + " must contain only one linux/" + architecture + " image descriptor.");
  }
  return {
    descriptors: descriptors.toSorted((left, right) =>
      descriptorKey(left).localeCompare(descriptorKey(right)),
    ),
    platformDigest: images[0].digest,
  };
}

export async function verifyContainerRegistryReadback(params, options = {}) {
  const plan = createContainerRegistryReadbackPlan(params);
  const readManifest = options.readManifest ?? ((ref) => readContainerManifest(ref, options));
  const registryResults = [];
  for (const registry of plan.registries) {
    const variants = [];
    for (const { aliasKey, suffix } of registry.variants) {
      const versionRef = registry.image + ":" + plan.policy.version + suffix;
      const versionRecord = await readManifest(versionRef);
      const index = inspectIndex(versionRecord, registry.kind);
      const architectures = {};
      for (const architecture of ARCHITECTURES) {
        const architectureRef = versionRef + "-" + architecture;
        const architectureRecord = await readManifest(architectureRef);
        const inspected = inspectArchitecture(architectureRecord, registry.kind, architecture);
        if (inspected.platformDigest !== index.platforms[architecture].digest) {
          throw new Error(
            architectureRef +
              " contains " +
              inspected.platformDigest +
              ", expected " +
              index.platforms[architecture].digest +
              " for linux/" +
              architecture +
              ".",
          );
        }
        architectures[architecture] = {
          ...inspected,
          digest: architectureRecord.digest,
          ref: architectureRef,
        };
      }
      const aliases = [];
      for (const alias of plan.policy.movingAliases[aliasKey]) {
        const aliasRef = registry.image + ":" + alias;
        const aliasRecord = await readManifest(aliasRef);
        const aliasIndex = inspectIndex(aliasRecord, registry.kind);
        if (aliasRecord.digest !== versionRecord.digest) {
          throw new Error(
            aliasRef +
              " resolved to " +
              aliasRecord.digest +
              ", expected " +
              versionRecord.digest +
              ".",
          );
        }
        assertSameDescriptors(aliasIndex.descriptors, index.descriptors, aliasRef);
        aliases.push(aliasRef);
      }
      variants.push({
        aliasKey,
        architectures,
        index,
        versionDigest: versionRecord.digest,
        versionRef,
        aliases,
      });
    }
    registryResults.push({ ...registry, variants });
  }

  const docker = registryResults.filter(({ kind }) => kind === "docker");
  for (const expected of docker[0]?.variants ?? []) {
    for (const registry of docker.slice(1)) {
      const actual = registry.variants.find(({ aliasKey }) => aliasKey === expected.aliasKey);
      if (actual.versionDigest !== expected.versionDigest) {
        throw new Error(
          actual.versionRef +
            " resolved to " +
            actual.versionDigest +
            ", expected " +
            expected.versionDigest +
            ".",
        );
      }
      assertSameDescriptors(
        actual.index.descriptors,
        expected.index.descriptors,
        actual.versionRef,
      );
      for (const architecture of ARCHITECTURES) {
        const actualArchitecture = actual.architectures[architecture];
        const expectedArchitecture = expected.architectures[architecture];
        if (actualArchitecture.digest !== expectedArchitecture.digest) {
          throw new Error(
            actualArchitecture.ref +
              " resolved to " +
              actualArchitecture.digest +
              ", expected " +
              expectedArchitecture.digest +
              ".",
          );
        }
        assertSameDescriptors(
          actualArchitecture.descriptors,
          expectedArchitecture.descriptors,
          actualArchitecture.ref,
        );
      }
    }
  }
  const vercel = registryResults.find(({ kind }) => kind === "vercel");
  if (vercel && docker[0]) {
    for (const actual of vercel.variants) {
      const expected = docker[0].variants.find(({ aliasKey }) => aliasKey === actual.aliasKey);
      const expectedPlatforms = ARCHITECTURES.map(
        (architecture) => expected.index.platforms[architecture],
      ).toSorted((left, right) => descriptorKey(left).localeCompare(descriptorKey(right)));
      assertSameDescriptors(actual.index.descriptors, expectedPlatforms, actual.versionRef);
    }
  }
  return {
    channel: plan.policy.channel,
    registryCount: registryResults.length,
    refCount: registryResults.reduce(
      (count, registry) =>
        count + registry.variants.reduce((sum, variant) => sum + 3 + variant.aliases.length, 0),
      0,
    ),
  };
}

function printHelp() {
  console.log(
    "Usage: node scripts/container-registry-readback.mjs --version YYYY.M.P --docker-image REGISTRY/IMAGE [--docker-image REGISTRY/IMAGE] --vercel-image REGISTRY/IMAGE [--include-browser]",
  );
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "docker-image": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      "include-browser": { type: "boolean" },
      "vercel-image": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }
  if (!values.version || !values["vercel-image"]) {
    throw new Error("--version and --vercel-image are required.");
  }
  const result = await verifyContainerRegistryReadback({
    version: values.version,
    includeBrowser: values["include-browser"] ?? false,
    dockerImages: values["docker-image"] ?? [],
    vercelImage: values["vercel-image"],
  });
  console.log(
    "Verified " +
      result.refCount +
      " " +
      result.channel +
      " container refs across " +
      result.registryCount +
      " registries.",
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("container-registry-readback: " + message);
      process.exitCode = 1;
    },
  );
}

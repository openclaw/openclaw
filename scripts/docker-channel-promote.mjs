#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";

const DOCKER_TIMEOUT_MS = 120_000;
const VARIANTS = Object.freeze([
  { aliasKey: "default", suffix: "" },
  { aliasKey: "slim", suffix: "-slim" },
  { aliasKey: "browser", suffix: "-browser" },
]);

/** Build the immutable-source to moving-alias promotion plan. */
export function createDockerChannelPromotionPlan({ version, images }) {
  if (images.length === 0) {
    throw new Error("At least one --image is required.");
  }
  const policy = resolveDockerReleasePolicy(version);
  const promotions = [];
  for (const image of images) {
    for (const { aliasKey, suffix } of VARIANTS) {
      const aliases = policy.movingAliases[aliasKey];
      if (aliases.length === 0) {
        continue;
      }
      promotions.push({
        image,
        sourceRef: `${image}:${version}${suffix}`,
        targetRefs: aliases.map((alias) => `${image}:${alias}`),
      });
    }
  }
  if (promotions.length === 0) {
    throw new Error(`Docker ${policy.channel} releases have no moving aliases to promote.`);
  }
  return { channel: policy.channel, promotions, version: policy.version };
}

function runDocker(args, execFileSyncImpl) {
  return execFileSyncImpl("docker", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DOCKER_TIMEOUT_MS,
  });
}

function inspectManifestDigest(imageRef, execFileSyncImpl) {
  const raw = runDocker(
    ["buildx", "imagetools", "inspect", imageRef, "--format", "{{json .Manifest}}"],
    execFileSyncImpl,
  );
  let digest;
  try {
    digest = JSON.parse(raw).digest;
  } catch (error) {
    throw new Error(`Could not parse the manifest for ${imageRef}.`, { cause: error });
  }
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`The manifest for ${imageRef} did not contain a valid sha256 digest.`);
  }
  return digest;
}

/** Promote every planned alias and verify the registry result. */
export function promoteDockerChannel({ version, images }, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const log = options.log ?? console.log;
  const plan = createDockerChannelPromotionPlan({ version, images });

  // Resolve every immutable source before the first alias write. A missing
  // release variant must not leave the channel partially promoted.
  const resolved = plan.promotions.map((promotion) => ({
    ...promotion,
    sourceDigest: inspectManifestDigest(promotion.sourceRef, execFileSyncImpl),
  }));

  for (const promotion of resolved) {
    const targetArgs = promotion.targetRefs.flatMap((targetRef) => ["--tag", targetRef]);
    runDocker(
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        ...targetArgs,
        `${promotion.image}@${promotion.sourceDigest}`,
      ],
      execFileSyncImpl,
    );
    for (const targetRef of promotion.targetRefs) {
      const targetDigest = inspectManifestDigest(targetRef, execFileSyncImpl);
      if (targetDigest !== promotion.sourceDigest) {
        throw new Error(
          `${targetRef} resolved to ${targetDigest}, expected ${promotion.sourceDigest}.`,
        );
      }
      log(`Verified ${targetRef} -> ${promotion.sourceDigest}.`);
    }
  }
  return plan;
}

function printHelp() {
  console.log(
    "Usage: node scripts/docker-channel-promote.mjs --version YYYY.M.P --image REGISTRY/IMAGE [--image REGISTRY/IMAGE]",
  );
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      image: { type: "string", multiple: true },
      version: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }
  const version = values.version?.trim();
  if (!version) {
    throw new Error("--version is required.");
  }
  const images = (values.image ?? []).map((image) => image.trim());
  if (images.length === 0 || images.some((image) => image.length === 0)) {
    throw new Error("At least one non-empty --image is required.");
  }
  const plan = promoteDockerChannel({ version, images });
  console.log(`Promoted Docker ${plan.channel} aliases for ${plan.version}.`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `docker-channel-promote: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

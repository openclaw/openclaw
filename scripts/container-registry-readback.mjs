#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
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
const ACCEPT = [...INDEX_MEDIA_TYPES, ...IMAGE_MEDIA_TYPES].join(", ");
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const READ_TIMEOUT_MS = 20_000;
const BODY_MAX_BYTES = 4 * 1024 * 1024;
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

function splitImage(image) {
  const slash = image.indexOf("/");
  const host = image.slice(0, slash).toLowerCase();
  return {
    host,
    requestHost: host === "docker.io" ? "registry-1.docker.io" : host,
    repository: image.slice(slash + 1),
  };
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

function readDockerConfig(env) {
  const configDir = env.DOCKER_CONFIG?.trim() || join(homedir(), ".docker");
  try {
    return parseJson(readFileSync(join(configDir, "config.json"), "utf8"), "Docker config");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function credentialServers(host) {
  return host === "docker.io"
    ? ["https://index.docker.io/v1/", "docker.io", "registry-1.docker.io"]
    : [host, "https://" + host];
}

function decodeInlineCredential(auth, server) {
  if (typeof auth !== "string" || auth.length === 0) {
    return null;
  }
  const decoded = Buffer.from(auth, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) {
    throw new Error("Docker credential for " + server + " is invalid.");
  }
  return { username: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function readCredentialHelper(helper, server, execFileSyncImpl) {
  const raw = execFileSyncImpl("docker-credential-" + helper, ["get"], {
    encoding: "utf8",
    input: server,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: READ_TIMEOUT_MS,
  });
  const credential = parseJson(raw, "docker-credential-" + helper);
  if (typeof credential.Username !== "string" || typeof credential.Secret !== "string") {
    throw new Error("docker-credential-" + helper + " returned an invalid credential.");
  }
  return { username: credential.Username, secret: credential.Secret };
}

function resolveDockerCredential(host, options) {
  const config = options.dockerConfig ?? readDockerConfig(options.env);
  for (const server of credentialServers(host)) {
    const inline = decodeInlineCredential(config.auths?.[server]?.auth, server);
    if (inline) {
      return inline;
    }
    const helper = config.credHelpers?.[server] ?? config.credsStore;
    if (typeof helper === "string" && helper.length > 0) {
      try {
        return readCredentialHelper(helper, server, options.execFileSyncImpl);
      } catch (error) {
        if (config.credHelpers?.[server]) {
          throw error;
        }
      }
    }
  }
  return null;
}

function parseBearerChallenge(value) {
  if (!value?.startsWith("Bearer ")) {
    return null;
  }
  const parameters = {};
  for (const match of value.slice("Bearer ".length).matchAll(/([a-z]+)="([^"]*)"/giu)) {
    parameters[match[1].toLowerCase()] = match[2];
  }
  return parameters.realm ? parameters : null;
}

function basicAuthorization(credential) {
  return "Basic " + Buffer.from(credential.username + ":" + credential.secret).toString("base64");
}

async function cancelResponse(response) {
  await response.body?.cancel().catch(() => undefined);
}

function retryableStatus(status) {
  return status === 404 || status === 429 || [500, 502, 503, 504].includes(status);
}

async function fetchWithRetry(url, init, options) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await options.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!retryableStatus(response.status) || attempt === RETRY_DELAYS_MS.length) {
        return response;
      }
      await cancelResponse(response);
    } catch (error) {
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new Error(url + ": registry read failed. Retry readback, not publication.", {
          cause: error,
        });
      }
    }
    await options.delay(RETRY_DELAYS_MS[attempt]);
  }
  throw new Error(url + ": registry read exhausted its retry budget.");
}

async function readResponseJson(response, label) {
  return parseJson(await readBoundedResponseText(response, label, BODY_MAX_BYTES), label);
}

function authorizedTokenRealm(challenge, host) {
  const url = new URL(challenge.realm);
  const registryOrigin = new URL("https://" + host).origin;
  const allowedOrigins =
    host === "docker.io"
      ? new Set([registryOrigin, "https://auth.docker.io"])
      : new Set([registryOrigin]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedOrigins.has(url.origin)
  ) {
    throw new Error(host + ": registry token realm is not an authorized HTTPS origin.");
  }
  return url;
}

async function resolveRegistryToken(challenge, host, repository, options) {
  const url = authorizedTokenRealm(challenge, host);
  url.searchParams.set("service", challenge.service ?? host);
  url.searchParams.set("scope", challenge.scope ?? "repository:" + repository + ":pull");
  const credential = resolveDockerCredential(host, options);
  const headers = { accept: "application/json" };
  if (credential) {
    headers.authorization = basicAuthorization(credential);
  }
  const response = await fetchWithRetry(url, { headers, redirect: "error" }, options);
  if (!response.ok) {
    await cancelResponse(response);
    throw new Error(url.origin + ": registry token request returned HTTP " + response.status + ".");
  }
  const token = await readResponseJson(response, url.origin + " registry token");
  const value = token.token ?? token.access_token;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(url.origin + ": registry token response did not include a token.");
  }
  return value;
}

export async function readContainerManifest(ref, options = {}) {
  const separator = ref.lastIndexOf(":");
  if (separator <= ref.indexOf("/")) {
    throw new Error("Container ref must include a tag: " + ref);
  }
  const image = requireImage(ref.slice(0, separator), "Container image");
  const tag = ref.slice(separator + 1);
  if (!tag || tag.includes("/")) {
    throw new Error("Container ref has an invalid tag: " + ref);
  }
  const { host, requestHost, repository } = splitImage(image);
  const requestOptions = {
    delay: options.delay ?? sleep,
    dockerConfig: options.dockerConfig,
    env: options.env ?? process.env,
    execFileSyncImpl: options.execFileSyncImpl ?? execFileSync,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
  };
  const url =
    "https://" + requestHost + "/v2/" + repository + "/manifests/" + encodeURIComponent(tag);
  const read = (authorization) =>
    fetchWithRetry(
      url,
      {
        headers: { accept: ACCEPT, ...(authorization ? { authorization } : {}) },
        redirect: "error",
      },
      requestOptions,
    );
  let response = await read();
  if (response.status === 401) {
    const authentication = response.headers.get("www-authenticate");
    const challenge = parseBearerChallenge(authentication);
    await cancelResponse(response);
    if (challenge) {
      const token = await resolveRegistryToken(challenge, host, repository, requestOptions);
      response = await read("Bearer " + token);
    } else if (authentication?.startsWith("Basic ")) {
      const credential = resolveDockerCredential(host, requestOptions);
      if (!credential) {
        throw new Error(ref + ": registry read requires a Docker credential.");
      }
      response = await read(basicAuthorization(credential));
    } else {
      throw new Error(ref + ": registry authentication challenge is unsupported.");
    }
  }
  if (!response.ok) {
    await cancelResponse(response);
    throw new Error(ref + ": registry manifest returned HTTP " + response.status + ".");
  }
  const digest = requireDigest(response.headers.get("docker-content-digest"), ref);
  const manifest = await readResponseJson(response, ref);
  return { digest, manifest, ref };
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

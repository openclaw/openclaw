import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";

const outputNames = new Map([
  ["openclaw", "openclaw_publication"],
  ["@openclaw/gateway-protocol", "gateway_protocol_publication"],
]);
const payloadKeys = [
  "schema_version",
  "package_name",
  "package_version",
  "package_integrity",
  "source_repository",
  "source_commit",
];

function validatePublication(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== payloadKeys.length ||
    !payloadKeys.every((key) => Object.hasOwn(value, key)) ||
    value.schema_version !== 1 ||
    typeof value.package_name !== "string" ||
    !outputNames.has(value.package_name) ||
    typeof value.package_version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u.test(value.package_version) ||
    typeof value.package_integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value.package_integrity) ||
    value.source_repository !== "openclaw/openclaw" ||
    typeof value.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source_commit)
  ) {
    throw new Error("Invalid gateway publication payload; require the exact v1 package identity.");
  }
  const digest = value.package_integrity.slice("sha512-".length);
  if (Buffer.from(digest, "base64").toString("base64") !== digest) {
    throw new Error("Gateway publication integrity must be canonical SHA512 SRI.");
  }
  return value;
}

export async function recordPublication(packageName, tarball, sourceCommit, outputPath) {
  if (!outputNames.has(packageName) || !outputPath) {
    throw new Error(
      "Recording a gateway publication requires an allowed package and GITHUB_OUTPUT.",
    );
  }
  const metadata = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  if (!isRecord(metadata) || metadata.name !== packageName) {
    throw new Error("Published tarball package name differs from the publication request.");
  }
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(tarball)) {
    hash.update(chunk);
  }
  const publication = validatePublication({
    schema_version: 1,
    package_name: metadata.name,
    package_version: metadata.version,
    package_integrity: `sha512-${hash.digest("base64")}`,
    source_repository: "openclaw/openclaw",
    source_commit: sourceCommit,
  });
  appendFileSync(outputPath, `${outputNames.get(packageName)}=${JSON.stringify(publication)}\n`);
}

async function dispatchPublication(publication, token) {
  const spec = `${publication.package_name}@${publication.package_version}`;
  let registry;
  try {
    registry = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(publication.package_name)}/${encodeURIComponent(publication.package_version)}`,
      { redirect: "error", signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    throw new Error(`Exact registry readback failed for ${spec}; no notification sent.`);
  }
  if (!registry.ok) {
    throw new Error(`Exact registry readback returned HTTP ${registry.status} for ${spec}.`);
  }
  let metadata;
  try {
    metadata = await registry.json();
  } catch {
    throw new Error(`Exact registry readback returned invalid JSON for ${spec}.`);
  }
  if (
    metadata?.name !== publication.package_name ||
    metadata?.version !== publication.package_version ||
    metadata?.dist?.integrity !== publication.package_integrity
  ) {
    throw new Error(`Exact registry identity or tarball integrity differs for ${spec}.`);
  }
  let response;
  try {
    response = await fetch(
      "https://api.github.com/repos/openclaw/openclaw-windows-node/dispatches",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          event_type: "gateway-protocol-published",
          client_payload: publication,
        }),
      },
    );
  } catch {
    throw new Error(
      `Dispatch outcome is unconfirmed for ${spec}; inspect Windows runs before recovery.`,
    );
  }
  if (response.status !== 204) {
    throw new Error(
      `Dispatch returned HTTP ${response.status} for ${spec}; inspect Windows runs before recovery.`,
    );
  }
}

export async function notifyPublications(publications, token, summaryPath) {
  if (
    !Array.isArray(publications) ||
    publications.length < 1 ||
    publications.length > outputNames.size
  ) {
    throw new Error("Expected one or two recorded gateway publications.");
  }
  publications.forEach(validatePublication);
  if (new Set(publications.map((value) => value.package_name)).size !== publications.length) {
    throw new Error("Duplicate gateway publication package.");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Missing gateway publication GitHub App token; no notification sent.");
  }
  const failures = [];
  for (const publication of publications) {
    const spec = `${publication.package_name}@${publication.package_version}`;
    let outcome;
    try {
      await dispatchPublication(publication, token);
      outcome = "accepted by GitHub; downstream validation is not awaited";
    } catch (error) {
      outcome = error.message;
      failures.push(outcome);
    }
    console.log(`${spec}: ${outcome}`);
    if (summaryPath) {
      try {
        appendFileSync(
          summaryPath,
          `- ${spec}, source ${publication.source_commit}, integrity ${publication.package_integrity}: ${outcome}\n`,
        );
      } catch {
        const failure = `Could not write the gateway publication summary for ${spec}; inspect the notification step log.`;
        console.error(failure);
        failures.push(failure);
      }
    }
  }
  if (failures.length) {
    throw new Error(
      `${failures.join("\n")}\nPublished npm versions remain unchanged; nightly reconciliation remains active.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "record" && args.length === 3) {
      await recordPublication(args[0], args[1], args[2], process.env.GITHUB_OUTPUT);
    } else if (command === "notify" && args.length === 0) {
      const publications = [
        process.env.OPENCLAW_PUBLICATION,
        process.env.GATEWAY_PROTOCOL_PUBLICATION,
      ]
        .filter(Boolean)
        .map((value) => JSON.parse(value));
      await notifyPublications(
        publications,
        process.env.GATEWAY_PUBLICATION_TOKEN,
        process.env.GITHUB_STEP_SUMMARY,
      );
    } else {
      throw new Error(
        "Usage: gateway-publication-notify.mjs record <package> <tarball> <source-sha> | notify",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

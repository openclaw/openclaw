#!/usr/bin/env node
// Freeze one published stable repository release for both native client builds.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parseReleaseVersion } from "./lib/release-version.mjs";

const API = "https://api.github.com/repos/openclaw/openclaw";
const SHA = /^[a-f0-9]{40}$/u;

export function validateStableReleaseSource(value, targetSha, dispatchId) {
  const version =
    typeof value?.tag === "string" && value.tag.startsWith("v")
      ? parseReleaseVersion(value.tag.slice(1))
      : null;
  if (
    !SHA.test(targetSha) ||
    typeof dispatchId !== "string" ||
    !dispatchId ||
    dispatchId.length > 128 ||
    /[\r\n]/u.test(dispatchId) ||
    value?.schema !== 1 ||
    value.targetSha !== targetSha ||
    value.dispatchId !== dispatchId ||
    !version ||
    value.tag !== `v${version.version}` ||
    version.channel !== "stable" ||
    version.patch >= 33 ||
    !SHA.test(value.sourceSha)
  ) {
    throw new Error("Invalid stable-release-source selection or candidate binding");
  }
  return value;
}

export async function selectStableReleaseSource({ targetSha, dispatchId, request }) {
  const release = await request(`${API}/releases/latest`);
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error("Client source requires a published stable repository release");
  }
  // Validate the tag before it becomes an API path. Do not use target_commitish:
  // GitHub commonly stores a moving branch name there, not the released commit.
  validateStableReleaseSource(
    { schema: 1, targetSha, dispatchId, tag: release.tag_name, sourceSha: "0".repeat(40) },
    targetSha,
    dispatchId,
  );
  let { object } = await request(`${API}/git/ref/tags/${release.tag_name}`);
  if (object?.type === "tag" && SHA.test(object.sha)) {
    ({ object } = await request(`${API}/git/tags/${object.sha}`));
  }
  if (object?.type !== "commit") {
    throw new Error("Stable release tag must resolve to a commit");
  }
  return validateStableReleaseSource(
    { schema: 1, targetSha, dispatchId, tag: release.tag_name, sourceSha: object.sha },
    targetSha,
    dispatchId,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      restore: { type: "boolean", default: false },
    },
  });
  if (!values.output) {
    throw new Error("--output is required");
  }
  const targetSha = process.env.TARGET_SHA;
  const dispatchId = process.env.DISPATCH_ID;
  const selection = values.restore
    ? validateStableReleaseSource(
        JSON.parse(await readFile(values.output, "utf8")),
        targetSha,
        dispatchId,
      )
    : await selectStableReleaseSource({
        targetSha,
        dispatchId,
        request: async (url) => {
          const token = process.env.GH_TOKEN;
          const response = await fetch(url, {
            headers: {
              Accept: "application/vnd.github+json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new Error(`Stable release lookup failed (HTTP ${response.status})`);
          }
          return response.json();
        },
      });
  if (!values.restore) {
    await writeFile(values.output, JSON.stringify(selection, null, 2) + "\n");
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `tag=${selection.tag}\nsha=${selection.sourceSha}\n`,
    );
  }
  process.stdout.write(JSON.stringify(selection) + "\n");
}

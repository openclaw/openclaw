// Same-run locale transport only. Never read another run or write a shared cache.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CONTROL_UI_LOCALE_ENTRIES } from "./lib/control-ui-i18n-config.ts";
import { loadControlUiPluginCatalogs } from "./lib/control-ui-plugin-i18n-catalog.ts";

const POLICY_PATHS = new Set([
  "scripts/control-ui-i18n.ts",
  "scripts/control-ui-locale-artifacts.ts",
  "scripts/lib/control-ui-i18n-catalog-values.ts",
  "scripts/lib/control-ui-i18n-sync-plan.ts",
  "scripts/lib/control-ui-i18n-config.ts",
  "scripts/lib/control-ui-i18n-config.json",
  "scripts/lib/control-ui-plugin-i18n-catalog.ts",
  ".github/workflows/control-ui-locale-refresh.yml",
]);
const identitySchema = z.object({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  runId: z.string().regex(/^[1-9][0-9]*$/u),
  runAttempt: z.string().regex(/^[1-9][0-9]*$/u),
});
const metadataSchema = z.object({
  locale: z.string(),
  fallbackKeys: z.array(z.string()).length(0),
  totalKeys: z.number().int().nonnegative(),
  translatedKeys: z.number().int().nonnegative(),
});
const artifactSchema = identitySchema.extend({
  version: z.literal(1),
  locale: z.string(),
  memories: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
      metadata: metadataSchema,
    }),
  ),
});
type Identity = z.infer<typeof identitySchema>;
type Artifact = z.infer<typeof artifactSchema>;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function catalogAssets(root: string): Promise<string[]> {
  return [
    "ui/src/i18n/.i18n",
    ...(await loadControlUiPluginCatalogs(root)).map(
      (plugin) => plugin.browserRoot + "/i18n/.i18n",
    ),
  ];
}

function validateArtifact(value: unknown, locale: string, identity: Identity): Artifact {
  const parsed = artifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid or fallback-containing locale artifact: " + locale);
  }
  const artifact = parsed.data;
  if (
    artifact.locale !== locale ||
    artifact.sourceCommit !== identity.sourceCommit ||
    artifact.runId !== identity.runId ||
    // A retried finalizer may consume completed workers from an earlier attempt
    // of this same run and exact source, never a future attempt or another run.
    Number(artifact.runAttempt) > Number(identity.runAttempt)
  ) {
    throw new Error(
      "Locale artifact does not belong to this source and workflow attempt: " + locale,
    );
  }
  const paths = new Set<string>();
  for (const memory of artifact.memories) {
    const parts = memory.path.split("/");
    const core = memory.path === "ui/src/i18n/.i18n/" + locale + ".tm.jsonl";
    const plugin =
      parts[0] === "extensions" &&
      parts.length >= 5 &&
      parts.at(-3) === "i18n" &&
      parts.at(-2) === ".i18n" &&
      parts.at(-1) === locale + ".tm.jsonl";
    if (
      (!core && !plugin) ||
      parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")) ||
      paths.has(memory.path)
    ) {
      throw new Error("Locale artifact contains an invalid or duplicate memory path: " + locale);
    }
    if (
      memory.metadata.locale !== locale ||
      memory.metadata.translatedKeys !== memory.metadata.totalKeys
    ) {
      throw new Error("Locale artifact is not fully translated: " + locale);
    }
    paths.add(memory.path);
  }
  if (!paths.has("ui/src/i18n/.i18n/" + locale + ".tm.jsonl")) {
    throw new Error("Locale artifact is missing core translation memory: " + locale);
  }
  return artifact;
}

/** Packs completed worker data; source and generated metadata are never restored. */
export async function packControlUiLocaleArtifact(params: {
  root: string;
  directory: string;
  locale: string;
  identity: Identity;
}): Promise<void> {
  const { root, directory, locale } = params;
  const identity = identitySchema.parse(params.identity);
  if (!CONTROL_UI_LOCALE_ENTRIES.some((entry) => entry.locale === locale)) {
    throw new Error("Unknown locale: " + locale);
  }
  if (git(root, ["rev-parse", "HEAD"]).trim() !== identity.sourceCommit) {
    throw new Error("Locale worker checkout differs from its resolved source");
  }
  const memories = await Promise.all(
    (await catalogAssets(root)).map(async (assets) => {
      const file = assets + "/" + locale + ".tm.jsonl";
      return {
        path: file,
        content: existsSync(path.join(root, file))
          ? await readFile(path.join(root, file), "utf8")
          : "",
        metadata: JSON.parse(
          await readFile(path.join(root, file.replace(/\.tm\.jsonl$/u, ".meta.json")), "utf8"),
        ) as unknown,
      };
    }),
  );
  const artifact = validateArtifact(
    { version: 1, locale, ...identity, memories },
    locale,
    identity,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, locale + ".json"), JSON.stringify(artifact) + "\n");
}

/** Import only compatible TM into a fresh main checkout, once per workflow run. */
export async function restoreControlUiLocaleArtifacts(params: {
  root: string;
  directory: string;
  locales: string[];
  identity: Identity;
}): Promise<{ sourceCommit: string; invalidated: string[] }> {
  const { root, directory, locales } = params;
  const identity = identitySchema.parse(params.identity);
  const currentLocales: string[] = CONTROL_UI_LOCALE_ENTRIES.map((entry) => entry.locale);
  if (
    locales.length !== currentLocales.length ||
    new Set(locales).size !== locales.length ||
    locales.some((locale) => !currentLocales.includes(locale))
  ) {
    throw new Error("Locale roster changed; defer to a fresh workflow run");
  }
  // The workflow checks out canonical main. Artifact fields are consistency
  // checks, not authority to select a repository, revision, or another run.
  const sourceCommit = git(root, ["rev-parse", "HEAD"]).trim();
  git(root, ["merge-base", "--is-ancestor", identity.sourceCommit, sourceCommit]);
  const files = await readdir(directory);
  if (
    files.length !== locales.length ||
    files.some((file) => !locales.some((locale) => file === locale + ".json"))
  ) {
    throw new Error("Same-run locale artifact inventory is incomplete or unexpected");
  }
  const artifacts = await Promise.all(
    locales.map(async (locale) =>
      validateArtifact(
        JSON.parse(await readFile(path.join(directory, locale + ".json"), "utf8")) as unknown,
        locale,
        identity,
      ),
    ),
  );
  const changed = git(root, [
    "diff",
    "--name-only",
    "-z",
    identity.sourceCommit,
    sourceCommit,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  const policyChanged = changed.some((file) => POLICY_PATHS.has(file));
  const assets = await catalogAssets(root);
  const invalidated: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  for (const artifact of artifacts) {
    const locale = artifact.locale;
    const expected = new Set(
      assets.map((assetsDirectory) => assetsDirectory + "/" + locale + ".tm.jsonl"),
    );
    const ownershipChanged =
      artifact.memories.length !== expected.size ||
      artifact.memories.some((memory) => !expected.has(memory.path));
    const canonicalChanged = changed.some(
      (file) =>
        file === "ui/src/i18n/.i18n/glossary." + locale + ".json" ||
        expected.has(file) ||
        expected.has(file.replace(/\.meta\.json$/u, ".tm.jsonl")),
    );
    if (policyChanged || ownershipChanged || canonicalChanged) {
      // A current canonical correction or policy change wins over worker data.
      // The finalizer regenerates this locale; --force still applies when requested.
      invalidated.push(locale);
      continue;
    }
    writes.push(...artifact.memories);
  }
  // Validate the complete fan-in before changing any canonical input files.
  for (const memory of writes) {
    const file = path.join(root, memory.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, memory.content);
  }
  return { sourceCommit, invalidated };
}

async function main() {
  const [command, directory, locale] = process.argv.slice(2);
  if (!directory || (command !== "pack" && command !== "restore")) {
    throw new Error(
      "Usage: control-ui-locale-artifacts.ts pack <directory> <locale> | restore <directory>",
    );
  }
  const identity = identitySchema.parse({
    sourceCommit: process.env.LOCALE_SOURCE_COMMIT,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  if (command === "pack") {
    if (!locale) {
      throw new Error("Locale is required");
    }
    await packControlUiLocaleArtifact({ root: process.cwd(), directory, locale, identity });
    return;
  }
  const locales: unknown = JSON.parse(process.env.LOCALE_SOURCE_LOCALES ?? "null");
  const result = await restoreControlUiLocaleArtifacts({
    root: process.cwd(),
    directory,
    identity,
    locales: z.array(z.string()).parse(locales),
  });
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GitHub output path is required");
  }
  await writeFile(
    process.env.GITHUB_OUTPUT,
    "sha=" + result.sourceCommit + "\ninvalidated=" + JSON.stringify(result.invalidated) + "\n",
    { flag: "a" },
  );
  console.log(
    "Reconciled same-run locale memory at " +
      result.sourceCommit +
      "; invalidated locales: " +
      (result.invalidated.join(", ") || "none"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

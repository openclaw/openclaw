import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";

type Platform = "ios" | "android";
type Source = {
  rootDir: string;
  platform: Platform;
  baseline: string | null;
  source: string;
  deadline: number;
};
type ChangedFile = {
  id: string;
  file: string;
  previousFile?: string;
  status: string;
  summary?: string;
};
export type ReleaseEvidence = { id: string; file: string; patch: string; kind?: "context" };
export type ReleaseInventory = { files: ChangedFile[]; commits: string[] };

function git(source: Source, ...args: string[]): string {
  const remaining = source.deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Release-note generation exceeded its five-minute budget.");
  }
  return execFileSync("git", args, {
    cwd: source.rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Math.min(30_000, remaining),
    maxBuffer: 32 * 1024 * 1024,
  });
}

function roots(platform: Platform): string[] {
  return platform === "ios"
    ? [
        "apps/ios/",
        "apps/shared/OpenClawKit/Sources/",
        "apps/shared/mermaid/",
        "apps/shared/OpenClawWatchRTC/",
        "apps/swabble/Sources/",
      ]
    : [
        "apps/android/app/src/main/",
        "apps/android/app/src/play/",
        "apps/android/wear/src/main/",
        "apps/android/wear-shared/src/main/",
        "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/",
        "apps/shared/mermaid/",
      ];
}

function relevantFile(file: string, platform: Platform): boolean {
  return (
    roots(platform).some((root) => file.startsWith(root)) &&
    !/(?:^|\/)(?:[^/]*Tests|Test|__tests__|fastlane|scripts|build|\.build|\.swiftpm|vendor)(?:\/|$)/iu.test(
      file,
    ) &&
    !/(?:CHANGELOG|AGENTS|README|VERSIONING|LICENSE|THIRD_PARTY|release-notes|^tests?\.)/iu.test(
      path.basename(file),
    ) &&
    // Generated protocol declarations describe transport, not available app features.
    !file.endsWith("/OpenClawProtocol/GatewayModels.swift") &&
    /\.(?:swift|m|mm|h|rs|kt|java|xml|plist|json|html|css|js|ts|strings|xcstrings|entitlements|yml|yaml)$/u.test(
      file,
    )
  );
}

const Catalog = z.object({
  sourceLanguage: z.string().optional(),
  strings: z.record(
    z.string(),
    z.object({ localizations: z.record(z.string(), z.unknown()).optional() }).passthrough(),
  ),
});

function localizationSummary(source: Source, file: ChangedFile): string {
  const read = (sha: string | null, name: string) =>
    sha ? Catalog.parse(JSON.parse(git(source, "show", `${sha}:${name}`))) : { strings: {} };
  const before = read(file.status === "A" ? null : source.baseline, file.previousFile ?? file.file);
  const after = read(file.status === "D" ? null : source.source, file.file);
  const oldKeys = Object.keys(before.strings);
  const newKeys = Object.keys(after.strings);
  const localeCounts = (catalog: z.infer<typeof Catalog>) => {
    const counts = new Map<string, number>();
    for (const entry of Object.values(catalog.strings)) {
      for (const locale of Object.keys(entry.localizations ?? {})) {
        counts.set(locale, (counts.get(locale) ?? 0) + 1);
      }
    }
    return Object.fromEntries(counts);
  };
  return JSON.stringify({
    kind: "localization-summary",
    addedKeys: newKeys.filter((key) => !Object.hasOwn(before.strings, key)).length,
    removedKeys: oldKeys.filter((key) => !Object.hasOwn(after.strings, key)).length,
    changedKeys: newKeys.filter(
      (key) =>
        Object.hasOwn(before.strings, key) &&
        JSON.stringify(before.strings[key]) !== JSON.stringify(after.strings[key]),
    ).length,
    translationsBefore: localeCounts(before),
    translationsAfter: localeCounts(after),
    limitation:
      "Catalog counts do not prove a feature is enabled or that a language is fully translated.",
  });
}

export function collectReleaseInventory(source: Source): ReleaseInventory {
  const fields = source.baseline
    ? git(
        source,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=50%",
        "--name-status",
        "-z",
        source.baseline,
        source.source,
        "--",
        ...roots(source.platform),
      ).split("\0")
    : git(
        source,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        source.source,
        "--",
        ...roots(source.platform),
      )
        .split("\0")
        .flatMap((file) => (file ? ["A", file] : []));
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!;
    const original = fields[index++];
    const file = status.startsWith("R") ? fields[index++] : original;
    if (!original || !file) {
      throw new Error("Invalid release-note Git inventory.");
    }
    if (!relevantFile(file, source.platform)) {
      continue;
    }
    files.push({
      id: "",
      file,
      status,
      ...(status.startsWith("R") ? { previousFile: original } : {}),
    });
  }
  files.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  for (const [index, file] of files.entries()) {
    file.id = `f${index + 1}`;
    if (file.file.endsWith(".xcstrings")) {
      file.summary = localizationSummary(source, file);
    }
  }
  if (JSON.stringify(files).length > 80_000) {
    throw new Error("Release-note file inventory exceeds its selection budget.");
  }
  // History is a discovery hint only. Selected claims must survive the endpoint diff.
  const commits =
    source.baseline && files.length
      ? git(
          source,
          "log",
          "--first-parent",
          "--format=%s",
          "--max-count=80",
          `${source.baseline}..${source.source}`,
          "--",
          ...files.map((file) => file.file),
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((subject) => subject.slice(0, 240))
      : [];
  const inventory = { files, commits };
  if (JSON.stringify(inventory).length > 100_000) {
    throw new Error(
      "Release-note change inventory exceeds its selection budget; narrow the release scope before generating notes.",
    );
  }
  return inventory;
}

function excerpt(text: string, focus: string[], limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const lines = text.split("\n");
  const selected = new Set<number>();
  const matches = lines.flatMap((line, index) =>
    focus.some((term) => line.toLowerCase().includes(term.toLowerCase())) ? [index] : [],
  );
  // Keep explicit line positions and omission markers; excerpts never imply complete coverage.
  for (const center of [...matches, ...lines.map((_, index) => index)]) {
    for (let index = Math.max(0, center - 3); index < Math.min(lines.length, center + 4); index++) {
      selected.add(index);
    }
    const length = [...selected].reduce((sum, index) => sum + lines[index]!.length + 16, 0);
    if (length >= limit - 200) {
      break;
    }
  }
  let result = "[EXCERPT: omitted content cannot support a claim]\n";
  let previous = -2;
  for (const index of [...selected].toSorted((a, b) => a - b)) {
    const line = `${index + 1}: ${lines[index]}\n`;
    if (result.length + line.length > limit - 40) {
      break;
    }
    if (index !== previous + 1) {
      result += "[omitted]\n";
    }
    result += line;
    previous = index;
  }
  return `${result}[remaining content omitted]\n`;
}

export function collectSelectedReleaseEvidence(
  source: Source,
  inventory: ReleaseInventory,
  selected: { id: string; focus: string[] }[],
): ReleaseEvidence[] {
  const evidence: ReleaseEvidence[] = [];
  const seen = new Set<string>();
  for (const selection of selected) {
    const file = inventory.files.find((entry) => entry.id === selection.id);
    if (!file || seen.has(selection.id)) {
      throw new Error("Release-note selection contains an unknown or duplicate file ID.");
    }
    seen.add(selection.id);
    const patch =
      file.summary ??
      (source.baseline
        ? git(
            source,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames=50%",
            "--unified=3",
            source.baseline,
            source.source,
            "--",
            ...new Set([file.previousFile ?? file.file, file.file]),
          )
        : git(source, "show", `${source.source}:${file.file}`));
    if (!patch.trim()) {
      continue;
    }
    evidence.push({
      id: `e${evidence.length + 1}`,
      file: file.file,
      patch: excerpt(patch, selection.focus, 8_000),
    });
    if (!file.summary && file.status !== "D") {
      evidence.push({
        id: `e${evidence.length + 1}`,
        file: file.file,
        kind: "context",
        patch: excerpt(
          git(source, "show", `${source.source}:${file.file}`),
          selection.focus,
          4_000,
        ),
      });
    }
  }
  if (evidence.length) {
    const contextPaths =
      source.platform === "android"
        ? [
            "apps/android/app/src/play/java/ai/openclaw/app/SensitiveFeatureConfig.kt",
            "apps/android/app/build.gradle.kts",
            "apps/android/wear/build.gradle.kts",
          ]
        : ["apps/ios/project.yml", "apps/shared/OpenClawKit/Package.swift"];
    const existing = new Set(
      git(source, "ls-tree", "-r", "--name-only", "-z", source.source, "--", ...contextPaths).split(
        "\0",
      ),
    );
    for (const file of contextPaths.filter((candidate) => existing.has(candidate))) {
      const patch = git(source, "show", `${source.source}:${file}`);
      if (patch.length > 30_000) {
        throw new Error(`Release-note availability context is too large: ${file}.`);
      }
      evidence.push({ id: `e${evidence.length + 1}`, file, patch, kind: "context" });
    }
  }
  if (JSON.stringify(evidence).length > 220_000) {
    throw new Error("Selected release-note evidence exceeds its review budget.");
  }
  return evidence;
}

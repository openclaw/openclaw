import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

type DomSmokeResult = {
  artifactDir: string;
  blocker: string | null;
  checked: string[];
  generatedAt: string;
  productionBrowserEquivalent: false;
  proofTier: "dom-static";
  routeDomProof: {
    bodyTextIncludesRoute: boolean;
    indexLoaded: boolean;
  };
  snesStudioBundle: {
    path: string | null;
    sha256: string | null;
    sizeBytes: number;
  };
  status: "pass" | "blocked";
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function defaultArtifactDir(): string {
  const slug = new Date().toISOString().replace(/[:.]/gu, "-");
  return join(".artifacts", "snes-studio-smoke", "dom", slug);
}

function findSnesStudioBundle(distRoot: string): string | null {
  const manifestPath = join(distRoot, "asset-manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    { file?: string; name?: string; src?: string }
  >;
  const entry = Object.values(manifest).find(
    (item) => item.name === "snes-studio" || item.src === "src/ui/views/snes-studio.ts",
  );
  return entry?.file ? join(distRoot, entry.file) : null;
}

export function runSnesStudioDomSmoke(
  input: {
    artifactDir?: string;
    distRoot?: string;
    now?: string;
  } = {},
): DomSmokeResult {
  const generatedAt = input.now ?? new Date().toISOString();
  const artifactDir = input.artifactDir ?? defaultArtifactDir();
  const distRoot = resolve(input.distRoot ?? join("dist", "control-ui"));
  const indexPath = join(distRoot, "index.html");
  const checked: string[] = [];
  const blockers: string[] = [];
  let bodyTextIncludesRoute = false;
  if (!existsSync(indexPath)) {
    blockers.push("dist/control-ui/index.html is missing; run pnpm ui:build first.");
  } else {
    const { document } = parseHTML(readFileSync(indexPath, "utf8"));
    bodyTextIncludesRoute = document.documentElement.textContent.includes("OpenClaw");
    checked.push("control-ui index DOM parsed");
  }
  const bundlePath = findSnesStudioBundle(distRoot);
  let bundleText = "";
  if (!bundlePath || !existsSync(bundlePath)) {
    blockers.push("SNES Studio built bundle is missing from dist/control-ui/asset-manifest.json.");
  } else {
    bundleText = readFileSync(bundlePath, "utf8");
    checked.push("SNES Studio dynamic bundle located");
  }
  const requiredBundleStrings = [
    "SNES Mastery",
    "Next incomplete",
    "Blocker:",
    "Load SNES Mastery",
  ];
  for (const text of requiredBundleStrings) {
    if (!bundleText.includes(text)) {
      blockers.push(`SNES Studio bundle is missing required mastery-card text: ${text}`);
    } else {
      checked.push(`bundle text: ${text}`);
    }
  }
  const result: DomSmokeResult = {
    artifactDir,
    blocker: blockers[0] ?? null,
    checked,
    generatedAt,
    productionBrowserEquivalent: false,
    proofTier: "dom-static",
    routeDomProof: {
      bodyTextIncludesRoute,
      indexLoaded: existsSync(indexPath),
    },
    snesStudioBundle: {
      path: bundlePath,
      sha256: bundlePath && existsSync(bundlePath) ? sha256File(bundlePath) : null,
      sizeBytes: bundlePath && existsSync(bundlePath) ? statSync(bundlePath).size : 0,
    },
    status: blockers.length === 0 ? "pass" : "blocked",
  };
  mkdirSync(artifactDir, { recursive: true });
  writeJson(join(artifactDir, "receipt.json"), result);
  writeJson(join(".artifacts", "snes-studio-smoke", "dom", "latest.json"), result);
  return result;
}

function parseArgs(argv: string[]) {
  const artifactDirIndex = argv.indexOf("--artifact-dir");
  const distRootIndex = argv.indexOf("--dist-root");
  return {
    artifactDir: artifactDirIndex >= 0 ? argv[artifactDirIndex + 1] : undefined,
    distRoot: distRootIndex >= 0 ? argv[distRootIndex + 1] : undefined,
    json: argv.includes("--json"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runSnesStudioDomSmoke(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `SNES Studio DOM smoke ${result.status}: ${result.blocker ?? result.snesStudioBundle.path}\n`,
    );
  }
  process.exit(result.status === "pass" ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}

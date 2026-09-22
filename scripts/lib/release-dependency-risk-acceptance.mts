import type { runDependencyVulnerabilityGate } from "../dependency-vulnerability-gate.mts";

type Blocker = Awaited<ReturnType<typeof runDependencyVulnerabilityGate>>["blockers"][number];

// Release-specific maintainer decisions retain unresolved findings. Exact graph
// bytes and finding sets prevent acceptance from carrying to another release,
// a changed graph, or an additional advisory.
export const RELEASE_DEPENDENCY_RISK_LOCKFILES = {
  "pnpm-lock.yaml": "60ec3478d55f958efd41f314b32e0975a5becb4e0a90216c3cf9f9c6365e1443",
  ".github/release/vercel-cli/package-lock.json":
    "b06b20bca67a863ad99cb479d51319b3483fb131b57c6855c26a35a92c2c89b5",
  ".github/release/clawhub-cli/package-lock.json":
    "adc9d3613a752dfe00597a8826f45fab82e7651478d16ba1bf5354369157fee9",
};

const acceptedFindings = new Set([
  "pnpm-lock.yaml|fast-uri|GHSA-58mr-gqgx-xq4g|4.1.3",
  "pnpm-lock.yaml|fast-uri|GHSA-qw65-cvwx-89v3|4.1.3",
  ".github/release/vercel-cli/package-lock.json|fast-uri|GHSA-58mr-gqgx-xq4g|3.1.6",
  ".github/release/vercel-cli/package-lock.json|fast-uri|GHSA-qw65-cvwx-89v3|3.1.6",
  "pnpm-lock.yaml|nodemailer|GHSA-2x7j-588g-ccc2|9.0.4,9.0.5",
]);

const acceptedReleaseRisks = new Map([
  [
    "2026.9.1",
    {
      lockfileSha256: RELEASE_DEPENDENCY_RISK_LOCKFILES,
      acceptedFindings,
      acceptedOn: "2026-09-02",
    },
  ],
  [
    "2026.9.5",
    {
      lockfileSha256: {
        "pnpm-lock.yaml": "ab6c244a27c09488e51e9d5879d84514fd0ac57b1db4e927d6a0464e598d543f",
        ".github/release/vercel-cli/package-lock.json":
          "a094a59287570aa124a65eb208739a5f4b89b7e8ffe768a3ac38842dd2e2dc85",
        ".github/release/clawhub-cli/package-lock.json":
          "30142b07c1167d030926f9dd3320a8b158aa59cbca5a56e05d949a50e6e2b3c6",
      },
      acceptedFindings: new Set(["pnpm-lock.yaml|axios|GHSA-3pq3-5fj3-cg6v|1.20.0"]),
      acceptedOn: "2026-09-17",
    },
  ],
]);

export function getReleaseDependencyRiskLockfiles(packageVersion: string): string[] | null {
  const acceptance = acceptedReleaseRisks.get(packageVersion);
  return acceptance ? Object.keys(acceptance.lockfileSha256) : null;
}

export function resolveReleaseDependencyRiskAcceptance(params: {
  packageVersion: string;
  lockfileSha256: Record<string, string>;
  blockers: Blocker[];
}) {
  const { packageVersion, lockfileSha256, blockers } = params;
  const acceptance = acceptedReleaseRisks.get(packageVersion);
  const keys = blockers.map(
    (finding) =>
      `${finding.lockfile}|${finding.packageName}|${finding.id}|${(finding.matchedVersions ?? []).toSorted().join(",")}`,
  );
  if (
    !acceptance ||
    Object.entries(acceptance.lockfileSha256).some(
      ([file, digest]) => lockfileSha256[file] !== digest,
    ) ||
    keys.length !== acceptance.acceptedFindings.size ||
    new Set(keys).size !== acceptance.acceptedFindings.size ||
    keys.some((key) => !acceptance.acceptedFindings.has(key)) ||
    blockers.some(
      (finding) => finding.severity !== "high" || finding.malware || finding.graph !== "production",
    )
  ) {
    return null;
  }
  return {
    kind: "operator-accepted-dependency-risk" as const,
    packageVersion,
    acceptedOn: acceptance.acceptedOn,
    decision:
      "Release with unchanged dependencies; retain known advisory findings as accepted risk.",
    lockfileSha256,
    blockers,
  };
}

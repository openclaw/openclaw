import { matchesGlob } from "node:path";
import {
  controlUiE2eTestGlobs,
  isUiTestTarget,
  resolveUiTypeScriptPath,
  uiE2ePrebuiltParallelTestFiles,
  uiE2eRealGatewayTestFiles,
} from "../../test/vitest/vitest.ui-paths.mjs";
import {
  isRuntimeTestFileIncluded,
  type RuntimeTestSelection,
} from "./ci-runtime-test-eligibility.mts";
import { RELEASE_ONLY_UI_TEST_FILES } from "./ci-test-tier-policy.mts";
import { readUiE2eFileTimings } from "./ci-test-timings.mts";
import { listTrackedTestFiles } from "./list-test-files.mts";

export function createUiTestShardGroups(
  options: RuntimeTestSelection & {
    includeReleaseOnlyTests?: boolean;
    includeReleaseOnlyE2eTests?: boolean;
    uiE2eFiles?: readonly string[];
  } = {},
) {
  const includeReleaseOnlyTests = options.includeReleaseOnlyTests ?? true;
  const changedPaths = new Set(options.changedPaths ?? []);
  const includeUiTest = (file: string) =>
    includeReleaseOnlyTests || !RELEASE_ONLY_UI_TEST_FILES.has(file) || changedPaths.has(file);
  const files =
    includeReleaseOnlyTests && options.includePrExemptRuntimeTests !== false
      ? undefined
      : listTrackedTestFiles(".").filter(
          (file) => includeUiTest(file) && isRuntimeTestFileIncluded(file, options),
        );
  const group = (config: string, ownsFile: (file: string) => boolean) => [
    {
      configs: [config],
      shard_name: config,
      ...(files ? { includePatterns: files.filter(ownsFile) } : {}),
    },
  ];
  const e2eGroups = group(
    "test/vitest/vitest.ui-e2e.config.ts",
    (file) =>
      controlUiE2eTestGlobs.some((pattern) => matchesGlob(file, pattern)) ||
      uiE2eRealGatewayTestFiles.includes(file),
  );
  if (options.uiE2eFiles) {
    const retained = (files ?? listTrackedTestFiles(".")).filter((file) =>
      uiE2eRealGatewayTestFiles.includes(file),
    );
    e2eGroups[0]!.includePatterns = [
      ...new Set([
        ...options.uiE2eFiles.filter(includeUiTest),
        ...(options.includeReleaseOnlyE2eTests
          ? uiE2eRealGatewayTestFiles.filter(includeUiTest)
          : retained),
      ]),
    ].toSorted();
  }
  return {
    ui: group("ui/vitest.config.ts", isUiTestTarget),
    e2e: e2eGroups,
  };
}

export const UI_REAL_GATEWAY_TEST_CONFIG = "test/vitest/vitest.ui-e2e-prebuilt.config.ts";

export function createUiRealGatewayTestShards(
  e2eGroups: ReturnType<typeof createUiTestShardGroups>["e2e"],
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const selected = new Set(
    e2eGroups.flatMap((group) => group.includePatterns ?? uiE2eRealGatewayTestFiles),
  );
  const parallelFiles = new Set(uiE2ePrebuiltParallelTestFiles);
  const desktop = resolveUiTypeScriptPath("ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts");
  const files = uiE2eRealGatewayTestFiles.filter((file) => selected.has(file) && file !== desktop);
  const timings = readUiE2eFileTimings();
  // Disabled proofs still collect. An enabled DeepSeek flag retains full pricing
  // without requiring preflight to receive the test job's credentials.
  const optInEnabled = new Map([
    [
      resolveUiTypeScriptPath("ui/src/e2e/deepseek-search.real-gateway.e2e.test.ts"),
      env.OPENCLAW_DEEPSEEK_UI_LIVE === "1",
    ],
    [
      resolveUiTypeScriptPath("ui/src/e2e/chat-steer-deferred-custody.real-gateway.e2e.test.ts"),
      Boolean(env.OPENCLAW_STEER_CUSTODY_PROOF),
    ],
  ]);
  // Cold Gateway files use the observed roughly 30s file cost until two CI samples exist.
  const seconds = (file: string) =>
    (optInEnabled.get(file) === false ? 0 : (timings.fileSeconds[file] ?? 30)) +
    timings.perFileOverheadSeconds;
  const serial = files.filter((file) => !parallelFiles.has(file));
  // The desktop driver runs outside Vitest: scheduled run 39872214487 took 120s.
  const desktopSeconds = selected.has(desktop) ? (timings.fileSeconds[desktop] ?? 120) : 0;
  // Each runner keeps unqualified fixtures serial. Split that work before placing
  // qualified fixtures so one runner does not wait behind every serial file.
  const buckets: { serialSeconds: number; workerSeconds: [number, number]; files: string[] }[] = [
    { serialSeconds: 0, workerSeconds: [0, 0], files: [] },
    { serialSeconds: 0, workerSeconds: [0, 0], files: [] },
  ];
  for (const file of serial.toSorted(
    (left, right) => seconds(right) - seconds(left) || left.localeCompare(right),
  )) {
    const bucket =
      buckets[0]!.serialSeconds <= buckets[1]!.serialSeconds ? buckets[0]! : buckets[1]!;
    bucket.files.push(file);
    bucket.serialSeconds += seconds(file);
  }
  for (const [index, bucket] of buckets.entries()) {
    const initialSeconds = Math.max(bucket.serialSeconds, index === 0 ? desktopSeconds : 0);
    bucket.workerSeconds = [initialSeconds, initialSeconds];
  }
  // Qualified fixtures use each job's existing two workers after its serial
  // phase and, on the first runner, overlapping desktop proof have joined.
  for (const file of files
    .filter((candidate) => parallelFiles.has(candidate))
    .toSorted((left, right) => seconds(right) - seconds(left) || left.localeCompare(right))) {
    const bucket = buckets.reduce((earliest, candidate) =>
      Math.min(...candidate.workerSeconds) < Math.min(...earliest.workerSeconds)
        ? candidate
        : earliest,
    );
    const worker = bucket.workerSeconds[0] <= bucket.workerSeconds[1] ? 0 : 1;
    bucket.files.push(file);
    bucket.workerSeconds[worker] += seconds(file);
  }
  return ([1, 2] as const).map((shard) => ({
    shard,
    shard_count: 2 as const,
    run_desktop: shard === 1 && selected.has(desktop),
    groups: [
      {
        configs: [UI_REAL_GATEWAY_TEST_CONFIG],
        shard_name: `ui-e2e-real-gateway-${shard === 1 ? "desktop" : "parallel"}`,
        includePatterns: buckets[shard - 1]!.files.toSorted(),
      },
    ],
  }));
}

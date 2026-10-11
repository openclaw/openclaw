#!/usr/bin/env -S node --import tsx
import { parseStrictBooleanArg } from "./lib/arg-utils.mts";
// Runtime proof runs before package builds; release planning imports are not part of this CLI.

function parseArgs(argv: string[]) {
  const values = [...argv];
  if (values[0] === "--") {
    values.shift();
  }

  let repository: string | undefined;
  let waitForClawHub: boolean | undefined;
  let forceSkipClawHub: boolean | undefined;
  let normalRunId: string | undefined;
  let normalPublicationStaged = false;
  let bootstrapRunId: string | undefined;
  let bootstrapCompleted: boolean | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--repository":
        repository = next();
        break;
      case "--wait-for-clawhub":
        waitForClawHub = parseStrictBooleanArg(next(), "--wait-for-clawhub");
        break;
      case "--force-skip-clawhub":
        forceSkipClawHub = parseStrictBooleanArg(next(), "--force-skip-clawhub");
        break;
      case "--normal-run-id":
        normalRunId = next();
        break;
      case "--normal-publication-staged":
        normalPublicationStaged = parseStrictBooleanArg(next(), "--normal-publication-staged");
        break;
      case "--bootstrap-run-id":
        bootstrapRunId = next();
        break;
      case "--bootstrap-completed":
        bootstrapCompleted = parseStrictBooleanArg(next(), "--bootstrap-completed");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!repository?.trim()) {
    throw new Error("--repository is required.");
  }
  if (waitForClawHub === undefined) {
    throw new Error("--wait-for-clawhub is required.");
  }
  if (forceSkipClawHub === undefined) {
    throw new Error("--force-skip-clawhub is required.");
  }
  if (bootstrapCompleted === undefined) {
    throw new Error("--bootstrap-completed is required.");
  }

  return {
    repository,
    waitForClawHub,
    forceSkipClawHub,
    normalRunId,
    normalPublicationStaged,
    bootstrapRunId,
    bootstrapCompleted,
  };
}

function runUrl(repository: string, runId: string): string {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function buildOpenClawReleaseClawHubRuntimeState(args: ReturnType<typeof parseArgs>) {
  const repository = args.repository.trim();
  const normalRunId = args.normalRunId?.trim() || undefined;
  const bootstrapRunId = args.bootstrapRunId?.trim() || undefined;

  const shouldIncludeNormalRun =
    !args.forceSkipClawHub && normalRunId !== undefined && args.waitForClawHub;
  const shouldIncludeBootstrapRun =
    !args.forceSkipClawHub && bootstrapRunId !== undefined && args.bootstrapCompleted;
  const shouldVerifyClawHubPackages =
    bootstrapRunId !== undefined &&
    args.bootstrapCompleted &&
    (normalRunId === undefined || args.waitForClawHub);
  const shouldSkipClawHubPackages =
    args.forceSkipClawHub ||
    (normalRunId !== undefined && args.normalPublicationStaged) ||
    !(shouldIncludeNormalRun || shouldVerifyClawHubPackages);

  const verifierArgs = shouldSkipClawHubPackages ? ["--skip-clawhub"] : [];
  if (shouldIncludeNormalRun) {
    verifierArgs.push("--plugin-clawhub-run", normalRunId);
  }
  if (shouldIncludeBootstrapRun) {
    verifierArgs.push("--plugin-clawhub-bootstrap-run", bootstrapRunId);
  }

  let normalProofLine = "- plugin ClawHub publish: no normal OIDC candidates";
  if (normalRunId !== undefined && args.forceSkipClawHub) {
    normalProofLine = `- plugin ClawHub publish: not verified after a required ClawHub failure: ${runUrl(repository, normalRunId)}`;
  } else if (normalRunId !== undefined && args.normalPublicationStaged) {
    normalProofLine = `- plugin ClawHub submission: ${runUrl(repository, normalRunId)}; public finalization and exact artifact verification follow terminal release-parent completion`;
  } else if (normalRunId !== undefined && args.waitForClawHub) {
    normalProofLine = `- plugin ClawHub publish: ${runUrl(repository, normalRunId)}`;
  } else if (normalRunId !== undefined) {
    normalProofLine = `- plugin ClawHub publish: dispatched separately, not awaited by this proof: ${runUrl(repository, normalRunId)}`;
  }

  let bootstrapProofLine = "- plugin ClawHub bootstrap: not needed";
  if (bootstrapRunId !== undefined && args.forceSkipClawHub) {
    bootstrapProofLine = `- plugin ClawHub bootstrap: not verified after a required ClawHub failure: ${runUrl(repository, bootstrapRunId)}`;
  } else if (bootstrapRunId !== undefined && (args.bootstrapCompleted || args.waitForClawHub)) {
    bootstrapProofLine = `- plugin ClawHub bootstrap: ${runUrl(repository, bootstrapRunId)}`;
  } else if (bootstrapRunId !== undefined) {
    bootstrapProofLine = `- plugin ClawHub bootstrap: dispatched separately, not awaited by this proof: ${runUrl(repository, bootstrapRunId)}`;
  }

  return {
    verifierArgs,
    proofLines: {
      normal: normalProofLine,
      bootstrap: bootstrapProofLine,
    },
  };
}

try {
  const state = buildOpenClawReleaseClawHubRuntimeState(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

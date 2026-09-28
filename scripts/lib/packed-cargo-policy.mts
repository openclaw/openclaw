import { LOCAL_BUILD_METADATA_DIST_PATHS } from "./local-build-metadata-paths.mts";

const FORBIDDEN_PACKED_PATH_RULES = [
  ...LOCAL_BUILD_METADATA_DIST_PATHS.map((prefix) => ({
    prefix,
    kind: "local build metadata",
  })),
  {
    prefix: "dist-runtime/",
    kind: "local runtime build output",
  },
  {
    prefix: "dist/OpenClaw.app/",
    kind: "local application build output",
  },
  {
    prefix: "docs/.generated/",
    kind: "generated docs artifact",
  },
  {
    prefix: "docs/channels/qa-channel.md",
    kind: "private QA channel docs",
  },
  {
    prefix: "dist/extensions/qa-channel/",
    kind: "private QA channel artifact",
  },
  {
    prefix: "dist/extensions/qa-lab/",
    kind: "private QA lab artifact",
  },
  {
    prefix: "dist/plugin-sdk/extensions/qa-channel/",
    kind: "private QA channel type artifact",
  },
  {
    prefix: "dist/plugin-sdk/extensions/qa-lab/",
    kind: "private QA lab type artifact",
  },
  {
    prefix: "dist/plugin-sdk/qa-channel.",
    kind: "private QA channel SDK artifact",
  },
  {
    prefix: "dist/plugin-sdk/qa-channel-protocol.",
    kind: "private QA channel SDK artifact",
  },
  {
    prefix: "dist/plugin-sdk/qa-lab.",
    kind: "private QA lab SDK artifact",
  },
  {
    prefix: "dist/plugin-sdk/qa-runtime.",
    kind: "private QA runtime SDK artifact",
  },
  {
    prefix: "dist/qa-runtime-",
    kind: "private QA runtime chunk",
  },
  {
    prefix: "qa/",
    kind: "private QA suite artifact",
  },
] as const;

export function collectForbiddenPackedPathErrors(paths: Iterable<string>): string[] {
  const errors: string[] = [];
  for (const packedPath of paths) {
    const matchedRule = FORBIDDEN_PACKED_PATH_RULES.find((rule) =>
      packedPath.startsWith(rule.prefix),
    );
    if (matchedRule) {
      errors.push(`npm package must not include ${matchedRule.kind} "${packedPath}".`);
    }
  }
  return errors.toSorted((left, right) => left.localeCompare(right));
}

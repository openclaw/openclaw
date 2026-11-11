import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory, ExtensionEvent } from "./extensions/types.js";
import { DefaultResourceLoader } from "./resource-loader.js";

export async function createResourceLoader(
  extension?: ExtensionFactory,
  paths?: { cwd: string; agentDir: string },
): Promise<DefaultResourceLoader> {
  // Empty explicit resource paths do no I/O; never discover resources in the operator's home.
  const cwd = paths?.cwd ?? join(tmpdir(), `openclaw-test-resource-loader-${randomUUID()}`);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: paths?.agentDir ?? join(cwd, "agent"),
    extensionFactories: extension ? [extension] : [],
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length > 0) {
    throw new Error(
      `Failed to load test extension: ${errors.map((error) => error.error).join("; ")}`,
    );
  }
  return loader;
}

export async function compactionHandler({
  preparation,
}: Extract<ExtensionEvent, { type: "session_before_compact" }>) {
  return {
    compaction: {
      summary: "condensed history",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  };
}

export function createCompactionExtension(): ExtensionFactory {
  return (api) => api.on("session_before_compact", compactionHandler);
}

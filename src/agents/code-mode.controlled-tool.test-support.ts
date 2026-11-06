import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AnyAgentTool } from "./tools/common.js";

/** A real bridge tool whose implementation settles only when the test releases it. */
export function controlledTool(tool: AnyAgentTool) {
  const started = createDeferred<AbortSignal | undefined>();
  const release = createDeferred();
  const finished = createDeferred();
  const execute = tool.execute;
  tool.execute = vi.fn(async (...args: Parameters<AnyAgentTool["execute"]>) => {
    started.resolve(args[2]);
    await release.promise;
    const result = await execute(...args);
    finished.resolve();
    return result;
  });
  return { tool, started, release, finished };
}

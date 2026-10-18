import { createDeferred } from "../../test/helpers/promise.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

export function createGatedToolFactory(
  makeTool: (name: string, execute: AnyAgentTool["execute"]) => AnyAgentTool,
) {
  return (name: string, label: string, events: string[], value: unknown) => {
    const started = createDeferred();
    const release = createDeferred();
    const state = { aborted: false, completed: false };
    const tool = makeTool(name, async (_id, _input, signal) => {
      events.push(`${label}:start`);
      started.resolve();
      signal?.addEventListener(
        "abort",
        () => {
          state.aborted = true;
          release.reject(new Error("aborted"));
        },
        { once: true },
      );
      await release.promise;
      events.push(`${label}:done`);
      state.completed = true;
      return jsonResult(value);
    });
    return { tool, started, release, state };
  };
}

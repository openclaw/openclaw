import path from "node:path";
import { describe, expect, it } from "vitest";
import { injectNodeRuntimePath } from "./process.js";

describe("injectNodeRuntimePath", () => {
  it("prepends the current node runtime directory when missing", () => {
    const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin"].join(path.delimiter) };
    const execPath = "/Users/lidan/.nvs/default/bin/node";

    const next = injectNodeRuntimePath({ env, execPath });

    expect(next.PATH).toBe(
      ["/Users/lidan/.nvs/default/bin", "/usr/bin", "/bin"].join(path.delimiter),
    );
    expect(env.PATH).toBe(["/usr/bin", "/bin"].join(path.delimiter));
  });

  it("keeps existing PATH key casing", () => {
    const env: NodeJS.ProcessEnv = { Path: ["/usr/bin", "/bin"].join(path.delimiter) };
    const execPath = "/Users/lidan/.nvs/default/bin/node";

    const next = injectNodeRuntimePath({ env, execPath });

    expect(next.Path).toBe(
      ["/Users/lidan/.nvs/default/bin", "/usr/bin", "/bin"].join(path.delimiter),
    );
    expect(next.PATH).toBeUndefined();
  });

  it("does not duplicate runtime dir when already present", () => {
    const runtimeDir = "/Users/lidan/.nvs/default/bin";
    const env: NodeJS.ProcessEnv = {
      PATH: [runtimeDir, "/usr/bin", "/bin"].join(path.delimiter),
    };
    const execPath = `${runtimeDir}/node`;

    const next = injectNodeRuntimePath({ env, execPath });

    expect(next).toBe(env);
    expect(next.PATH).toBe([runtimeDir, "/usr/bin", "/bin"].join(path.delimiter));
  });
});

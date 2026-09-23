import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdByWorkspacePath } from "./agent-scope.js";

describe("workspace inference for large agent rosters", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["entries", "list"] as const)(
    "selects the most specific %s workspace with bounded roster work and fresh configuration",
    (representation) => {
      const root = tempDirs.make("workspace-inference-roster-");
      const count = 64;
      const entries = Array.from({ length: count }, (_, index) => ({
        id: `agent-${index}`,
        workspace: path.join(root, "workspaces", `agent-${index}`),
      }));
      entries[0]!.workspace = path.join(root, "workspaces");
      const selected = entries[count - 2]!;
      entries[count - 1]!.workspace = selected.workspace;
      for (const { workspace } of entries) {
        fs.mkdirSync(workspace, { recursive: true });
      }
      let reads = 0;
      const observe = <T extends object>(roster: T): T =>
        new Proxy(roster, {
          get(target, key, receiver) {
            if (typeof key === "string" && Object.hasOwn(target, key) && key !== "length") {
              reads += 1;
            }
            return Reflect.get(target, key, receiver);
          },
        });
      const config: OpenClawConfig = {
        agents:
          representation === "list"
            ? { list: observe(entries) }
            : {
                entries: observe(
                  Object.fromEntries(entries.map(({ id, workspace }) => [id, { workspace }])),
                ),
              },
      };
      const query = path.join(root, "workspaces", selected.id, "not-created-yet");
      expect(resolveAgentIdByWorkspacePath(config, query)).toBe(selected.id);
      const resolutionReads = reads;

      const changed = representation === "list" ? selected : config.agents!.entries![selected.id]!;
      changed.workspace = path.join(root, "replacement-workspace");
      expect(resolveAgentIdByWorkspacePath(config, query)).toBe(entries[count - 1]!.id);
      expect(resolveAgentIdByWorkspacePath(config, path.join(root, "unrelated"))).toBeUndefined();
      expect(resolutionReads).toBeLessThanOrEqual(count * 4);
    },
  );
});

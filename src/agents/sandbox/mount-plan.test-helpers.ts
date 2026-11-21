import { vi } from "vitest";
import * as engine from "./container-engine.js";
import * as sourceNamespace from "./docker-mount-source.js";
import { updateRegistry } from "./registry.js";

/** Model engine inspection only; registry, mount selection and read authority stay real. */
export async function mockStoppedWorkspaceContainer(
  workspaceDir: string,
  containerRoot = "/workspace",
  nested: Array<{ Type: string; Source?: string; Destination: string; RW: boolean }> = [],
) {
  await updateRegistry({
    containerName: "media-fixture",
    backendId: "docker",
    sessionKey: "media-fixture",
    workspaceDir,
    image: "fixture",
    createdAtMs: 1,
    lastUsedAtMs: 1,
  });
  vi.spyOn(sourceNamespace, "resolveDockerSourceNamespace").mockResolvedValue(undefined);
  vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    const stdout = args.includes("{{.Id}} {{.State.Running}} {{.State.Paused}}")
      ? `${"a".repeat(64)} false false`
      : args[0] === "inspect" && args[1] === "--format"
        ? JSON.stringify({
            Mounts: [
              { Type: "bind", Source: workspaceDir, Destination: containerRoot, RW: true },
              ...nested,
            ],
            Tmpfs: {},
          })
        : undefined;
    if (stdout === undefined) {
      throw new Error(`Unexpected container fixture command: ${args.join(" ")}`);
    }
    return { stdout, stderr: "", code: 0 };
  });
}

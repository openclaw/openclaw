import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

export type SandboxInputStager = (params: {
  prefix: string;
  content: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  onCreated?: (cleanup: () => Promise<void>) => void;
}) => Promise<string>;

const INPUT_STAGER = Symbol.for("openclaw.sandboxInputStager");
type InputStagingBridge = SandboxFsBridge & { [INPUT_STAGER]?: SandboxInputStager };

/** Prepared host ownership, separate from the guest's file-mutation permissions. */
export function bindSandboxInputStager(bridge: SandboxFsBridge, stage: SandboxInputStager): void {
  Object.defineProperty(bridge, INPUT_STAGER, { value: stage, configurable: true });
}

export function getSandboxInputStager(bridge: SandboxFsBridge): SandboxInputStager | undefined {
  // SAFETY: Only bindSandboxInputStager writes this private symbol with a SandboxInputStager.
  return (bridge as InputStagingBridge)[INPUT_STAGER];
}

/** Local backend owners prepare this capability; guest paths never select its root. */
export function createSandboxInputStager(owner: {
  root: string;
  bridge: SandboxFsBridge;
  assertCurrent: () => void;
}): SandboxInputStager {
  return async (input) => {
    const assertCurrent = () => {
      input.signal?.throwIfAborted();
      owner.assertCurrent();
      input.assertCurrent();
    };
    assertCurrent();
    const [
      { root: fsRoot },
      { stagedInputDirectory, STAGED_INPUT_GITIGNORE },
      { capturePathRemovalGuard, removePathWithinRoot },
    ] = await Promise.all([
      import("../../infra/fs-safe.js"),
      import("../../media/staged-inputs.js"),
      import("../../infra/fs-safe-remove.js"),
    ]);
    const directory = stagedInputDirectory(randomUUID());
    const filePath = `${directory}/${input.prefix}.log`;
    const target = owner.bridge.resolvePath({ filePath, cwd: owner.root });
    // A nested bind may shadow the input area without granting the producer a
    // destination outside the workspace its owner prepared.
    if (target.hostPath !== path.join(owner.root, filePath)) {
      throw new Error("Sandbox input staging is shadowed by another mount");
    }
    const root = await fsRoot(owner.root);
    const assertRoot = capturePathRemovalGuard(owner.root);
    if (!assertRoot) {
      throw new Error("Sandbox input staging root is unavailable");
    }
    let assertDirectory: (() => void) | undefined;
    const cleanup = async () => {
      if (!assertDirectory) {
        return;
      }
      // Only this newly created input retains cleanup custody after cancellation.
      await removePathWithinRoot({
        rootDir: owner.root,
        relativePath: directory,
        recursive: true,
        assertBeforeMutation: () => {
          assertRoot();
          assertDirectory?.();
        },
      });
    };
    try {
      for (const [file, data] of [
        [`${directory}/.gitignore`, STAGED_INPUT_GITIGNORE],
        [filePath, input.content],
      ] as const) {
        assertCurrent();
        await root.create(file, data, { mode: 0o600, assertBeforeMutation: assertCurrent });
        if (!assertDirectory) {
          assertDirectory = capturePathRemovalGuard(path.join(owner.root, directory));
          if (!assertDirectory) {
            throw new Error("Sandbox input staging disappeared during creation");
          }
          input.onCreated?.(cleanup);
        }
      }
      assertCurrent();
      return target.containerPath;
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
  };
}

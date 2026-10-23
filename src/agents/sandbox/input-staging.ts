import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

export type SandboxInputStager = (params: {
  prefix: string;
  content: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
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
    const [{ root: fsRoot }, { stagedInputDirectory, STAGED_INPUT_GITIGNORE }] = await Promise.all([
      import("../../infra/fs-safe.js"),
      import("../../media/staged-inputs.js"),
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
    for (const [file, data] of [
      [`${directory}/.gitignore`, STAGED_INPUT_GITIGNORE],
      [filePath, input.content],
    ] as const) {
      assertCurrent();
      await root.create(file, data, { mode: 0o600, assertBeforeMutation: assertCurrent });
    }
    assertCurrent();
    return target.containerPath;
  };
}

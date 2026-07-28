const sandboxProvisioningRegistryKey = Symbol.for("openclaw.sandboxProvisioningError.registry");

type SandboxProvisioningRegistry = {
  errors: WeakSet<object>;
};

type GlobalWithSandboxProvisioningRegistry = typeof globalThis & {
  [sandboxProvisioningRegistryKey]?: SandboxProvisioningRegistry;
};

function getSandboxProvisioningRegistry(): SandboxProvisioningRegistry {
  const globalState = globalThis as GlobalWithSandboxProvisioningRegistry;
  globalState[sandboxProvisioningRegistryKey] ??= { errors: new WeakSet<object>() };
  return globalState[sandboxProvisioningRegistryKey];
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Fallback wrapper for the rare case where sandbox setup throws a primitive. */
class SandboxProvisioningError extends Error {
  readonly code = "sandbox_provisioning_failed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxProvisioningError";
    getSandboxProvisioningRegistry().errors.add(this);
  }
}

/** Mark a sandbox-owned setup failure without replacing domain-specific error metadata. */
export function markSandboxProvisioningError(error: unknown): unknown {
  if (isObjectLike(error)) {
    getSandboxProvisioningRegistry().errors.add(error);
    return error;
  }
  return new SandboxProvisioningError(String(error), { cause: error });
}

/** True when the sandbox owner marked this exact failure before provider execution. */
export function isSandboxProvisioningError(error: unknown): boolean {
  return isObjectLike(error) && getSandboxProvisioningRegistry().errors.has(error);
}

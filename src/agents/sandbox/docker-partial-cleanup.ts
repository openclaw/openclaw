import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import { removeRegistryEntry } from "./registry.js";

export async function throwAfterPartialSandboxCleanup(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  creationError: unknown;
}): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    const removal = await execContainer(params.engine, ["rm", "-f", params.containerName], {
      allowFailure: true,
    });
    const detail = removal.stderr.trim() || removal.stdout.trim() || `exit ${removal.code}`;
    if (removal.code !== 0 && !/No such (container|object)|does not exist/iu.test(detail)) {
      cleanupErrors.push(
        new Error(`Failed to remove partially created sandbox ${params.containerName}: ${detail}`),
      );
    }
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    await removeRegistryEntry(params.containerName);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [params.creationError, ...cleanupErrors],
      `Sandbox ${params.containerName} creation and cleanup both failed.`,
      { cause: params.creationError },
    );
  }
  throw params.creationError;
}

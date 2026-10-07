export class PreparedModelCatalogConfigReplacedError extends Error {
  constructor(agentDir: string) {
    super(`prepared model catalog owner config was replaced during the read (${agentDir})`);
    this.name = "PreparedModelCatalogConfigReplacedError";
  }
}

export class PreparedModelCatalogAdmissionStalledError extends Error {
  constructor(pluginId: string | undefined, idleMs: number) {
    super(
      `${pluginId ? `Plugin ${pluginId} native reference verification` : "Catalog preparation"} stalled after ${idleMs} ms without progress; reload the plugin or restart the Gateway to retry`,
    );
    this.name = "PreparedModelCatalogAdmissionStalledError";
  }
}

export class PreparedModelCatalogGenerationMismatchError extends Error {
  constructor(
    readonly agentDir: string,
    readonly generationFingerprint: string,
    readonly reconstructedFingerprint: string,
  ) {
    super(
      `prepared model catalog worker reconstructed a different runtime generation for ${agentDir} (owner=${generationFingerprint} worker=${reconstructedFingerprint})`,
    );
    this.name = "PreparedModelCatalogGenerationMismatchError";
  }
}

/** Plugin config for the llama-server provider. */
export type LlamaServerConfig = {
  /** Auto-detect llama-server endpoints and apply compat fixes. Default: true. */
  autoDetect: boolean;

  /** Tool schema simplification to prevent grammar explosion. */
  toolSchemaSimplification: {
    /** Enable tool schema simplification. Default: true. */
    enabled: boolean;
    /** Maximum nesting depth before flattening to string. Default: 2. */
    maxDepth: number;
    /** Maximum properties per object level. Default: 12. */
    maxPropertiesPerLevel: number;
  };

  /** Health check configuration. */
  healthCheck: {
    /** Enable periodic health monitoring. Default: true. */
    enabled: boolean;
    /** Health check interval in milliseconds. Default: 10000. */
    intervalMs: number;
    /** Health check timeout in milliseconds. Default: 3000. */
    timeoutMs: number;
  };
};

export type ResolvedLlamaServerConfig = Required<LlamaServerConfig>;

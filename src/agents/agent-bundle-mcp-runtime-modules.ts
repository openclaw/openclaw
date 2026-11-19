import { createLazyImportLoader } from "../shared/lazy-promise.js";

export const loadBundleMcpRuntimeModules = createLazyImportLoader(async () => {
  const [
    client,
    catalog,
    elicitation,
    lifecycle,
    errors,
    validator,
    transport,
    nativeConnect,
    nativeClient,
  ] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("./agent-bundle-mcp-catalog-projection.js"),
    import("./mcp-client-elicitation.runtime.js"),
    import("./mcp-client-lifecycle.js"),
    import("./mcp-error.js"),
    import("./mcp-json-schema-validator.js"),
    import("./mcp-transport.js"),
    import("./native-mcp-connect.js"),
    import("./native-mcp-runtime-client.js"),
  ]);
  return {
    client,
    catalog,
    elicitation,
    lifecycle,
    errors,
    validator,
    transport,
    nativeConnect,
    nativeClient,
  };
}).load;

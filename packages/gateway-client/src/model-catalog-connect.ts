import type { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import type { GATEWAY_SERVER_CAPS, ConnectParams } from "@openclaw/gateway-protocol/frame-guards";

const MODEL_CATALOG_SNAPSHOT: typeof GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT =
  "model-catalog-snapshot" satisfies typeof GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT;

/** A requested snapshot opts in only after the server advertises its connect field. */
export function resolveModelCatalogConnect(params: {
  modelCatalog?: ConnectParams["modelCatalog"];
  caps?: readonly string[];
  serverCapabilities: readonly string[];
}): Pick<ConnectParams, "modelCatalog" | "caps"> {
  const modelCatalog = params.serverCapabilities.includes(MODEL_CATALOG_SNAPSHOT)
    ? params.modelCatalog
    : undefined;
  const caps = params.caps?.filter((cap) => cap !== MODEL_CATALOG_SNAPSHOT);
  if (modelCatalog === undefined) {
    return { caps };
  }
  return { modelCatalog, caps: [...(caps ?? []), MODEL_CATALOG_SNAPSHOT] };
}

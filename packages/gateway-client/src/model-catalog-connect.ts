import { GATEWAY_CLIENT_CAPS } from "@openclaw/gateway-protocol/client-info";
import { GATEWAY_SERVER_CAPS, type ConnectParams } from "@openclaw/gateway-protocol/frame-guards";

/** A requested snapshot opts in only after the server advertises its connect field. */
export function resolveModelCatalogConnect(params: {
  modelCatalog?: ConnectParams["modelCatalog"];
  caps?: readonly string[];
  serverCapabilities: readonly string[];
}): Pick<ConnectParams, "modelCatalog" | "caps"> {
  const modelCatalog = params.serverCapabilities.includes(
    GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT,
  )
    ? params.modelCatalog
    : undefined;
  const caps = params.caps?.filter((cap) => cap !== GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT);
  if (modelCatalog === undefined) {
    return { caps };
  }
  return { modelCatalog, caps: [...(caps ?? []), GATEWAY_CLIENT_CAPS.MODEL_CATALOG_SNAPSHOT] };
}

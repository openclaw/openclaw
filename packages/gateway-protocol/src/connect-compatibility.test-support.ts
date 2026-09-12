import { lazyCompile } from "./protocol-validator.js";
import { ConnectParamsSchema } from "./schema/frames.js";

// The preceding protocol-4 connect contract has every retained field and rejects
// the newly negotiated catalog target through its closed-object validator.
const { modelCatalog: _modelCatalog, ...previousProperties } = ConnectParamsSchema.properties;

export const validatePreviousConnectParams = lazyCompile({
  ...ConnectParamsSchema,
  properties: previousProperties,
});

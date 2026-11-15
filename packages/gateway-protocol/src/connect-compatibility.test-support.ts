import { Check } from "typebox/schema";
import { createProtocolValidator } from "./protocol-validator.js";
import { ConnectParamsSchema } from "./schema/frames.js";

// The preceding protocol-4 connect contract has every retained field and rejects
// the newly negotiated catalog target through its closed-object validator.
const { modelCatalog: _modelCatalog, ...previousProperties } = ConnectParamsSchema.properties;

const previousSchema = {
  ...ConnectParamsSchema,
  properties: previousProperties,
};
export const validatePreviousConnectParams = createProtocolValidator(previousSchema, (value) =>
  Check(previousSchema, value),
);

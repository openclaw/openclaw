import { t as JsonSchemaObject } from "./json-schema.types-fpZiub1R.js";

//#region src/channels/plugins/types.config.d.ts
type ChannelConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};
type ChannelConfigRuntimeIssue = {
  path?: Array<string | number>;
  message?: string;
  code?: string;
} & Record<string, unknown>;
type ChannelConfigRuntimeParseResult = {
  success: true;
  data: unknown;
} | {
  success: false;
  issues: ChannelConfigRuntimeIssue[];
};
type ChannelConfigRuntimeSchema = {
  safeParse: (value: unknown) => ChannelConfigRuntimeParseResult;
};
type ChannelConfigSchema = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
};
//#endregion
export { ChannelConfigSchema as n, ChannelConfigUiHint as r, ChannelConfigRuntimeSchema as t };
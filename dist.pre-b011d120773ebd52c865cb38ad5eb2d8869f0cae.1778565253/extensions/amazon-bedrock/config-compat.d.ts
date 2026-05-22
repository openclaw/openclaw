//#region extensions/amazon-bedrock/config-compat.d.ts
declare function migrateAmazonBedrockLegacyConfig<T>(raw: T): {
  config: T;
  changes: string[];
};
//#endregion
export { migrateAmazonBedrockLegacyConfig };
//#region extensions/amazon-bedrock/aws-credential-refresh.d.ts
type SharedIniFileLoader = {
  loadSharedConfigFiles(init?: {
    ignoreCache?: boolean;
  }): Promise<unknown>;
};
declare function shouldRefreshAwsSharedConfigCacheForBedrock(env: NodeJS.ProcessEnv): boolean;
declare function refreshAwsSharedConfigCacheForBedrock(env?: NodeJS.ProcessEnv): Promise<void>;
declare function setAwsSharedIniFileLoaderForTest(loader: SharedIniFileLoader | null | undefined): void;
//#endregion
export { refreshAwsSharedConfigCacheForBedrock, setAwsSharedIniFileLoaderForTest, shouldRefreshAwsSharedConfigCacheForBedrock };
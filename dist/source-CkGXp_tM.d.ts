//#region extensions/migrate-hermes/source.d.ts
type HermesSource = {
  root: string;
  configPath?: string;
  envPath?: string;
  soulPath?: string;
  agentsPath?: string;
  memoryPath?: string;
  userPath?: string;
  skillsDir?: string;
  archivePaths: HermesArchivePath[];
};
type HermesArchivePath = {
  id: string;
  path: string;
  relativePath: string;
};
declare function discoverHermesSource(input?: string): Promise<HermesSource>;
declare function hasHermesSource(source: HermesSource): boolean;
//#endregion
export { discoverHermesSource as n, hasHermesSource as r, HermesSource as t };
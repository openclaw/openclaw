//#region src/infra/scp-host.d.ts
declare function normalizeScpRemoteHost(value: string | null | undefined): string | undefined;
declare function isSafeScpRemoteHost(value: string | null | undefined): boolean;
declare function normalizeScpRemotePath(value: string | null | undefined): string | undefined;
declare function isSafeScpRemotePath(value: string | null | undefined): boolean;
//#endregion
export { normalizeScpRemotePath as i, isSafeScpRemotePath as n, normalizeScpRemoteHost as r, isSafeScpRemoteHost as t };
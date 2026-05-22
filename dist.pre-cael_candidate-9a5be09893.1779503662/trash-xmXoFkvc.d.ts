//#region node_modules/@openclaw/fs-safe/dist/trash.d.ts
type MovePathToTrashOptions = {
  allowedRoots?: Iterable<string>;
};
declare function movePathToTrash(targetPath: string, options?: MovePathToTrashOptions): Promise<string>;
//#endregion
export { movePathToTrash as n, MovePathToTrashOptions as t };
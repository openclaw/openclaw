export type MovePathToTrashOptions = {
    allowedRoots?: Iterable<string>;
};
export declare function movePathToTrash(targetPath: string, options?: MovePathToTrashOptions): Promise<string>;

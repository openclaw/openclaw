//#region src/shared/text/auto-linked-file-ref.d.ts
declare const FILE_REF_EXTENSIONS_WITH_TLD: Set<string>;
declare function isAutoLinkedFileRef(href: string, label: string): boolean;
//#endregion
export { isAutoLinkedFileRef as n, FILE_REF_EXTENSIONS_WITH_TLD as t };
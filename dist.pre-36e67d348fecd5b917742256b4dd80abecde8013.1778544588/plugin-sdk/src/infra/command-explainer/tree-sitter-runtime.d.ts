import * as TreeSitter from "web-tree-sitter";
export declare function resolvePackageFileForCommandExplanation(packageName: string, fileName: string): string;
export declare function getBashParserForCommandExplanation(): Promise<TreeSitter.Parser>;
export declare function setBashParserLoaderForCommandExplanationForTest(loader?: () => Promise<TreeSitter.Parser>): void;
/**
 * Low-level parser access for tests and parser diagnostics.
 * Callers own the returned Tree and must call tree.delete().
 * Prefer explainShellCommand for normal command-explainer use.
 */
export declare function parseBashForCommandExplanation(source: string): Promise<TreeSitter.Tree>;

/**
 * On Windows, Node's ESM loader requires absolute paths to be expressed as
 * file:// URLs. Raw drive-letter paths like C:\... are parsed as URL schemes.
 */
export declare function toSafeImportPath(specifier: string): string;

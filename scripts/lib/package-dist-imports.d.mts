export type PackageDistImport = { importerPath: string; importedPath: string; kind?: "require" };
export type PackageDistImportOccurrence = {
  importerPath: string;
  kind: "static-import" | "static-export" | "dynamic-import" | "require" | "import-meta-url";
  /** UTF-16 offsets in preparePackageDistJavaScript's output, not byte offsets or source TS. */
  start: number;
  end: number;
  specifier?: string;
  /** Present only for an edge admitted by the existing packaging collector. */
  importedPath?: string;
};

export function preparePackageDistJavaScript(file: string, source: string): string;

export function collectPackageDistImportErrors(
  params: { files: readonly string[]; packageJsons?: ReadonlyMap<string, string> } & (
    | {
        readText: (relativePath: string) => string;
        imports?: readonly PackageDistImport[];
      }
    | {
        imports: readonly PackageDistImport[];
        readText?: (relativePath: string) => string;
      }
  ),
): string[];

export function collectPackageDistImports(params: {
  files: readonly string[];
  packageJsons?: ReadonlyMap<string, string>;
  readText: (relativePath: string) => string;
  includeTypeScript?: boolean;
  onStaticImport?: (specifier: string) => void;
  onLiteralCall?: (specifier: string) => void;
  onImportOccurrence?: (occurrence: PackageDistImportOccurrence) => void;
}): PackageDistImport[];

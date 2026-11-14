export type PackageDistImport = { importerPath: string; importedPath: string; kind?: "require" };

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
}): PackageDistImport[];

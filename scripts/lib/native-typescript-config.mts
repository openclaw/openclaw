import fs from "node:fs";
import path from "node:path";
import { API, type Diagnostic } from "typescript/unstable/sync";
import { createDeclarationFileSystem } from "./native-declaration-filesystem.mts";
import { formatNativeTypeScriptDiagnostics } from "./native-typescript-diagnostics.mts";

/** Read config roots/options without loading their semantic source graph. */
export function readNativeTypeScriptConfig(options: {
  cwd: string;
  configFileName: string;
  readFile?: (file: string) => string | null;
  assertInput?: (file: string) => string;
}) {
  const cwd = path.resolve(options.cwd);
  const configFileName = path.resolve(cwd, options.configFileName);
  const contents = new Map<string, string>();
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const view = options.assertInput
    ? createDeclarationFileSystem(cwd, options.assertInput, new Map())
    : undefined;
  let readFailure: Error | undefined;
  const assertValid = () => {
    view?.assertValid();
    if (readFailure !== undefined) {
      throw readFailure;
    }
  };
  let parsing = true;
  const api = new API({
    cwd,
    fs: {
      ...view?.filesystem,
      readFile(file) {
        if (view && !view.filesystem.fileExists(file)) {
          return null;
        }
        const cached = contents.get(file);
        if (cached !== undefined) {
          return cached;
        }
        // Native config diagnostics require a project. Source bodies cannot affect
        // this query; retaining real existence/discovery still preserves its roots.
        if (!parsing && !file.endsWith(".json")) {
          return "";
        }
        try {
          const text = readFile(file);
          if (text !== null) {
            contents.set(file, text);
          }
          return text;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
          ) {
            return null;
          }
          readFailure ??= error instanceof Error ? error : new Error(String(error));
          return null;
        }
      },
    },
  });
  try {
    const parsed = api.parseConfigFile(configFileName);
    assertValid();
    const syntax = api.readConfigFile(configFileName);
    assertValid();
    const configFiles = [...contents.keys()].toSorted();
    let diagnostics: readonly Diagnostic[] = parsed.errors;
    if (syntax.error) {
      // Parsed options omit root JSON syntax errors; readConfigFile reports only
      // the first. Open a project only for the complete malformed-config report.
      parsing = false;
      const snapshot = api.updateSnapshot({ openProjects: [configFileName] });
      assertValid();
      const project = snapshot.getProject(configFileName);
      if (!project) {
        throw new Error(`Native TypeScript did not open config ${configFileName}`);
      }
      diagnostics = project.program.getConfigFileParsingDiagnostics();
      assertValid();
    }
    if (diagnostics.length) {
      throw new Error(
        `Invalid TypeScript config ${configFileName}:\n${formatNativeTypeScriptDiagnostics(diagnostics)}`,
      );
    }
    return { ...parsed, configFiles };
  } catch (error) {
    assertValid();
    throw error;
  } finally {
    api.close();
  }
}

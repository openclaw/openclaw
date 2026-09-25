import fs from "node:fs";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { formatNativeTypeScriptDiagnostics } from "./native-typescript-diagnostics.mts";

/** Read config roots/options without loading their semantic source graph. */
export function readNativeTypeScriptConfig(options: {
  cwd: string;
  configFileName: string;
  readFile?: (file: string) => string | null;
}) {
  const cwd = path.resolve(options.cwd);
  const configFileName = path.resolve(cwd, options.configFileName);
  const contents = new Map<string, string>();
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  let parsing = true;
  const api = new API({
    cwd,
    fs: {
      readFile(file) {
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
          throw error;
        }
      },
    },
  });
  try {
    const parsed = api.parseConfigFile(configFileName);
    const configFiles = [...contents.keys()].toSorted();
    parsing = false;
    const snapshot = api.updateSnapshot({ openProjects: [configFileName] });
    const project = snapshot.getProject(configFileName);
    if (!project) {
      throw new Error(`Native TypeScript did not open config ${configFileName}`);
    }
    const diagnostics = project.program.getConfigFileParsingDiagnostics();
    if (diagnostics.length) {
      throw new Error(
        `Invalid TypeScript config ${configFileName}:\n${formatNativeTypeScriptDiagnostics(diagnostics)}`,
      );
    }
    return { ...parsed, configFiles };
  } finally {
    api.close();
  }
}

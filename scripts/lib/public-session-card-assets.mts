import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";

/** Package the same font assets for production and compiled test workers. */
export function createPublicSessionCardAssetsPlugin(
  rootDir = process.cwd(),
  recordInput?: (file: string) => void,
): TsdownPlugin {
  const runtimePath = fs.realpathSync(
    path.resolve(rootDir, "src/gateway/control-ui-public-session-card-render.ts"),
  );
  const assetDirectory = path.resolve(rootDir, "src/gateway/assets/session-card");
  const fonts = [
    "Lato-Regular.ttf",
    "Lato-Bold.ttf",
    "InstrumentSerif-Regular.ttf",
    "IBMPlexMono-Regular.ttf",
  ];
  return {
    name: "openclaw:public-session-card-assets",
    transform(code, id) {
      if (path.normalize(id) !== runtimePath) {
        return undefined;
      }
      let transformed = code;
      for (const font of fonts) {
        const reference = new RegExp(
          `new URL\\(\\s*["']\\./assets/session-card/${font.replaceAll(".", "\\.")}["']\\s*,\\s*import\\.meta\\.url\\s*\\)`,
          "u",
        );
        if (!reference.test(transformed)) {
          this.error(`Session card font reference changed: ${font}`);
        }
        const fontPath = path.join(assetDirectory, font);
        recordInput?.(fontPath);
        this.addWatchFile(fontPath);
        const asset = this.emitFile({
          type: "asset",
          fileName: `assets/session-card/${font}`,
          source: fs.readFileSync(fontPath),
        });
        transformed = transformed.replace(
          reference,
          `new URL(import.meta.ROLLUP_FILE_URL_${asset})`,
        );
      }
      for (const license of ["Lato-OFL.txt", "InstrumentSerif-OFL.txt", "IBMPlexMono-OFL.txt"]) {
        const licensePath = path.join(assetDirectory, license);
        recordInput?.(licensePath);
        this.addWatchFile(licensePath);
        this.emitFile({
          type: "asset",
          fileName: `assets/session-card/${license}`,
          source: fs.readFileSync(licensePath),
        });
      }
      return { code: transformed, map: null };
    },
  };
}

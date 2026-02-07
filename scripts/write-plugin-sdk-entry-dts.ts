import fs from "node:fs";
import path from "node:path";

// `tsc` emits the entry d.ts at `dist/plugin-sdk/plugin-sdk/index.d.ts` because
// the source lives at `src/plugin-sdk/index.ts` and `rootDir` is `src/`.
// Keep a stable `dist/plugin-sdk/index.d.ts` alongside `index.js` for TS users.
const out = path.join(process.cwd(), "dist/plugin-sdk/index.d.ts");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, 'export * from "./plugin-sdk/index";\n', "utf8");

import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";

// 外部依赖，不打包进 bundle
const external = [/^openclaw\/plugin-sdk(\/|$)/, /^@sinclair\/typebox(\/|$)/, "ws", /^node:/];

export default [
  // CJS 输出
  {
    input: "index.ts",
    output: {
      dir: "dist/cjs",
      format: "cjs",
      sourcemap: true,
      exports: "named",
      preserveModules: true,
      preserveModulesRoot: ".",
      entryFileNames: "[name].js",
    },
    external,
    plugins: [
      resolve({ preferBuiltins: true }),
      commonjs(),
      json(),
      typescript({
        tsconfig: "./tsconfig.json",
        outDir: "./dist/cjs",
        declaration: false,
        declarationDir: undefined,
      }),
    ],
  },
  // ESM 输出
  {
    input: "index.ts",
    output: {
      dir: "dist/esm",
      format: "esm",
      sourcemap: true,
      preserveModules: true,
      preserveModulesRoot: ".",
      entryFileNames: "[name].js",
    },
    external,
    plugins: [
      resolve({ preferBuiltins: true }),
      commonjs(),
      json(),
      typescript({
        tsconfig: "./tsconfig.json",
        outDir: "./dist/esm",
        declaration: true,
        declarationDir: "./dist/esm/types",
      }),
    ],
  },
  // 类型声明文件合并
  {
    input: "dist/esm/types/index.d.ts",
    output: [{ file: "dist/index.d.ts", format: "esm" }],
    external,
    plugins: [dts()],
  },
];

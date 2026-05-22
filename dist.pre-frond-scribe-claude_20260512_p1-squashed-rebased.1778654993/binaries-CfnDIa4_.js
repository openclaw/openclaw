import { n as defaultRuntime } from "./runtime-E6YfuGL9.js";
import { i as runExec } from "./exec-_AwQ7u-A.js";
//#region src/infra/binaries.ts
async function ensureBinary(name, exec = runExec, runtime = defaultRuntime) {
	await exec("which", [name]).catch(() => {
		runtime.error(`Missing required binary: ${name}. Please install it.`);
		runtime.exit(1);
	});
}
//#endregion
export { ensureBinary as t };

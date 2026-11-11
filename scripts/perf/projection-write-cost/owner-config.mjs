import { pathToFileURL } from "node:url";
const { resolveSandboxDependencyStore } = await import(pathToFileURL(process.argv[2]).href);
process.stdout.write(JSON.stringify(resolveSandboxDependencyStore({ tmpfs: [], env: {} })));

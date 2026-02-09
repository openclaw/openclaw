import { loadConfig } from "../dist/config/load.js";
import { loadOpenClawPlugins } from "../dist/plugins/loader.js";

const cfg = loadConfig();
const registry = loadOpenClawPlugins({ config: cfg });

console.log("Registered gateway methods:");
const methods = Object.keys(registry.gatewayHandlers);
console.log(methods.length > 0 ? methods : "(none)");

console.log("\nPlugin records with gateway methods:");
for (const plugin of registry.plugins) {
  if (plugin.gatewayMethods.length > 0) {
    console.log(`  ${plugin.id}: [${plugin.gatewayMethods.join(", ")}]`);
  }
}

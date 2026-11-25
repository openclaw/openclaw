import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Isolated native modules; bundled Workboard supplies the production static-asset route. */
export function seedWarmReloadPlugins(stateDir: string) {
  const plugins = [
    {
      id: "reload-proof-theme",
      capabilities: ["accessory"],
      source: `export default { id: "reload-proof-theme", activate(host) {
        performance.mark("warm-reload-plugin:theme:start");
        host.ui.registerAccessory({id: "theme", placement: "session-header", mount(container) {
          const node = document.createElement("span"); node.className = "reload-proof-theme";
          container.append(node); return {dispose() {node.remove();}};
        }});
        performance.mark("warm-reload-plugin:theme:activated");
      }};`,
      style: ":root { --reload-proof-theme: 1; } .reload-proof-theme { display: contents; }",
    },
    {
      id: "reload-proof-board",
      capabilities: ["page", "navigation", "panel", "accessory", "widget", "replacement"],
      source: `export default { id: "reload-proof-board", async activate(host) {
        performance.mark("warm-reload-plugin:board:start");
        const [{page}, {mount}] = await Promise.all([import("./chunk-1.js"), import("./chunk-2.js")]);
        host.ui.registerPage(page);
        host.ui.registerNavigation({id: "board", label: "Synthetic board", page: {id: "board"}, defaultVisible: false});
        host.ui.registerPanel({id: "inspector", label: "Synthetic inspector", mount});
        host.ui.registerAccessory({id: "linked-card", placement: "session-header", mount});
        host.ui.registerWidget({id: "card", label: "Synthetic card", mount});
        host.ui.registerReplacement({id: "transcript", label: "Synthetic transcript", surface: "transcript", mount});
        performance.mark("warm-reload-plugin:board:activated");
      }};`,
      style: ".reload-proof-board { display: contents; }",
    },
  ];
  const roots = plugins.map(({ id, capabilities, source, style }) => {
    const root = path.join(stateDir, "proof-plugins", id);
    const browser = path.join(root, "dist", "control-ui");
    mkdirSync(browser, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: id,
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.mjs"] },
      }),
    );
    writeFileSync(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        name: id,
        activation: { onStartup: true },
        uiCapabilities: capabilities,
        controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/index.css"] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    writeFileSync(
      path.join(root, "index.mjs"),
      `export default {id: ${JSON.stringify(id)}, register() {}};`,
    );
    writeFileSync(path.join(browser, "index.js"), source);
    writeFileSync(path.join(browser, "index.css"), style);
    writeFileSync(
      path.join(browser, "chunk-1.js"),
      `
      performance.mark("warm-reload-plugin:board:chunk-1");
      export const page = {id: "board", label: "Synthetic board", mount(container) {
        const node = document.createElement("h1"); node.textContent = "Synthetic board";
        container.append(node); return {dispose() {node.remove();}};
      }};`,
    );
    writeFileSync(
      path.join(browser, "chunk-2.js"),
      `
      performance.mark("warm-reload-plugin:board:chunk-2");
      export function mount(container) {
        const node = document.createElement("span"); node.className = "reload-proof-board";
        container.append(node); return {dispose() {node.remove();}};
      }`,
    );
    return root;
  });
  return { roots, ids: ["workboard", ...plugins.map(({ id }) => id)] };
}

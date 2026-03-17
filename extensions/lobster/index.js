import { createLobsterTool } from "./src/lobster-tool.js";
function register(api) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api);
    }),
    { optional: true }
  );
}
export {
  register as default
};

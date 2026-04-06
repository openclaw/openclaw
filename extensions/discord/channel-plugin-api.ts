// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broad Discord API barrel into lightweight plugin loads.
export { discordPlugin } from "./src/channel.js";
export { discordSetupPlugin } from "./src/channel.setup.js";

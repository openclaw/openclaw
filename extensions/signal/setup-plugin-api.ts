// Keep bundled setup entry imports narrow so setup loads do not pull the
// broader Signal channel plugin surface.
export { signalSetupPlugin } from "./src/channel.setup.js";

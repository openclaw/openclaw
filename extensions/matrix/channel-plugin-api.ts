// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag Matrix setup and onboarding helpers into lightweight plugin loads.
export { matrixPlugin } from "./src/channel.js";

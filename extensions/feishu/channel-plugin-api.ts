// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broad Feishu API barrel into lightweight plugin loads.
export { feishuPlugin } from "./src/channel.js";

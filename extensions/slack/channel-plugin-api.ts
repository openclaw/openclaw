// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broad Slack API barrel into lightweight plugin loads.
export { slackPlugin } from "./src/channel.js";
export { slackSetupPlugin } from "./src/channel.setup.js";

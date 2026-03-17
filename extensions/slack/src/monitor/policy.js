import { evaluateGroupRouteAccessForPolicy } from "../../../../src/plugin-sdk/group-access.js";
function isSlackChannelAllowedByPolicy(params) {
  return evaluateGroupRouteAccessForPolicy({
    groupPolicy: params.groupPolicy,
    routeAllowlistConfigured: params.channelAllowlistConfigured,
    routeMatched: params.channelAllowed
  }).allowed;
}
export {
  isSlackChannelAllowedByPolicy
};

import { WebClient } from "@slack/web-api";
const SLACK_DEFAULT_RETRY_OPTIONS = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3e3,
  randomize: true
};
function resolveSlackWebClientOptions(options = {}) {
  return {
    ...options,
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS
  };
}
function createSlackWebClient(token, options = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}
export {
  SLACK_DEFAULT_RETRY_OPTIONS,
  createSlackWebClient,
  resolveSlackWebClientOptions
};

export { inspectGog, inspectGogUpgrade, upgradeGog, type GogInspection } from "./src/gmail-gog.js";
export {
  ensureDependency,
  ensureGcloudAuth,
  ensureSubscription,
  ensureTailscaleEndpoint,
  ensureTopic,
  resolveProjectIdFromGogCredentials,
  runGcloud,
} from "./src/gmail-setup-utils.js";
export { startGmailWatcherService, stopGmailWatcher } from "./src/gmail-watcher.js";

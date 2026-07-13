/**
 * Playwright-backed browser helper barrel.
 *
 * Re-exports session and action helpers used by browser routes when Playwright
 * is available for managed or CDP-backed profiles.
 */
import { markPwAiLoaded } from "./pw-ai-state.js";

markPwAiLoaded();

export {
  closePageByTargetIdViaPlaywright,
  retirePlaywrightBrowserConnectionExact,
  createPageViaPlaywright,
  focusPageByTargetIdViaPlaywright,
  getObservedBrowserStateViaPlaywright,
  getPageForTargetId,
  listPagesViaPlaywright,
} from "./pw-session.js";

export {
  armDialogViaPlaywright,
  armFileUploadViaPlaywright,
  cookiesClearViaPlaywright,
  cookiesGetViaPlaywright,
  cookiesSetManyViaPlaywright,
  cookiesSetViaPlaywright,
  downloadViaPlaywright,
  emulateMediaViaPlaywright,
  executeActViaPlaywright,
  getConsoleMessagesViaPlaywright,
  getNetworkRequestsViaPlaywright,
  getPageErrorsViaPlaywright,
  highlightViaPlaywright,
  navigateViaPlaywright,
  pdfViaPlaywright,
  responseBodyViaPlaywright,
  setDeviceViaPlaywright,
  setExtraHTTPHeadersViaPlaywright,
  setGeolocationViaPlaywright,
  setHttpCredentialsViaPlaywright,
  setInputFilesViaPlaywright,
  setLocaleViaPlaywright,
  setOfflineViaPlaywright,
  setTimezoneViaPlaywright,
  snapshotAiViaPlaywright,
  snapshotAriaViaPlaywright,
  snapshotRoleViaPlaywright,
  storeAriaSnapshotRefsViaPlaywright,
  screenshotWithLabelsViaPlaywright,
  storageClearViaPlaywright,
  storageGetViaPlaywright,
  storageSetViaPlaywright,
  takeScreenshotViaPlaywright,
  traceStartViaPlaywright,
  traceStopViaPlaywright,
  uploadViaPlaywright,
  waitForDownloadViaPlaywright,
} from "./pw-tools-core.js";

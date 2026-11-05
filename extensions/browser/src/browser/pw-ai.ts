/** Playwright-backed browser helpers loaded as one optional runtime object. */
import * as session from "./pw-session.js";
import * as activity from "./pw-tools-core.activity.js";
import * as downloads from "./pw-tools-core.downloads.js";
import * as interactionActions from "./pw-tools-core.interactions.actions.js";
import * as interactionContent from "./pw-tools-core.interactions.content.js";
import * as interactionExecution from "./pw-tools-core.interactions.execution.js";
import * as responses from "./pw-tools-core.responses.js";
import * as snapshot from "./pw-tools-core.snapshot.js";
import * as state from "./pw-tools-core.state.js";
import * as storage from "./pw-tools-core.storage.js";
import * as trace from "./pw-tools-core.trace.js";

export const pwAi = {
  downloadCurrentDocumentViaPlaywright: downloads.downloadCurrentDocumentViaPlaywright,
  closePageByTargetIdViaPlaywright: session.closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection: session.closePlaywrightBrowserConnection,
  retirePlaywrightBrowserConnectionExact: session.retirePlaywrightBrowserConnectionExact,
  createPageViaPlaywright: session.createPageViaPlaywright,
  focusPageByTargetIdViaPlaywright: session.focusPageByTargetIdViaPlaywright,
  getObservedBrowserStateViaPlaywright: session.getObservedBrowserStateViaPlaywright,
  getDocumentIdentitiesViaPlaywright: session.getDocumentIdentitiesViaPlaywright,
  getPageForTargetId: session.getPageForTargetId,
  hasCachedPlaywrightBrowserConnection: session.hasCachedPlaywrightBrowserConnection,
  listPagesViaPlaywright: session.listPagesViaPlaywright,
  armDialogViaPlaywright: downloads.armDialogViaPlaywright,
  armFileUploadViaPlaywright: downloads.armFileUploadViaPlaywright,
  cookiesClearViaPlaywright: storage.cookiesClearViaPlaywright,
  cookiesGetViaPlaywright: storage.cookiesGetViaPlaywright,
  cookiesSetManyViaPlaywright: storage.cookiesSetManyViaPlaywright,
  cookiesSetViaPlaywright: storage.cookiesSetViaPlaywright,
  downloadViaPlaywright: downloads.downloadViaPlaywright,
  emulateMediaViaPlaywright: state.emulateMediaViaPlaywright,
  executeActViaPlaywright: interactionExecution.executeActViaPlaywright,
  getConsoleMessagesViaPlaywright: activity.getConsoleMessagesViaPlaywright,
  getNetworkRequestsViaPlaywright: activity.getNetworkRequestsViaPlaywright,
  getPageErrorsViaPlaywright: activity.getPageErrorsViaPlaywright,
  getPageTextViaPlaywright: activity.getPageTextViaPlaywright,
  highlightViaPlaywright: interactionActions.highlightViaPlaywright,
  navigateViaPlaywright: snapshot.navigateViaPlaywright,
  pdfViaPlaywright: snapshot.pdfViaPlaywright,
  responseBodyViaPlaywright: responses.responseBodyViaPlaywright,
  setDeviceViaPlaywright: state.setDeviceViaPlaywright,
  setExtraHTTPHeadersViaPlaywright: state.setExtraHTTPHeadersViaPlaywright,
  setGeolocationViaPlaywright: state.setGeolocationViaPlaywright,
  setHttpCredentialsViaPlaywright: state.setHttpCredentialsViaPlaywright,
  setInputFilesViaPlaywright: interactionContent.setInputFilesViaPlaywright,
  setLocaleViaPlaywright: state.setLocaleViaPlaywright,
  setOfflineViaPlaywright: state.setOfflineViaPlaywright,
  setTimezoneViaPlaywright: state.setTimezoneViaPlaywright,
  snapshotAriaViaPlaywright: snapshot.snapshotAriaViaPlaywright,
  snapshotRoleViaPlaywright: snapshot.snapshotRoleViaPlaywright,
  storeSnapshotRefsViaPlaywright: snapshot.storeSnapshotRefsViaPlaywright,
  screenshotWithLabelsViaPlaywright: interactionContent.screenshotWithLabelsViaPlaywright,
  storageClearViaPlaywright: storage.storageClearViaPlaywright,
  storageGetViaPlaywright: storage.storageGetViaPlaywright,
  storageSetViaPlaywright: storage.storageSetViaPlaywright,
  takeScreenshotViaPlaywright: interactionContent.takeScreenshotViaPlaywright,
  traceStartViaPlaywright: trace.traceStartViaPlaywright,
  traceStopViaPlaywright: trace.traceStopViaPlaywright,
  uploadViaPlaywright: downloads.uploadViaPlaywright,
  waitForDownloadViaPlaywright: downloads.waitForDownloadViaPlaywright,
};

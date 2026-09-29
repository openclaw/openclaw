import type { SessionEntryCurrentCheck } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getBrowserStateRuntime,
  getOptionalBrowserStateRuntime,
  type BrowserDashboardRegistration,
  type BrowserStateRuntime,
} from "../browser-runtime-state.js";

export type BrowserSessionTabAuthority = {
  runtime?: BrowserStateRuntime;
  assertCurrent?: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
  dashboardRegistration?: BrowserDashboardRegistration;
};

export function assertBrowserSessionTabAuthority(authority: BrowserSessionTabAuthority) {
  const runtime = authority.runtime ?? getBrowserStateRuntime();
  if (getOptionalBrowserStateRuntime() !== runtime) {
    throw new Error("Browser session tab store owner changed");
  }
  authority.assertCurrent?.();
}

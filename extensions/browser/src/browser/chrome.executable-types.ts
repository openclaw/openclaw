/** Browser executable candidate with product metadata and filesystem path. */
export type BrowserExecutable = {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
};

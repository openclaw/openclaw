import { vi } from "vitest";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";

const chromeUserDataDir = { dir: "/tmp/mullusi" };
installChromeUserDataDirHooks(chromeUserDataDir);

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchMullusiChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveMullusiUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopMullusiChrome: vi.fn(async () => {}),
}));

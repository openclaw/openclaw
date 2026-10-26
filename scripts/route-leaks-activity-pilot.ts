import type { Page } from "playwright";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { createInteractionFixture } from "./lib/control-ui-interaction-scenarios.ts";

export type ActivityMediaMode = "empty" | "gallery";
export const activityMediaMethods = [
  "artifacts.list",
  "artifacts.download",
  "sessions.activitySummary.ensure",
];
export const activityMediaKey = "agent:main:activity-media-pilot";
export const activityMediaTrigger = "openclaw-activity-session-media .chat-message-image-button";
export const activityLightboxImage = "openclaw-image-lightbox img.image";
const labels = ["Alpha", "Beta"];
// Deterministic solid-color PNGs, generated locally with no user or remote image data.
const pngs = [
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABXUlEQVR4nO3RUQnDAAAD0VMzFZVSFVM0FdVXEV1ICQfvOwSOz/nTMOoPFEX9gaKoP1AU9QeKov5AUdQfKIr6A0VRf6Ao6g8URf2Boqg/UBT1B4qi/kBR1B8oivoDRVF/oCjqDxRF/YGiqD9QFPUHiqL+QFHUHyiK+gNFUX+gKOoPFMV/547vpecMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOMMPM7A4ww8zsDjDDzOwOPeG1hvQ/2Boqg/UBT1B4qi/kBR1B8oivoDRVF/oCjqDxRF/YGiqD9QFPUHiqL+QFHUHyiK+gNFUX+gKOoPFEX9gaKoP1AU9QeKov5AUdQfKIr6A0VRf6Ao6g8UdQOwLTJv+4sYWQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABDUlEQVR4nO3RAQmAMAAAwaUxhRFMYUZTmGohVBzPwQV4+HEdG2Hj9wI+ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkc9/Lg+9x5zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4zuA4g+MMjjM4bt3BrMbgOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOG4C3GksfrDW+10AAAAASUVORK5CYII=",
];

export function activityMediaFixture(
  base: ReturnType<typeof createInteractionFixture>,
  mode: ActivityMediaMode,
) {
  const row = {
    key: activityMediaKey,
    sessionId: "activity-media-pilot-session",
    agentId: "main",
    kind: "direct" as const,
    label: "Activity media pilot",
    updatedAt: 1_800_000_000_000,
    lastActivityAt: 1_800_000_000_000,
    activitySummary: {
      state: "current" as const,
      text: "Synthetic image evidence is ready to inspect.",
      updatedAt: 1_800_000_000_000,
      canEnsure: false,
    },
  };
  const artifacts = labels.map((label) => ({
    id: `activity-media-${label.toLowerCase()}`,
    type: "image",
    title: `Activity pilot ${label}`,
    mimeType: "image/png",
    width: 160,
    height: 100,
    download: { mode: "bytes" },
  }));
  return {
    ...base,
    sessionKey: activityMediaKey,
    sessions: [row],
    methodResponses: {
      ...base.methodResponses,
      "sessions.list": { sessions: [row], count: 1, totalCount: 1, people: [] },
      "artifacts.list": { artifacts: mode === "gallery" ? artifacts : [] },
      "artifacts.download": {
        cases: artifacts.map((artifact, index) => ({
          match: { sessionKey: activityMediaKey, agentId: "main", artifactId: artifact.id },
          response: { artifact, encoding: "base64", data: pngs[index] },
        })),
      },
      "sessions.activitySummary.ensure": { sessions: [row] },
    },
  };
}

export async function waitForActivityMedia(page: Page, mode: ActivityMediaMode) {
  await page.waitForFunction(
    ({ key, mode: mediaMode }) => {
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (
        !gateway?.findRequests("artifacts.list", {
          sessionKey: key,
          agentId: "main",
          type: "image",
        }).length
      ) {
        return false;
      }
      const host = document.querySelector("openclaw-activity-session-media");
      if (!host) {
        return false;
      }
      const buttons = host.querySelectorAll(".chat-message-image-button");
      if (mediaMode === "empty") {
        return buttons.length === 0;
      }
      const images = [...host.querySelectorAll<HTMLImageElement>("img")];
      return (
        buttons.length === 2 &&
        images.length === 2 &&
        images.every((image) => image.complete && image.naturalWidth === 160) &&
        gateway.findRequests("artifacts.download", {
          sessionKey: key,
          agentId: "main",
          previewWidth: 480,
        }).length === 2
      );
    },
    { key: activityMediaKey, mode },
    { polling: "raf" },
  );
}

export async function waitForActivityLightbox(page: Page, title = "Activity pilot Alpha") {
  await page.waitForFunction(
    (expectedTitle) => {
      const image = document.querySelector<HTMLImageElement>("openclaw-image-lightbox img.image");
      return image?.complete && image.naturalWidth === 160 && image.alt === expectedTitle;
    },
    title,
    { polling: "raf" },
  );
}

export async function closeActivityLightbox(page: Page) {
  await page.keyboard.press("Escape");
  await page.locator("openclaw-image-lightbox").waitFor({ state: "detached" });
}

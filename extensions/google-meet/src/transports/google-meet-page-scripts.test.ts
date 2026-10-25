import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";

function fakeButton(label: string) {
  return {
    disabled: false,
    textContent: label,
    click: vi.fn(),
    getAttribute: (name: string) => (name === "aria-label" ? label : null),
  };
}

// Meet's own DOM objects carry circular `__soy` back-references; a linked
// caption node reproduces the live shape that broke status serialization.
function captionRegion(text: string) {
  const region: Record<string, unknown> = { nodeType: 1, textContent: text, innerText: text };
  region["__soy"] = { element: region };
  return region;
}

async function runStatusWithCircularCaptionNode() {
  const leave = fakeButton("Leave call");
  const captions = fakeButton("Turn on captions");
  const buttons = [leave, captions];
  const region = captionRegion("Alex\nHello there");
  const document = {
    body: { textContent: "" },
    title: "Meet",
    querySelector(selector: string) {
      return selector.includes("aption") ? region : null;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") {
        return buttons;
      }
      if (selector === "input") {
        return [];
      }
      if (selector.includes("aption")) {
        return [region];
      }
      return [];
    },
  };
  const window: Record<string, unknown> = {};
  const result = await runInNewContext(
    `(${meetStatusScript({
      allowMicrophone: false,
      autoJoin: false,
      captionSessionId: "session-1",
      captureCaptions: true,
      guestName: "OpenClaw Agent",
    })})()`,
    {
      JSON,
      String,
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
      document,
      location: { href: MEETING_URL, hostname: "meet.google.com" },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      navigator: {},
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
      clearTimeout,
      window,
    },
  );
  return JSON.parse(result) as Record<string, unknown>;
}

describe("meetStatusScript caption serialization", () => {
  it("reports in-call health when caption nodes are circular", async () => {
    const health = await runStatusWithCircularCaptionNode();

    expect(health.inCall).toBe(true);
    expect(health.captioning).toBe(true);
    const recentTranscript = health.recentTranscript as Array<Record<string, unknown>>;
    expect(recentTranscript).toHaveLength(1);
    expect(recentTranscript[0]).toMatchObject({ speaker: "Alex", text: "Hello there" });
    expect(recentTranscript[0]).not.toHaveProperty("node");
    expect(recentTranscript[0]).not.toHaveProperty("seenAt");
  });
});

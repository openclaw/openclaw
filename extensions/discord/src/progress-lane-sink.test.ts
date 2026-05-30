import { createProgressLane } from "openclaw/plugin-sdk/progress-lane";
import type { ProgressLaneConfig } from "openclaw/plugin-sdk/progress-lane";
import { describe, expect, it } from "vitest";
import { discordProgressLaneSinkFromStream } from "./progress-lane-sink.js";

function makeFakeStream() {
  const updates: string[] = [];
  let forced = 0;
  let flushed = 0;
  let stopped = 0;
  let cleared = 0;
  let id: string | undefined;
  return {
    updates,
    forced: () => forced,
    flushed: () => flushed,
    stopped: () => stopped,
    cleared: () => cleared,
    setId: (v: string | undefined) => {
      id = v;
    },
    stream: {
      update: (text: string) => {
        updates.push(text);
      },
      forceNewMessage: () => {
        forced += 1;
      },
      flush: async () => {
        flushed += 1;
      },
      stop: async () => {
        stopped += 1;
      },
      clear: async () => {
        cleared += 1;
      },
      messageId: () => id,
    },
  };
}

const baseConfig: ProgressLaneConfig = {
  enabled: true,
  reasoning: true,
  commentary: false,
  toolRows: true,
  toolArgs: false,
  timer: true,
  timerIntervalMs: 20_000,
};

describe("discordProgressLaneSinkFromStream", () => {
  it("passes the neutral body through unchanged (already Discord markdown)", () => {
    const fake = makeFakeStream();
    const sink = discordProgressLaneSinkFromStream(fake.stream);
    const body = "Thinking\n\nweighing options\n[12:00:00] tool: Bash";
    expect(sink.render(body)).toBe(body);
  });

  it("caps maxChars at the Discord 2000 limit", () => {
    const fake = makeFakeStream();
    expect(discordProgressLaneSinkFromStream(fake.stream, 4096).maxChars).toBe(2000);
    expect(discordProgressLaneSinkFromStream(fake.stream, 800).maxChars).toBe(800);
  });

  it("delegates update/spill/flush/stop/clear to the underlying stream", async () => {
    const fake = makeFakeStream();
    const sink = discordProgressLaneSinkFromStream(fake.stream);
    sink.update("hello");
    sink.spill();
    await sink.flush();
    await sink.stop();
    await sink.clear();
    fake.setId("123");
    expect(fake.updates).toEqual(["hello"]);
    expect(fake.forced()).toBe(1);
    expect(fake.flushed()).toBe(1);
    expect(fake.stopped()).toBe(1);
    expect(fake.cleared()).toBe(1);
    expect(sink.messageId()).toBe("123");
  });

  it("drives a full reasoning + tool turn from the shared engine", () => {
    const fake = makeFakeStream();
    const sink = discordProgressLaneSinkFromStream(fake.stream);
    const lane = createProgressLane({ sink, config: baseConfig, now: () => 1_000_000 });
    lane.onReasoning("checking the model lists");
    lane.onTool("Bash", "ls -la");
    const last = fake.updates.at(-1) ?? "";
    expect(last).toContain("Thinking");
    expect(last).toContain("checking the model lists");
    expect(last).toMatch(/\n\[\d{2}:\d{2}:\d{2}\] tool: Bash/u);
    expect(last).not.toContain("ls -la"); // toolArgs off by default
    lane.dispose();
  });

  it("rolls over via forceNewMessage when the body would outgrow the cap", () => {
    const fake = makeFakeStream();
    const sink = discordProgressLaneSinkFromStream(fake.stream, 120);
    const lane = createProgressLane({ sink, config: baseConfig, now: () => 1_000_000 });
    for (let i = 0; i < 8; i += 1) {
      lane.onReasoning(`${"x".repeat(30)} chunk ${i}\n`.repeat(i + 1));
    }
    expect(fake.forced()).toBeGreaterThan(0);
    for (const u of fake.updates) {
      expect(u.length).toBeLessThanOrEqual(120);
    }
    lane.dispose();
  });
});

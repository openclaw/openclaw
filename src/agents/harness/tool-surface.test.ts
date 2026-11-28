import { expect, it } from "vitest";
import {
  agentHarnessBuildsOpenClawTools,
  agentHarnessExposesOpenClawTools,
} from "./tool-surface.js";

it.each([
  { harness: "openclaw", builds: false, exposes: true },
  { harness: "codex", builds: true, exposes: true },
  { harness: "copilot", builds: true, exposes: true },
  { harness: "custom", builds: false, exposes: false },
])("identifies the $harness tool surface", ({ harness, builds, exposes }) => {
  expect(agentHarnessBuildsOpenClawTools(harness)).toBe(builds);
  expect(agentHarnessExposesOpenClawTools(harness)).toBe(exposes);
});

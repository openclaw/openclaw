import { describe, expect, it } from "vitest";
import { runEmbeddedAgent as runEmbeddedAgentFromNeutralBarrel } from "../embedded-runner.js";
import {
  abortEmbeddedAgentRun as abortEmbeddedAgentRunFromNeutralDirBarrel,
  compactEmbeddedAgentSession as compactEmbeddedAgentSessionFromNeutralDirBarrel,
  runEmbeddedAgent as runEmbeddedAgentFromNeutralDirBarrel,
} from "../embedded-runner/index.js";
import {
  abortEmbeddedAgentRun,
  abortEmbeddedPiRun,
  compactEmbeddedAgentSession,
  compactEmbeddedPiSession,
  runEmbeddedAgent,
  runEmbeddedPiAgent,
} from "../pi-embedded-runner.js";
import {
  abortEmbeddedAgentRun as abortEmbeddedAgentRunFromPiDirBarrel,
  abortEmbeddedPiRun as abortEmbeddedPiRunFromPiDirBarrel,
  compactEmbeddedAgentSession as compactEmbeddedAgentSessionFromPiDirBarrel,
  compactEmbeddedPiSession as compactEmbeddedPiSessionFromPiDirBarrel,
  runEmbeddedAgent as runEmbeddedAgentFromPiDirBarrel,
  runEmbeddedPiAgent as runEmbeddedPiAgentFromPiDirBarrel,
} from "./index.js";

describe("embedded runner compatibility aliases", () => {
  it("keeps neutral embedded-agent aliases bound to the PI compatibility exports", () => {
    expect(runEmbeddedAgent).toBe(runEmbeddedPiAgent);
    expect(runEmbeddedAgentFromNeutralBarrel).toBe(runEmbeddedPiAgent);
    expect(compactEmbeddedAgentSession).toBe(compactEmbeddedPiSession);
    expect(abortEmbeddedAgentRun).toBe(abortEmbeddedPiRun);
  });

  it("keeps neutral and PI directory barrels bound to the same canonical exports", () => {
    // Canonical directory barrel exposes the same neutral functions as the flat barrel.
    expect(runEmbeddedAgentFromNeutralDirBarrel).toBe(runEmbeddedPiAgent);
    expect(compactEmbeddedAgentSessionFromNeutralDirBarrel).toBe(compactEmbeddedPiSession);
    expect(abortEmbeddedAgentRunFromNeutralDirBarrel).toBe(abortEmbeddedPiRun);
    // Deprecated PI directory barrel resolves through the flat PI compatibility barrel.
    expect(runEmbeddedAgentFromPiDirBarrel).toBe(runEmbeddedPiAgent);
    expect(runEmbeddedPiAgentFromPiDirBarrel).toBe(runEmbeddedPiAgent);
    expect(compactEmbeddedAgentSessionFromPiDirBarrel).toBe(compactEmbeddedPiSession);
    expect(compactEmbeddedPiSessionFromPiDirBarrel).toBe(compactEmbeddedPiSession);
    expect(abortEmbeddedAgentRunFromPiDirBarrel).toBe(abortEmbeddedPiRun);
    expect(abortEmbeddedPiRunFromPiDirBarrel).toBe(abortEmbeddedPiRun);
  });
});

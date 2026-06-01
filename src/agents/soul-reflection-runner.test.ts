import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { appendSoulRule } from "./soul-auto-update.js";
import {
  formatSoulReflectionNotice,
  maybeFireSoulReflection,
  testing as runnerTesting,
} from "./soul-reflection-runner.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

const baseCfg = (autoUpdate: boolean): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        soul: { autoUpdate },
      },
    },
  }) as unknown as OpenClawConfig;

let ingressSpy: ReturnType<typeof vi.fn>;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-soul-runner-"));
  ingressSpy = vi.fn().mockResolvedValue({ payloads: [] });
  runnerTesting.setDepsForTest({
    agentCommandFromIngress: ingressSpy as never,
  });
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  runnerTesting.setDepsForTest();
});

describe("maybeFireSoulReflection", () => {
  it("skips with reason=disabled when autoUpdate is false", async () => {
    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(false),
      sessionKey: "session:abc",
      workspaceDir,
      userMessage: "please stop using em-dashes",
      turnsSinceLast: 0,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(ingressSpy).not.toHaveBeenCalled();
  });

  it("skips with reason=disabled when skipSoulReflection is true (recursion guard)", async () => {
    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(true),
      sessionKey: "session:abc",
      workspaceDir,
      userMessage: "please stop using em-dashes",
      turnsSinceLast: 0,
      skipSoulReflection: true,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(ingressSpy).not.toHaveBeenCalled();
  });

  it("skips with reason=no-session when sessionKey is undefined", async () => {
    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(true),
      sessionKey: undefined,
      workspaceDir,
      userMessage: "please stop using em-dashes",
      turnsSinceLast: 0,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no-session" });
    expect(ingressSpy).not.toHaveBeenCalled();
  });

  it("skips with reason=no-trigger on a neutral message under interval threshold", async () => {
    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(true),
      sessionKey: "session:abc",
      workspaceDir,
      userMessage: "ok next file",
      turnsSinceLast: 0,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no-trigger" });
    expect(ingressSpy).not.toHaveBeenCalled();
  });

  it("fires an internal sub-turn with skipSoulReflection=true on a keyword trigger", async () => {
    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(true),
      sessionKey: "session:abc",
      workspaceDir,
      userMessage: "please stop using em-dashes",
      turnsSinceLast: 0,
    });
    expect(outcome).toEqual({ status: "fired", appendedRule: null });
    expect(ingressSpy).toHaveBeenCalledTimes(1);
    const call = ingressSpy.mock.calls[0][0];
    expect(call).toMatchObject({
      sessionKey: "session:abc",
      deliver: false,
      sessionEffects: "internal",
      suppressPromptPersistence: true,
      skipSoulReflection: true,
      allowModelOverride: false,
    });
    expect(call.message).toContain("Reflection sub-turn.");
    expect(call.message).toContain("please stop using em-dashes");
    expect(call.inputProvenance).toEqual({
      kind: "inter_session",
      sourceTool: "soul_reflection",
    });
  });

  it("returns the new appendedRule when the sub-turn caused SOUL.md to grow", async () => {
    await fsp.writeFile(path.join(workspaceDir, DEFAULT_SOUL_FILENAME), "# SOUL.md\n", "utf-8");
    ingressSpy.mockImplementationOnce(async () => {
      await appendSoulRule({
        workspaceDir,
        rule: "Never use em-dashes.",
        evidence: "User asked.",
      });
      return { payloads: [] };
    });

    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(true),
      sessionKey: "session:abc",
      workspaceDir,
      userMessage: "please stop using em-dashes",
      turnsSinceLast: 0,
    });

    expect(outcome).toEqual({ status: "fired", appendedRule: "Never use em-dashes." });
  });

  it("returns status=error and detail when the sub-turn ingress throws", async () => {
    ingressSpy.mockRejectedValueOnce(new Error("simulated ingress failure"));
    const outcome = await maybeFireSoulReflection({
      cfg: baseCfg(true),
      sessionKey: "session:abc",
      workspaceDir,
      userMessage: "please stop using em-dashes",
      turnsSinceLast: 0,
    });
    expect(outcome).toEqual({ status: "error", detail: "simulated ingress failure" });
  });
});

describe("formatSoulReflectionNotice", () => {
  it("wraps the rule in the canonical forced-notice phrasing", () => {
    expect(formatSoulReflectionNotice("Never use em-dashes.")).toBe(
      "Added to SOUL.md: 'Never use em-dashes.'",
    );
  });
});

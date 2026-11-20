import { validateAgentProfile, type AgentProfileResource } from "agentprofiles";
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentProfileExtension } from "./openclaw-extension.js";

function profile(params: { name: string; extension?: unknown }): AgentProfileResource {
  return validateAgentProfile({
    apiVersion: "agentprofiles.io/v1",
    kind: "AgentProfile",
    metadata: { namespace: "openclaw", name: params.name },
    spec: {
      common: {},
      ...(params.extension === undefined ? {} : { "openclaw.ai": params.extension }),
    },
  });
}

describe("OpenClaw Agent Profile extension", () => {
  it("inherits the tool profile from a parent that sets it", () => {
    const resolved = resolveOpenClawAgentProfileExtension([
      {
        id: "openclaw/parent",
        resource: profile({ name: "parent", extension: { toolProfile: "compact" } }),
      },
      {
        id: "openclaw/child",
        resource: profile({ name: "child", extension: {} }),
      },
    ]);

    expect(resolved).toEqual({ toolProfile: "compact" });
  });

  it("deeply inherits workspace context sections", () => {
    const resolved = resolveOpenClawAgentProfileExtension([
      {
        id: "openclaw/parent",
        resource: profile({
          name: "parent",
          extension: {
            prompt: {
              workspaceContext: {
                totalMaxChars: 8_000,
                sections: {
                  identity: { maxChars: 1_024 },
                  soul: { maxChars: 2_000 },
                },
              },
            },
          },
        }),
      },
      {
        id: "openclaw/child",
        resource: profile({
          name: "child",
          extension: {
            prompt: { workspaceContext: { sections: { soul: { include: false } } } },
          },
        }),
      },
    ]);

    expect(resolved?.prompt?.workspaceContext).toEqual({
      totalMaxChars: 8_000,
      sections: {
        identity: { maxChars: 1_024 },
        soul: { maxChars: 2_000, include: false },
      },
    });
  });

  it.each([
    { additional: { files: [{ path: "notes.md" }] } },
    { sections: { identity: { overflow: "error" } } },
  ])("rejects workspace context fields OpenClaw does not own: %j", (workspaceContext) => {
    expect(() =>
      resolveOpenClawAgentProfileExtension([
        {
          id: "openclaw/invalid",
          resource: profile({
            name: "invalid",
            extension: { prompt: { workspaceContext } },
          }),
        },
      ]),
    ).toThrow(/Invalid openclaw\.ai section/s);
  });

  it("rejects unknown workspace context fields", () => {
    expect(() =>
      resolveOpenClawAgentProfileExtension([
        {
          id: "openclaw/invalid",
          resource: profile({
            name: "invalid",
            extension: {
              prompt: { workspaceContext: { tokenLimit: 2_000 } },
            },
          }),
        },
      ]),
    ).toThrow(/Invalid openclaw\.ai section.*tokenLimit/s);
  });

  it("rejects fields that OpenClaw does not own", () => {
    expect(() =>
      resolveOpenClawAgentProfileExtension([
        {
          id: "openclaw/invalid",
          resource: profile({
            name: "invalid",
            extension: { toolProfile: "compact", contextPosture: "compact" },
          }),
        },
      ]),
    ).toThrow(/Invalid openclaw\.ai section.*contextPosture/s);
  });

  it("rejects invalid OpenClaw field values", () => {
    expect(() =>
      resolveOpenClawAgentProfileExtension([
        {
          id: "openclaw/invalid",
          resource: profile({
            name: "invalid",
            extension: { toolProfile: "full" },
          }),
        },
      ]),
    ).toThrow(/Invalid openclaw\.ai section.*toolProfile/s);
  });

  it("returns no extension when the ancestry has none", () => {
    expect(
      resolveOpenClawAgentProfileExtension([
        { id: "openclaw/base", resource: profile({ name: "base" }) },
      ]),
    ).toBeUndefined();
  });
});

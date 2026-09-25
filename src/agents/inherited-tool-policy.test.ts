import { describe, expect, it } from "vitest";
import { emptyDelegatedToolParameterPolicy } from "./inherited-tool-parameters.js";
import {
  assertInheritedToolPolicyCompatible,
  captureInheritedToolPolicy,
  createInheritedToolPolicyMatcher,
} from "./inherited-tool-policy.js";
import {
  conjoinInheritedToolPolicies,
  parseInheritedToolPolicyV2,
} from "./inherited-tool-policy.schema.js";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";

const capture = (params: Omit<Parameters<typeof captureInheritedToolPolicy>[0], "parameters">) =>
  captureInheritedToolPolicy({ ...params, parameters: emptyDelegatedToolParameterPolicy() });

describe("saved action restrictions", () => {
  it("conjoins repeated accepted checkpoints without dropping their independent restrictions", () => {
    const original = captureInheritedToolPolicy({
      policies: [{ deny: ["release_*"] }],
      parameters: {
        ...emptyDelegatedToolParameterPolicy(),
        fileTools: [
          {
            workspaceOnly: true,
            readOnly: true,
            applyPatchEnabled: false,
            applyPatchWorkspaceOnly: true,
            applyPatchAllowModels: null,
          },
        ],
      },
    });
    const incoming = capture({ policies: [], executionAllow: ["read"] });
    const encodedPolicy = JSON.stringify(
      conjoinInheritedToolPolicies([...Array.from({ length: 160 }, () => original), incoming]),
    );
    const restored = parseInheritedToolPolicyV2(JSON.parse(encodedPolicy));
    expect(restored.clauses).toHaveLength(2);
    expect(restored.parameters.fileTools).toHaveLength(1);
    const allows = createInheritedToolPolicyMatcher({ policy: restored });
    expect(["read", "write", "release_deploy"].filter((name) => allows({ name }))).toEqual([
      "read",
    ]);
    incoming.clauses.push({ kind: "execution", allow: [""] });
    expect(() => conjoinInheritedToolPolicies([incoming])).toThrow();
  });

  it.each([
    {
      source: { policies: [{ allow: ["read", "write"], deny: ["release_*"] }] },
      target: { policies: [{ allow: ["read"], deny: ["release_*", "status_delete"] }] },
    },
    { source: { policies: [], runtimeAllow: ["*"] }, target: { policies: [], runtimeAllow: [] } },
    {
      source: { policies: [], runtimeAllow: ["read", "write"] },
      target: { policies: [], runtimeAllow: ["read"] },
    },
    {
      source: { policies: [{ allow: ["read"] }] },
      target: { policies: [], executionAllow: ["read"] },
    },
  ])("accepts proven narrower clauses without a tool inventory ($target)", ({ source, target }) => {
    expect(() =>
      assertInheritedToolPolicyCompatible({ source: capture(source), target: capture(target) }),
    ).not.toThrow();
  });

  it.each([
    { policy: { allow: ["late-plugin"] }, expected: ["status_read", "release_deploy"] },
    { policy: { deny: ["late-plugin"] }, expected: ["read"] },
  ])(
    "preserves $policy when a plugin first becomes available on the receiver",
    ({ policy, expected }) => {
      const encodedPolicy = JSON.stringify(capture({ policies: [policy] }));
      const saved = parseInheritedToolPolicyV2(JSON.parse(encodedPolicy));
      const tools = ["status_read", "release_deploy", "read"].map((name) => ({ name }));
      expect(
        applyToolPolicyPipeline({
          tools,
          toolMeta: (tool) => (tool.name === "read" ? undefined : { pluginId: "late-plugin" }),
          warn: () => undefined,
          steps: [{ label: "inherited", policy: undefined, inheritedActionPolicy: saved }],
        }).map((tool) => tool.name),
      ).toEqual(expected);
    },
  );

  it("does not mistake a configured core name for a closed receiver catalog", () => {
    const receiverPolicy = { allow: ["read"] };
    expect(
      applyToolPolicyPipeline({
        tools: [{ name: "release_deploy" }],
        toolMeta: () => ({ pluginId: "read" }),
        warn: () => undefined,
        steps: [{ label: "receiver", policy: receiverPolicy }],
      }).map((tool) => tool.name),
    ).toEqual(["release_deploy"]);
    expect(() =>
      assertInheritedToolPolicyCompatible({
        source: capture({ policies: [{ deny: ["release_deploy"] }] }),
        target: capture({ policies: [receiverPolicy] }),
      }),
    ).toThrow(/action restrictions/);
  });

  it("preserves hook conjunctions and late plugin membership through JSON and the receiver pipeline", () => {
    const inherited = capture({
      policies: [
        {
          allow: attachToolAllowlistIntersection([], [["group:plugins"], ["status_*"]]),
          deny: ["status_delete"],
        },
      ],
    });
    const encodedPolicy = JSON.stringify(inherited);
    const saved = parseInheritedToolPolicyV2(JSON.parse(encodedPolicy));
    const tools = ["status_read", "status_delete", "release_deploy", "read"].map((name) => ({
      name,
    }));
    expect(
      applyToolPolicyPipeline({
        tools,
        toolMeta: (tool) => (tool.name === "read" ? undefined : { pluginId: "deploy" }),
        warn: () => undefined,
        steps: [{ label: "inherited", policy: undefined, inheritedActionPolicy: saved }],
      }).map((tool) => tool.name),
    ).toEqual(["status_read"]);
  });

  it("distinguishes empty runtime caps from empty configured allows and exact execution from write aliases", () => {
    const configured = capture({ policies: [{ allow: [] }] });
    const runtime = capture({ policies: [], runtimeAllow: [] });
    const execution = capture({ policies: [], executionAllow: ["write"] });
    expect(createInheritedToolPolicyMatcher({ policy: configured })({ name: "read" })).toBe(true);
    expect(createInheritedToolPolicyMatcher({ policy: runtime })({ name: "read" })).toBe(false);
    expect(createInheritedToolPolicyMatcher({ policy: execution })({ name: "apply_patch" })).toBe(
      false,
    );
    expect(() =>
      assertInheritedToolPolicyCompatible({ source: runtime, target: configured }),
    ).toThrow(/action restrictions/);
    expect(() =>
      assertInheritedToolPolicyCompatible({ source: configured, target: runtime }),
    ).not.toThrow();
  });

  it.each([
    {
      source: { policies: [{ allow: ["read"] }] },
      target: { policies: [{ allow: ["read", "exec"] }, { allow: ["group:plugins"] }] },
    },
    {
      source: { policies: [{ allow: ["read"] }] },
      target: { policies: [{ allow: ["read", "exec"] }], restartSafe: true },
    },
    {
      source: { policies: [{ deny: ["progress_card"] }] },
      target: { policies: [{ allow: ["update_plan"] }] },
    },
    {
      source: { policies: [{ allow: ["write"] }], executionAllow: ["write"] },
      target: { policies: [{ allow: ["write"] }] },
    },
  ])(
    "does not infer compatibility from missing metadata or retired names ($target)",
    ({ source, target }) => {
      expect(() =>
        assertInheritedToolPolicyCompatible({ source: capture(source), target: capture(target) }),
      ).toThrow(/action restrictions/);
    },
  );

  it("accepts a narrower target while preserving nested and recovered source clauses", () => {
    const source = capture({
      policies: [{ deny: ["release_*"] }],
      runtimeAllow: ["read", "status_*", "sessions_spawn"],
    });
    const nested = capture({ policies: [{ deny: ["status_write"] }], inherited: source });
    const encodedPolicy = JSON.stringify(nested);
    const target = capture({
      policies: [{ allow: ["status_read"] }],
      inherited: parseInheritedToolPolicyV2(JSON.parse(encodedPolicy)),
    });
    expect(() => assertInheritedToolPolicyCompatible({ source, target })).not.toThrow();
    const allows = createInheritedToolPolicyMatcher({ policy: target });
    expect(allows({ name: "status_read" })).toBe(true);
    expect(allows({ name: "release_deploy" })).toBe(false);
    expect(allows({ name: "status_write" })).toBe(false);
  });
});

import { expect, expectTypeOf, it } from "vitest";
import type {
  EmbeddedRunAttemptParams as SdkAttempt,
  EmbeddedRunAttemptParamsV2 as SdkAttemptV2,
} from "../../../plugin-sdk/agent-harness-runtime.js";
import type { PluginRuntimeCore } from "../../../plugins/runtime/types-core.js";
import type { RunCliAgentParams } from "../../cli-runner/types.js";
import type { ResolvedToolPromptFinalizer, RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type RuntimeRun = Parameters<PluginRuntimeCore["agent"]["runEmbeddedAgent"]>[0];
type PublicParams =
  | RunEmbeddedAgentParams
  | EmbeddedRunAttemptParams
  | RuntimeRun
  | SdkAttempt
  | SdkAttemptV2
  | RunCliAgentParams;

// This existing consumer must compile without narrowing the callback result.
function consume(params: Pick<PublicParams, "prompt" | "finalizePromptForResolvedTools">) {
  return params
    .finalizePromptForResolvedTools?.({ prompt: params.prompt, messageToolAvailable: false })
    ?.trim();
}

it("preserves the public string-finalizer consumer contract", () => {
  expectTypeOf<ReturnType<ResolvedToolPromptFinalizer>>().toEqualTypeOf<string>();
  expectTypeOf<
    ReturnType<NonNullable<PublicParams["finalizePromptForResolvedTools"]>>
  >().toEqualTypeOf<string>();
  expect(
    consume({ prompt: " task ", finalizePromptForResolvedTools: ({ prompt }) => prompt }),
  ).toBe("task");
});

it("keeps the tool-context resolver out of every public parameter contract", () => {
  // Check each member, not keyof a union (which would hide a leak in just one path).
  expectTypeOf<
    Extract<"resolveRuntimeContextForTools", keyof RunEmbeddedAgentParams>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<"resolveRuntimeContextForTools", keyof EmbeddedRunAttemptParams>
  >().toEqualTypeOf<never>();
  expectTypeOf<Extract<"resolveRuntimeContextForTools", keyof RuntimeRun>>().toEqualTypeOf<never>();
  expectTypeOf<Extract<"resolveRuntimeContextForTools", keyof SdkAttempt>>().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<"resolveRuntimeContextForTools", keyof SdkAttemptV2>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<"resolveRuntimeContextForTools", keyof RunCliAgentParams>
  >().toEqualTypeOf<never>();
});

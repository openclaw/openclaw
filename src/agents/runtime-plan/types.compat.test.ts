import { describe, expectTypeOf, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { FailoverReason } from "../pi-embedded-helpers/types.js";
import type { PromptMode } from "../system-prompt.types.js";
import type {
  AgentRuntimeFailoverReason,
  AgentRuntimePromptMode,
  AgentRuntimeReplyPayload,
  AgentRuntimeThinkLevel,
} from "./types.js";

describe("AgentRuntimePlan structural type compatibility", () => {
  it("keeps copied scalar unions aligned with their source contracts", () => {
    expectTypeOf<AgentRuntimeThinkLevel>().toEqualTypeOf<ThinkLevel>();
    expectTypeOf<AgentRuntimeFailoverReason>().toEqualTypeOf<FailoverReason>();
    expectTypeOf<AgentRuntimePromptMode>().toEqualTypeOf<PromptMode>();
  });

  it("keeps reply payload shapes structurally compatible with the runtime leaf payload shape", () => {
    expectTypeOf<ReplyPayload>().toMatchTypeOf<AgentRuntimeReplyPayload>();
    expectTypeOf<AgentRuntimeReplyPayload>().toMatchTypeOf<ReplyPayload>();
  });
});

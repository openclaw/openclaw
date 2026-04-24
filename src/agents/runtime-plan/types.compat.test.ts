import { describe, expectTypeOf, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { FailoverReason } from "../pi-embedded-helpers/types.js";
import type {
  AgentRuntimeFailoverReason,
  AgentRuntimeReplyPayload,
  AgentRuntimeThinkLevel,
} from "./types.js";

describe("AgentRuntimePlan structural type compatibility", () => {
  it("keeps copied scalar unions aligned with their source contracts", () => {
    expectTypeOf<AgentRuntimeThinkLevel>().toEqualTypeOf<ThinkLevel>();
    expectTypeOf<AgentRuntimeFailoverReason>().toEqualTypeOf<FailoverReason>();
  });

  it("keeps real reply payloads assignable to the runtime leaf payload shape", () => {
    expectTypeOf<ReplyPayload>().toMatchTypeOf<AgentRuntimeReplyPayload>();
  });
});

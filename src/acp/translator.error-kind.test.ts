/** Tests Gateway errorKind to ACP stopReason mapping. */
import { describe, expect, it } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
} from "./translator.prompt-harness.test-support.js";

describe("acp translator errorKind mapping", () => {
  it("maps errorKind: refusal to stopReason: refusal", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "refusal",
        errorMessage: "I cannot fulfill this request.",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "refusal" });
  });

  it("maps errorKind: context_length to stopReason: max_tokens", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "context_length",
        errorMessage: "Context length exceeded",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
  });

  it("maps errorKind: timeout to a RequestError", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "timeout",
        errorMessage: "gateway timeout",
      }),
    );

    await expect(promptPromise).rejects.toSatisfy((err: any) => {
      return (
        err instanceof RequestError &&
        err.code === -32001 &&
        err.message === "gateway timeout" &&
        (err.data as any)?.errorKind === "timeout"
      );
    });
  });

  it("maps errorKind: rate_limit to a RequestError", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "rate_limit",
        errorMessage: "rate limit exceeded",
      }),
    );

    await expect(promptPromise).rejects.toSatisfy((err: any) => {
      return (
        err instanceof RequestError &&
        err.code === -32002 &&
        err.message === "rate limit exceeded" &&
        (err.data as any)?.errorKind === "rate_limit"
      );
    });
  });

  it("maps unknown errorKind to a RequestError", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "unknown",
        errorMessage: "something went wrong",
      }),
    );

    await expect(promptPromise).rejects.toSatisfy((err: any) => {
      return (
        err instanceof RequestError &&
        err.code === -32603 &&
        err.message === "something went wrong" &&
        (err.data as any)?.errorKind === "unknown"
      );
    });
  });
});

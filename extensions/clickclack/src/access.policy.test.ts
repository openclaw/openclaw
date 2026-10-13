import { beforeEach, expect, it } from "vitest";
import { resolveClickClackInboundAccess } from "./access.js";
import { resolveClickClackAccount } from "./accounts.js";
import { createInboundMessage, createInboundRuntime } from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type PolicyScope = "default" | "inherited" | "account";
const runtime = createInboundRuntime(false);
beforeEach(() => setClickClackRuntime(runtime));

function config(scope: PolicyScope, allowFrom: string[]): CoreConfig {
  const transport = {
    baseUrl: "https://clickclack.example",
    token: "synthetic-policy-token",
    workspace: "wsp_1",
    botUserId: "usr_receiver",
  };
  return {
    channels: {
      clickclack:
        scope === "default"
          ? { ...transport, allowFrom }
          : {
              ...transport,
              allowFrom: scope === "inherited" ? allowFrom : ["usr_other"],
              accounts: { support: scope === "account" ? { allowFrom } : {} },
            },
    },
  };
}

it.each(
  (["default", "inherited", "account"] as const).flatMap((scope) =>
    [false, true].flatMap((direct) => [false, true].map((allowed) => ({ scope, direct, allowed }))),
  ),
)(
  "prepares current sender admission: scope=$scope direct=$direct allowed=$allowed",
  async ({ scope, direct, allowed }) => {
    const previous = config(scope, allowed ? [] : ["usr_owner"]);
    const account = resolveClickClackAccount({
      cfg: previous,
      accountId: scope === "default" ? "default" : "support",
    });
    runtime.config.current = () => config(scope, allowed ? ["usr_owner"] : []);

    const access = await resolveClickClackInboundAccess({
      account,
      config: previous,
      message: createInboundMessage({
        body: "A synthetic policy check",
        ...(direct ? { channel_id: undefined, direct_conversation_id: "dcn_1" } : {}),
      }),
    });

    expect(access.shouldDispatch).toBe(allowed);
    expect(access.isSenderCurrent()).toBe(allowed);
  },
);

import { randomBytes, randomUUID } from "node:crypto";
import type { GatewayControlUiIngressFactoryV2 } from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { principalFactory } from "./grant-bindings.js";
import { RelayError } from "./protocol.js";
import type { RelayGrantAuthority, RelayState } from "./state.js";

type ConsentOptions = {
  relayUrl: string;
  request: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  revoke: (grantId: string) => Promise<unknown>;
  state: Pick<RelayState, "approveGrant" | "assertGrantCurrent">;
  scheduler: Pick<PluginServiceSchedulerV1, "now" | "signal">;
  controlUiIngress?: GatewayControlUiIngressFactoryV2;
  config: () => ReturnType<PluginRuntime["config"]["current"]>;
  requireReady: () => void;
};

export class RelayConsent {
  readonly #options: ConsentOptions;

  constructor(options: ConsentOptions) {
    this.#options = options;
  }

  async validateAuthority(
    authority: RelayGrantAuthority,
    assertCurrent: () => void,
  ): Promise<void> {
    assertCurrent();
    const config = this.#options.config();
    if (
      authority.principal.kind === "owner" &&
      (config.gateway?.roles || config.gateway?.auth?.mode === "trusted-proxy")
    ) {
      throw new RelayError(
        "unavailable",
        "This Gateway requires a person-bound grant. Sign in and pair again from the Connected apps tab.",
      );
    }
    const binding = await principalFactory(this.#options.controlUiIngress).bindPrincipal({
      audienceId: `consent:${randomUUID()}`,
      principal: authority.principal,
      operatorScopeCeiling: authority.ceiling,
      signal: this.#options.scheduler.signal,
      assertCurrent,
    });
    await binding.close();
    assertCurrent();
  }

  async describe(requestId: string, assertCurrent: () => void) {
    assertCurrent();
    const result = await this.#options.request("authorize.describe", { requestId });
    assertCurrent();
    if (
      !isRecord(result) ||
      (result.kind !== "oauth" && result.kind !== "link") ||
      typeof result.clientName !== "string" ||
      !result.clientName ||
      result.clientName.length > 2000 ||
      typeof result.redirectHost !== "string" ||
      !result.redirectHost ||
      result.redirectHost.length > 2000 ||
      typeof result.expiresAt !== "number" ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= this.#options.scheduler.now()
    ) {
      throw new RelayError(
        "not_found",
        "This connection request is invalid or expired. Start connecting again.",
      );
    }
    return {
      kind: result.kind,
      clientName: result.clientName,
      redirectHost: result.redirectHost,
      expiresAt: result.expiresAt,
      relayUrl: this.#options.relayUrl,
    };
  }

  #continueUrl(requestId: string): string {
    const url = new URL("/oauth/continue", this.#options.relayUrl);
    url.searchParams.set("request", requestId);
    return url.href;
  }

  async approve(requestId: string, authority: RelayGrantAuthority, assertCurrent: () => void) {
    const details = await this.describe(requestId, assertCurrent);
    await this.validateAuthority(authority, assertCurrent);
    const grantId = `gr_${randomBytes(32).toString("base64url")}`;
    const assertApprovalCurrent = () => {
      assertCurrent();
      this.#options.requireReady();
      if (this.#options.scheduler.now() >= details.expiresAt) {
        throw new RelayError(
          "not_found",
          "This connection request expired. Start connecting again.",
        );
      }
    };
    assertApprovalCurrent();
    await this.#options.state.approveGrant(
      {
        grantId,
        clientId: requestId,
        clientName: details.clientName,
        createdAt: this.#options.scheduler.now(),
        ...authority,
      },
      assertApprovalCurrent,
    );
    try {
      assertApprovalCurrent();
      await this.#options.request("authorize.approve", {
        requestId,
        grantId,
        principal: authority.principal.kind,
        principalLabel:
          authority.principalLabel ??
          (authority.principal.kind === "owner" ? "Gateway owner" : "Gateway user"),
        ceiling: authority.ceiling,
      });
      assertApprovalCurrent();
      this.#options.state.assertGrantCurrent(grantId);
    } catch (error) {
      // An uncertain approval must never leave a usable local grant behind.
      await this.#options.revoke(grantId);
      throw error;
    }
    return { continueUrl: this.#continueUrl(requestId) };
  }

  async deny(requestId: string, assertCurrent: () => void) {
    await this.describe(requestId, assertCurrent);
    assertCurrent();
    await this.#options.request("authorize.deny", { requestId });
    assertCurrent();
    return { continueUrl: this.#continueUrl(requestId) };
  }
}

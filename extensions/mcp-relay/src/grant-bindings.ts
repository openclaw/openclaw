import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV2,
  type GatewayIngressPrincipalBindingV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import { RelayError } from "./protocol.js";
import type { RelayState } from "./state.js";

export function isRetiredBindingError(error: unknown): error is GatewayControlUiIngressError {
  return (
    error instanceof GatewayControlUiIngressError &&
    (error.code === "closed" || error.code === "forbidden" || error.code === "unsupported-auth")
  );
}

/** The relay connection owns one principal resolution shared by each grant's UI and RPC. */
export class GrantBindings {
  readonly #bindings = new Map<string, Promise<GatewayIngressPrincipalBindingV1>>();
  constructor(
    readonly factory: GatewayControlUiIngressFactoryV2,
    readonly state: Pick<RelayState, "getGrant" | "assertGrantCurrent">,
    readonly signal: AbortSignal,
  ) {}

  async get(grantId: string): Promise<GatewayIngressPrincipalBindingV1> {
    this.signal.throwIfAborted();
    const grant = this.state.getGrant(grantId);
    if (!grant) {
      throw new RelayError(
        "grant_revoked",
        "This app was disconnected. Connect it again from Connected apps.",
      );
    }
    const existing = this.#bindings.get(grantId);
    if (existing) {
      return existing;
    }
    const pending = this.factory.bindPrincipal({
      audienceId: grantId,
      principal: grant.principal,
      operatorScopeCeiling: grant.ceiling,
      signal: this.signal,
      assertCurrent: () => {
        this.signal.throwIfAborted();
        this.state.assertGrantCurrent(grantId);
      },
    });
    this.#bindings.set(grantId, pending);
    void pending.catch(() => {
      if (this.#bindings.get(grantId) === pending) {
        this.#bindings.delete(grantId);
      }
    });
    return pending;
  }

  async revoke(grantId: string): Promise<void> {
    const pending = this.#bindings.get(grantId);
    this.#bindings.delete(grantId);
    await pending?.then(
      (binding) => binding.close(),
      () => undefined,
    );
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.#bindings.keys(), (id) => this.revoke(id)));
  }
}

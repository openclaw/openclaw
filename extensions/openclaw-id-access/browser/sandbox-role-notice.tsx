/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { roleText } from "./i18n.js";
import { roleName } from "./people-format.js";
import { unreadySandboxRoles } from "./people-roles.js";
import type { Role } from "./types.js";

/** The page's handoff of sandbox setup to the owner's agent, shared by every notice. */
export type SandboxSetup = {
  status: () => "idle" | "asking" | "asked" | "failed";
  ask: (roles: readonly Role[]) => void;
  checkAgain: () => void;
};

function reason(role: Role, locale: string): string {
  const readiness = role.defined ? role.sandbox : undefined;
  if (readiness?.ready !== false) {
    return "";
  }
  return readiness.reason === "engine_unavailable"
    ? roleText(locale, "sandboxEngineUnavailable", {
        engine: readiness.backend === "podman" ? "Podman" : "Docker",
      })
    : roleText(locale, "sandboxImageMissing");
}

/** Says which roles cannot be granted until their sandbox is set up, and offers to ask OpenClaw. */
export function SandboxRoleNotice(props: { roles: Role[]; locale: string; setup?: SandboxSetup }) {
  const unready = () => unreadySandboxRoles(props.roles);
  const status = () => props.setup?.status() ?? "idle";
  return (
    <Show when={unready().length > 0}>
      <div class="ocid-access__role-notice ocid-access__sandbox-notice" role="status">
        <div class="ocid-access__sandbox-text">
          <For each={unready()} keyed={(role) => role.name}>
            {(role) => (
              <p>
                <strong>
                  {roleText(props.locale, "sandboxNeeded", { role: roleName(role().name) })}
                </strong>{" "}
                {reason(role(), props.locale)}
              </p>
            )}
          </For>
          <Show when={props.setup}>
            <p class="ocid-access__hint">
              {roleText(props.locale, status() === "asked" ? "sandboxAsked" : "sandboxAskBody")}
            </p>
            <Show when={status() === "failed"}>
              <p class="ocid-access__hint">{roleText(props.locale, "sandboxAskFailed")}</p>
            </Show>
          </Show>
        </div>
        <Show when={props.setup}>
          {(setup) => (
            <Show
              when={status() === "asked"}
              fallback={
                <button
                  type="button"
                  class="btn primary btn--sm"
                  disabled={status() === "asking"}
                  aria-busy={status() === "asking" ? "true" : undefined}
                  onClick={() => setup().ask(unready())}
                >
                  {roleText(props.locale, "sandboxAsk")}
                </button>
              }
            >
              <button type="button" class="btn btn--sm" onClick={() => setup().checkAgain()}>
                {roleText(props.locale, "sandboxCheckAgain")}
              </button>
            </Show>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** @jsxImportSource @solidjs/web */
import { Show } from "solid-js";
import type { Link } from "./types.js";

export function InviteSandboxWarning(props: {
  role?: string;
  link?: Pick<Link, "roles" | "sandboxBackend">;
}) {
  return (
    <Show
      when={
        props.link?.sandboxBackend?.available === false &&
        props.link.roles?.some(
          (role) => role.name === props.role && role.defined && role.requiresSandbox,
        )
      }
    >
      <p class="ocid-access__hint" role="status">
        Members with this role cannot run anything until a sandbox backend is set up.{" "}
        <a href="https://docs.openclaw.ai/gateway/sandboxing" target="_blank" rel="noreferrer">
          Set up sandboxing
        </a>
      </p>
    </Show>
  );
}

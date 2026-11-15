/** @jsxImportSource @solidjs/web */
import { Portal } from "@solidjs/web";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, onSettled, Show } from "solid-js";
import type { CreatedNodeInvite } from "./nodes.js";
import type { NodeInvite } from "./types.js";

export type NodeDialogProps = {
  invite?: NodeInvite;
  error?: string;
  disabled: boolean;
  canCreate: boolean;
  onCreate: (label: string) => Promise<CreatedNodeInvite | undefined>;
  onCreated?: (invite: CreatedNodeInvite) => void;
  onDecide: (invite: NodeInvite, approve: boolean) => Promise<boolean | undefined>;
  onClose: () => void;
};

function sensitiveSurface(name: string) {
  return (
    name === "system.run" ||
    name === "browser.proxy" ||
    name.startsWith("fs.") ||
    name.includes("exec.approval") ||
    name.includes("execApproval") ||
    name.startsWith("system.execApprovals")
  );
}

/** Shared dialog body; all self-reported node fields render as text. */
function NodeDialogContent(props: NodeDialogProps) {
  const [label, setLabel] = createSignal("");
  const [created, setCreated] = createSignal<CreatedNodeInvite>();
  const [outcome, setOutcome] = createSignal<"approved" | "denied">();
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const [copyStatus, setCopyStatus] = createSignal("");
  let alive = true;
  onSettled(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  });
  const state = () =>
    outcome() ??
    (props.invite?.status === "open" && props.invite.expiresAt <= now()
      ? "expired"
      : props.invite?.status) ??
    (created() ? (created()!.expiresAt <= now() ? "expired" : "open") : "create");
  const remaining = () =>
    Math.max(0, (created()?.expiresAt ?? props.invite?.expiresAt ?? now()) - now());
  const countdown = () =>
    `${Math.floor(remaining() / 60)}:${String(remaining() % 60).padStart(2, "0")}`;
  const create = async () => {
    const result = await props.onCreate(label().trim());
    if (alive && result) {
      setCreated(result);
      props.onCreated?.(result);
    }
  };
  const decide = async (approve: boolean) => {
    const invite = props.invite;
    if (!invite) {
      return;
    }
    if (await props.onDecide(invite, approve)) {
      if (alive) {
        setOutcome(approve ? "approved" : "denied");
        setCreated(undefined);
      }
    }
  };
  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      if (alive) {
        setCopyStatus("Copied");
      }
    } catch {
      if (alive) {
        setCopyStatus("Could not copy. Select and copy the command above.");
      }
    }
  };
  return (
    <div class="exec-approval-card ocid-node-dialog">
      <div class="exec-approval-title">Add node</div>
      <Show when={props.error}>
        <p class="callout danger" role="alert">
          {props.error}
        </p>
      </Show>
      <Show when={state() === "create"}>
        <p class="ocid-access__hint">
          Connect a computer through OpenClaw ID. No Gateway token or Tailscale is needed.
        </p>
        <label class="stack">
          Node label
          <input
            class="settings-input"
            maxlength={128}
            autocomplete="off"
            value={label()}
            onInput={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <Show when={!props.canCreate}>
          <p class="callout info">The Gateway relay must be running before you can add a node.</p>
        </Show>
      </Show>
      <Show when={state() === "open"}>
        <Show
          when={created()?.commands}
          fallback={
            <p class="callout info">
              {created()
                ? "Configure the OpenClaw ID Discovery address on the Gateway first"
                : "Waiting for this node to join. The command is available only in the browser dialog that created it."}
            </p>
          }
        >
          {(commands) => (
            <>
              <p class="ocid-access__hint">
                Run this in a POSIX shell on the computer you want to add. It installs and starts
                the node service after approval.
              </p>
              <pre class="ocid-node-dialog__command">
                <code>{commands().command}</code>
              </pre>
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => void copy(commands().command)}
              >
                Copy command
              </button>
              <details>
                <summary>Already have OpenClaw installed?</summary>
                <pre class="ocid-node-dialog__command">
                  <code>{commands().installedCommand}</code>
                </pre>
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => void copy(commands().installedCommand)}
                >
                  Copy installed command
                </button>
              </details>
              <p class="ocid-access__hint">
                Keep this command private. The single-use link stays only in this dialog and expires
                in {countdown()}.
              </p>
            </>
          )}
        </Show>
        <Show when={!created() || created()?.commands}>
          <p role="status">Waiting for the node. You will compare a code and approve it here.</p>
        </Show>
        <Show when={copyStatus()}>
          <p role="status">{copyStatus()}</p>
        </Show>
      </Show>
      <Show when={state() === "pending" && props.invite?.pending} keyed>
        {(pending) => (
          <>
            <div class="ocid-access__title">
              {pending.description.display_name} · {pending.description.platform}
            </div>
            <p class="ocid-access__hint">
              Name and platform are self-reported. Review every command and capability before
              allowing access.
            </p>
            <div class="callout info">
              <strong class="ocid-node-dialog__code">
                {pending.verificationCode.slice(0, 3)}-{pending.verificationCode.slice(3)}
              </strong>
              <p>Compare all 6 digits with the node’s terminal. Approve only if they match.</p>
            </div>
            <For each={["commands", "caps"] as const}>
              {(kind) => (
                <section>
                  <h3>{kind === "commands" ? "Commands" : "Capabilities"}</h3>
                  <ul class="ocid-node-dialog__surface">
                    <For each={pending.description[kind]} fallback={<li>None declared</li>}>
                      {(name) => (
                        <li class={{ "callout danger": sensitiveSurface(name) }}>
                          <code>{name}</code>
                          {sensitiveSurface(name) ? " · Sensitive access" : ""}
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <p class="ocid-access__hint">
              Only this declared surface is approved. Execution policy and local approvals still
              apply; additional capabilities need separate approval.
            </p>
          </>
        )}
      </Show>
      <Show when={state() === "approved"}>
        <p class="callout success" role="status">
          Node approved. It can now connect to this claw.
        </p>
      </Show>
      <Show when={state() === "denied"}>
        <p class="callout info" role="status">
          Node denied. It has not been granted access. Ask the node operator to stop the waiting
          command.
        </p>
      </Show>
      <Show when={state() === "expired"}>
        <p class="callout info" role="status">
          This node invitation expired. Close this dialog and create a new invitation.
        </p>
      </Show>
      <openclaw-modal-actions class="exec-approval-actions">
        <button type="button" class="btn" onClick={() => props.onClose()}>
          Close
        </button>
        <Show when={state() === "create"}>
          <button
            type="button"
            class="btn primary"
            disabled={props.disabled || !props.canCreate || !label().trim()}
            onClick={() => void create()}
          >
            Create node command
          </button>
        </Show>
        <Show when={state() === "pending"}>
          <button
            type="button"
            class="btn danger"
            disabled={props.disabled}
            onClick={() => void decide(false)}
          >
            Deny node
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={props.disabled}
            onClick={() => void decide(true)}
          >
            Codes match — approve node
          </button>
        </Show>
      </openclaw-modal-actions>
    </div>
  );
}

/** The host owns the modal shell, focus and dismissal; the plugin owns its content. */
export function NodeDialog(
  props: NodeDialogProps & {
    host: { components: Pick<ControlUiHost["components"], "mountDialog"> };
  },
) {
  let container!: HTMLDivElement;
  const content = document.createElement("div");
  onSettled(() => {
    const dialog = props.host.components.mountDialog(container, {
      label: "Add node",
      content,
      onCancel: () => props.onClose(),
      style: "--openclaw-modal-width: 640px",
    });
    return () => {
      dialog.dispose();
    };
  });
  return (
    <>
      <Portal mount={content}>
        <NodeDialogContent {...props} />
      </Portal>
      <div
        ref={(element) => {
          container = element;
        }}
      />
    </>
  );
}

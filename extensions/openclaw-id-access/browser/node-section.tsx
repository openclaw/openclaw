/** @jsxImportSource @solidjs/web */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, Show } from "solid-js";
import { NodeDialog } from "./node-dialog.js";
import type { CreatedNodeInvite } from "./nodes.js";
import type { Link, NodeInvite, NodeRecord } from "./types.js";

function NodeRow(props: {
  node: NodeRecord;
  link: Link;
  locale: string;
  disabled: boolean;
  onRemove: (node: NodeRecord) => void;
}) {
  const [confirming, setConfirming] = createSignal(false);
  const addedBy = () =>
    props.node.addedBy === "root"
      ? "recovery kit"
      : (props.link.ownerDevices?.find((device) => device.deviceFp === props.node.addedBy)?.label ??
        "removed owner device");
  return (
    <li class="ocid-access__row">
      <div>
        <div class="ocid-access__title">{props.node.label}</div>
        <p class="ocid-access__hint">
          {props.node.description.display_name} · {props.node.description.platform}
        </p>
        <p class="ocid-access__hint">
          Last seen {new Date(props.node.lastSeen * 1000).toLocaleString(props.locale)} · Added by{" "}
          {addedBy()}
        </p>
        <Show when={confirming()}>
          <p role="note">
            Removing this node disconnects it and deletes its node pairing. It needs a new
            invitation to return.
          </p>
        </Show>
      </div>
      <div class="ocid-access__actions">
        <Show
          when={confirming()}
          fallback={
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.disabled}
              onClick={() => setConfirming(true)}
            >
              Remove node
            </button>
          }
        >
          <button type="button" class="btn btn--sm" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn--sm danger"
            disabled={props.disabled}
            onClick={() => props.onRemove(props.node)}
          >
            Remove {props.node.label}
          </button>
        </Show>
      </div>
    </li>
  );
}

export function NodeSection(props: {
  host: ControlUiHost;
  link: Link;
  disabled: boolean;
  canCreate: boolean;
  error?: string;
  onCreate: (label: string) => Promise<CreatedNodeInvite | undefined>;
  onDecide: (invite: NodeInvite, approve: boolean) => Promise<boolean | undefined>;
  onRemove: (node: NodeRecord) => void;
}) {
  const [selected, setSelected] = createSignal<string>();
  const selectedInvite = () =>
    props.link.nodeInvites?.find((invite) => invite.inviteId === selected());
  return (
    <section class="ocid-access__section" aria-labelledby="ocid-nodes">
      <div class="ocid-access__header">
        <h2 id="ocid-nodes">Nodes</h2>
        <button
          type="button"
          class="btn primary btn--sm"
          disabled={props.disabled}
          onClick={() => setSelected("new")}
        >
          Add node
        </button>
      </div>
      <p class="ocid-access__hint">
        Computers connected through OpenClaw ID. Removing only their pairing in Devices makes the
        next pairing manual; it does not remove OpenClaw ID access.
      </p>
      <ul class="ocid-access__list">
        <For
          each={props.link.nodes ?? []}
          keyed={(node) => node.peerKey}
          fallback={<li class="ocid-access__row ocid-access__empty">No nodes added yet.</li>}
        >
          {(node) => (
            <NodeRow
              node={node()}
              link={props.link}
              locale={props.host.locale}
              disabled={props.disabled}
              onRemove={props.onRemove}
            />
          )}
        </For>
        <For
          each={(props.link.nodeInvites ?? []).filter(
            (invite) => invite.status === "pending" || invite.status === "open",
          )}
          keyed={(invite) => invite.inviteId}
        >
          {(invite) => (
            <li class="ocid-access__row">
              <div>
                <strong>{invite().label}</strong>
                <p class="ocid-access__hint">
                  {invite().status === "pending"
                    ? "Waiting for your approval"
                    : "Invitation waiting for a node"}
                </p>
              </div>
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.disabled}
                onClick={() => setSelected(invite().inviteId)}
              >
                Review node
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={selected()}>
        <NodeDialog
          error={props.error}
          host={props.host}
          invite={selectedInvite()}
          disabled={props.disabled}
          canCreate={props.canCreate}
          onCreate={props.onCreate}
          onCreated={(made) => setSelected(made.inviteId)}
          onDecide={props.onDecide}
          onClose={() => setSelected(undefined)}
        />
      </Show>
    </section>
  );
}

/** @jsxImportSource @solidjs/web */
import { createMemo, createSignal, For, latest, Show } from "solid-js";
import {
  countDevices,
  deviceApprover,
  memberDeviceRemovalCount,
  memberName,
  memberPresence,
} from "./people-format.js";
import type { PeopleMotion } from "./people-motion.js";
import type { Member, MemberDevice, OwnerDevice } from "./types.js";

type MemberDevicesProps = {
  member: Member;
  ownerDevices: OwnerDevice[];
  motion: PeopleMotion;
  disabled: boolean;
  readOnly?: boolean;
  nowMs: number;
  onRemove: (member: Member, device: MemberDevice) => void;
};

function DeviceRow(props: MemberDevicesProps & { device: MemberDevice }) {
  const [confirming, setConfirming] = createSignal(false);
  const removalCount = createMemo(() =>
    memberDeviceRemovalCount(props.member.devices ?? [], props.device),
  );
  return (
    <li class="ocid-access__device">
      <div class="ocid-access__device-info">
        <div class="ocid-access__title">{props.device.label}</div>
        <p class="ocid-access__hint">
          {deviceApprover(props.device, props.member.devices ?? [], props.ownerDevices)}
        </p>
        <p class="ocid-access__hint">{memberPresence([props.device], props.nowMs)}</p>
      </div>
      <Show when={!props.readOnly && !latest(confirming)}>
        <button
          type="button"
          class="btn btn--sm"
          disabled={props.disabled}
          onClick={() => props.motion.update(() => setConfirming(true))}
        >
          Remove device
        </button>
      </Show>
      <Show when={latest(confirming) && !props.readOnly}>
        <div class="ocid-access__confirmation">
          <div role="note">
            <p>
              {removalCount() === 1
                ? "1 device will be removed."
                : `${countDevices(removalCount())} will be removed: this device and ${countDevices(removalCount() - 1)} it approved, directly or indirectly.`}
            </p>
            <p class="ocid-access__hint">
              Removed devices disconnect now, and their running tasks stop. Completed work and
              conversations stay here.
            </p>
          </div>
          <div class="ocid-access__actions">
            <button
              type="button"
              class="btn btn--sm"
              disabled={props.disabled}
              onClick={() => props.motion.update(() => setConfirming(false))}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--sm danger"
              disabled={props.disabled}
              onClick={() => props.onRemove(props.member, props.device)}
            >
              Remove {props.device.label}
            </button>
          </div>
        </div>
      </Show>
    </li>
  );
}

/** Device details stay with their member; the page owns the signed removal. */
export function MemberDevices(props: MemberDevicesProps) {
  return (
    <Show when={props.member.devices?.length}>
      <ul class="ocid-access__devices" aria-label={`${memberName(props.member)}'s devices`}>
        <For each={props.member.devices} keyed={(device) => device.peerKey}>
          {(device) => <DeviceRow {...props} device={device()} />}
        </For>
      </ul>
    </Show>
  );
}

/** @jsxImportSource @solidjs/web */
import type { MemberRole } from "@openclaw/openclaw-id-protocol";
import type { ControlUiComponentHandle, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createEffect, onSettled } from "solid-js";
import { roleText } from "./i18n.js";
import { grantableRoles, roleOptions } from "./people-roles.js";
import type { Role } from "./types.js";

type RolePickerProps = Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1];
// The host picker owns listbox navigation, dismissal, and focus restoration.
export function RolePicker(props: {
  components: ControlUiHost["components"];
  role: MemberRole;
  roles: Role[];
  locale: string;
  disabled: boolean;
  onSelect: (role: MemberRole) => void;
}) {
  let container!: HTMLDivElement;
  let handle: ControlUiComponentHandle<RolePickerProps> | undefined;
  createEffect(
    () => ({
      options: roleOptions(props.roles, props.locale),
      value: props.role,
      accessibleLabel: roleText(props.locale, "role"),
      searchable: false,
      disabled: props.disabled,
      onSelect: (value: string) => {
        if (grantableRoles(props.roles).some((role) => role.name === value)) {
          props.onSelect(value);
        }
      },
    }),
    (value) => {
      if (handle) {
        handle.update(value);
      } else {
        handle = props.components.mountSelectPicker(container, value);
      }
    },
  );
  onSettled(() => () => handle?.dispose());
  return <div class="ocid-access__role-picker" ref={(element) => (container = element)} />;
}

import { isMemberRole } from "@openclaw/openclaw-id-protocol";
import { roleText } from "./i18n.js";
import { roleName } from "./people-format.js";
import type { Role } from "./types.js";

function sortedRoles(roles: Role[]): Array<Extract<Role, { defined: true }>> {
  return roles
    .filter((role) => role.defined)
    .toSorted((a, b) =>
      a.name === "operator"
        ? -1
        : b.name === "operator"
          ? 1
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0,
    );
}

export function definedRoles(roles: Role[]) {
  return sortedRoles(roles).filter((role) => isMemberRole(role.name));
}

export function administratorWarning(role: string | undefined, locale: string) {
  return roleText(locale, "adminConfirm", { role: roleName(role ?? "") });
}

export function roleOptions(roles: Role[], locale: string) {
  return sortedRoles(roles).map((role) => ({
    value: role.name,
    disabled: !isMemberRole(role.name),
    label: role.admin
      ? `${roleName(role.name)} · ${roleText(locale, "administrator")}`
      : roleName(role.name),
    description: !isMemberRole(role.name)
      ? roleText(locale, "invalidRoleName")
      : [
          roleText(locale, `sessions.${role.sessions}`),
          roleText(locale, role.requiresSandbox ? "sandboxRequired" : "sandboxInherited"),
          roleText(locale, role.admin ? "administrator" : "noAdministrator"),
        ].join(" · "),
  }));
}

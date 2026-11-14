const en = {
  role: "Role",
  administrator: "Administrator access",
  noAdministrator: "No administrator access",
  sessions: {
    none: "No access to other people's sessions",
    view: "Read other people's sessions",
    suggest: "Read and suggest changes to other people's sessions",
    write: "Read and change other people's sessions",
  },
  sandboxRequired: "Sandbox required",
  sandboxInherited: "Sandbox follows agent settings",
  noRoles:
    "No roles are defined on this claw. Add a role in gateway.roles.definitions before inviting someone.",
  invalidRoleName:
    "Unavailable for members: use 1–64 lowercase letters, digits, - or _, starting with a letter. Rename this role in config.",
  noUsableRoles:
    "No roles have a valid member role name. Use 1–64 lowercase letters, digits, - or _, starting with a letter, in gateway.roles.definitions.",
  adminConfirm:
    "The {role} role has administrator access. Administrators can change Gateway settings, manage devices and approvals, and access connected services. Only invite someone you trust with this claw.",
  adminInvite: "Confirm administrator invite",
  cancel: "Cancel",
  changeRole: "Change role",
  saveRole: "Save role",
  saveAdminRole: "Confirm administrator role",
  roleChanged: "Role changed. Their devices reconnect with the new access.",
  blocked: "Blocked",
  undefinedRole:
    "The role {role} is not defined on this claw. Choose another role to restore access.",
  yourRole: "Your role: {role}",
};

export default en;
